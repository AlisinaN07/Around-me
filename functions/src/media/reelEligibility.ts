/**
 * Pure, dependency-free eligibility checks for the three Reel-media
 * operations that need a real Firestore ownership/status read before
 * they can proceed: authorizing an R2 thumbnail upload, authorizing an
 * R2 video-source upload, and discarding a draft's R2 media. Deliberately
 * its own file with ZERO firebase-functions/firebase-admin import — same
 * reasoning as mediaUploadValidation.ts/objectKey.ts: the actual
 * Firestore READ that produces the `reel` object passed in here can only
 * happen in a real callable (requestMediaUploadAuthorization.ts,
 * discardReelSource.ts), but the DECISION logic — given a Reel's data and
 * the caller's uid, is this operation allowed? — is pure, synchronous,
 * and has no reason to be untestable just because its caller isn't.
 *
 * Each function returns a plain `EligibilityResult` rather than throwing
 * — the caller (a real callable) is responsible for translating a
 * `{ok:false}` result into a real `HttpsError` with the matching `code`.
 * This mirrors mediaUploadValidation.ts's MediaUploadValidationError
 * pattern: keep the pure logic free of any HttpsError dependency.
 */

/** Mirrors the subset of `firebase-functions/v2/https`'s HttpsError codes these checks ever produce — kept as a plain string union here so this file needs no import from that package. */
export type ReelEligibilityErrorCode = 'not-found' | 'permission-denied' | 'failed-precondition';

export type EligibilityResult = { ok: true } | { ok: false; code: ReelEligibilityErrorCode; message: string };

/** The untyped Firestore document shape every check here reads from — deliberately loose (`Record<string, unknown>`), matching how `snapshot.data()` actually comes back from the Admin SDK with no static guarantee of its real shape. */
export type RawReelData = Record<string, unknown>;

function notFound(message = 'This Reel could not be found.'): EligibilityResult {
  return { ok: false, code: 'not-found', message };
}
function permissionDenied(message: string): EligibilityResult {
  return { ok: false, code: 'permission-denied', message };
}
function failedPrecondition(message: string): EligibilityResult {
  return { ok: false, code: 'failed-precondition', message };
}
const OK: EligibilityResult = { ok: true };

/**
 * Reel thumbnails are the first media kind requestMediaUploadAuthorization
 * authorizes for an object that already has a REAL Firestore document
 * behind it — so unlike eventCover's bare "any string under your own uid"
 * trust model, this requires an actual ownership/status read to verify:
 *  1. The Reel document exists at all (a made-up/foreign reelId is
 *     rejected, not silently authorized against a path that happens to
 *     parse).
 *  2. `authorUid === uid` — never authorize a thumbnail upload into
 *     another user's Reel, no matter what reelId is passed.
 *  3. `status === 'uploading'` — mirrors the one narrow window
 *     firestore.rules' own isValidReelThumbnailProviderUpdate will also
 *     require for the follow-up confirm-write: a published or
 *     already-discarded Reel can never have its thumbnail re-authorized.
 *  4. `mediaType === 'video'` — a photo Reel has no separate thumbnail
 *     object at all (its thumbnailStoragePath IS its own storagePath —
 *     see reels.ts's createReelDraft), so authorizing an R2 thumbnail
 *     upload for one would silently create an orphaned object nothing
 *     ever references, not migrate anything real.
 *
 * `existsOverride` lets a caller that already knows the document doesn't
 * exist (e.g. `!snapshot.exists`) skip straight to the not-found result
 * without needing to fabricate a fake `reel` object — pass `reel: null`
 * in that case.
 */
export function checkReelThumbnailEligibility(reel: RawReelData | null, uid: string): EligibilityResult {
  if (!reel) return notFound();
  if (reel.authorUid !== uid) return permissionDenied('You do not own this Reel.');
  if (reel.status !== 'uploading') return failedPrecondition('This Reel is not awaiting a thumbnail upload.');
  if (reel.mediaType !== 'video') return failedPrecondition('This Reel does not use a separate thumbnail.');
  return OK;
}

/**
 * Step 9A/9B — the STRICTEST eligibility check in this file, for exactly
 * the reason Step 9A's own migration-scope decision exists: a Reel's
 * video source can be rewritten IN PLACE, server-side, by two other
 * trusted Cloud Functions — muxReelMusic (merges picked device music into
 * the video) and renderPhotoToVideo (renders a "FOTO"-with-music photo
 * into a real video). renderPhotoToVideo is STILL entirely
 * Firebase-Storage-only (out of scope for Step 9B, deliberately) — a
 * Reel it would ever touch must still be excluded here. muxReelMusic,
 * however, became provider-aware in Step 9B (see
 * reelMuxOrchestration.ts) — it can now read/replace a Reel's source on
 * EITHER backend, so a Reel with picked device music no longer needs to
 * be excluded from R2 purely because mux will touch it; it only needs to
 * be excluded from PUBLISHING before mux actually runs (a separate
 * concern, unaffected by this check — see isValidReelPublish in
 * firestore.rules, which independently still requires `musicHash` etc.
 * to already be their trusted post-mux values by publish time, exactly
 * as before this step).
 *
 *  1. Same four checks as checkReelThumbnailEligibility above (exists,
 *     owned, uploading, mediaType video).
 *  2. `musicSourceType` must be a value this codebase actually knows how
 *     to bring to R2 — currently `'none'` (nothing to mux, immutable
 *     after upload) or `'device'` (Step 9B's own new case — mux runs
 *     server-side, provider-aware, before publish). Any OTHER value
 *     (there is none today, but this is deliberately an allowlist, not a
 *     blocklist, so a hypothetical future music source type is rejected
 *     by default rather than silently accepted) is rejected.
 *  3. For `musicSourceType === 'device'` specifically, also require a
 *     real, non-empty `musicStorageAudioPath` — defense-in-depth against
 *     an inconsistent document (createReelDraft's own Firestore Rules
 *     already guarantee this can't happen from a legitimate client
 *     write, but this check costs nothing and never trusts that
 *     invariant blindly).
 *  4. `needsPhotoVideoRender !== true` — a "FOTO"-with-music draft's
 *     `storagePath` still holds the ORIGINAL PHOTO until
 *     renderPhotoToVideo overwrites it with a real rendered video, and
 *     that function stays Firebase-only in Step 9B — this Reel variant
 *     is excluded regardless of `musicSourceType`.
 *
 * A plain video Reel with no music, and a video Reel with device-picked
 * music (Step 9B), both have their source's only scheduled server-side
 * transformation (if any) fully accounted for by muxReelMusic, which now
 * knows how to operate on either backend — that's what makes both safe
 * to move to R2. A render-pending Reel does not.
 */
export function checkReelVideoEligibility(reel: RawReelData | null, uid: string): EligibilityResult {
  if (!reel) return notFound();
  if (reel.authorUid !== uid) return permissionDenied('You do not own this Reel.');
  if (reel.status !== 'uploading') return failedPrecondition('This Reel is not awaiting a video upload.');
  if (reel.mediaType !== 'video') return failedPrecondition('This Reel does not have a separate video source.');
  if (reel.musicSourceType !== 'none' && reel.musicSourceType !== 'device') {
    return failedPrecondition('This Reel has an unsupported music state.');
  }
  if (reel.musicSourceType === 'device' && (typeof reel.musicStorageAudioPath !== 'string' || reel.musicStorageAudioPath.length === 0)) {
    return failedPrecondition('This Reel has an unsupported music state.');
  }
  if (reel.needsPhotoVideoRender === true) {
    return failedPrecondition('This Reel still needs server-side photo rendering before its source can move.');
  }
  return OK;
}

/**
 * Step 9B — muxReelMusic's own eligibility check, extracted the same way
 * as the three functions above (pure decision, real Firestore read stays
 * in the caller). Requires exactly what the ORIGINAL, pre-Step-9B inline
 * checks already required (ownership, `status === 'uploading'`,
 * `musicSourceType === 'device'`), plus one new defense-in-depth check —
 * a real, non-empty `musicStorageAudioPath` — covering "reject
 * inconsistent states" per the Step 9B spec: a Reel that somehow claims
 * `musicSourceType === 'device'` with no actual music path recorded is
 * rejected here rather than reaching ffmpeg with a bogus/missing input.
 *
 * Deliberately does NOT gate on `reel.storageProvider` at all — mux is
 * meant to run against EITHER backend (that's the whole point of Step
 * 9B); the provider itself only decides WHICH download/upload path
 * performReelMux takes, never whether mux is allowed to run.
 */
export function checkReelMuxEligibility(reel: RawReelData | null, uid: string): EligibilityResult {
  if (!reel) return notFound();
  if (reel.authorUid !== uid) return permissionDenied('You can only merge music into your own post.');
  if (reel.status !== 'uploading') return failedPrecondition('This post is not awaiting a music merge.');
  if (reel.musicSourceType !== 'device') return failedPrecondition('This post has no music to merge.');
  if (typeof reel.musicStorageAudioPath !== 'string' || reel.musicStorageAudioPath.length === 0) {
    return failedPrecondition('This post is missing its music file.');
  }
  return OK;
}

/**
 * discardReelSource.ts's own eligibility check — deliberately LOOSER than
 * checkReelVideoEligibility above in one respect (no mediaType/
 * musicSourceType/needsPhotoVideoRender constraint at all): discarding is
 * about cleaning up whatever R2 objects a draft actually recorded
 * (`reel.storageProvider`/`reel.thumbnailStorageProvider`, checked
 * separately by the caller after this passes), not about deciding
 * whether a NEW upload should be allowed. A photo Reel, a music Reel, or
 * a render-pending Reel can all be discarded same as any other — the
 * only real constraints are ownership and "still uploading" (mirroring
 * storage.rules' own Reel-source `allow delete` condition exactly: a
 * published Reel's media is never removed this way).
 */
export function checkReelDiscardEligibility(reel: RawReelData | null, uid: string): EligibilityResult {
  if (!reel) return notFound();
  if (reel.authorUid !== uid) return permissionDenied('You do not own this Reel.');
  if (reel.status !== 'uploading') return failedPrecondition('Only a still-uploading Reel can be discarded.');
  return OK;
}
