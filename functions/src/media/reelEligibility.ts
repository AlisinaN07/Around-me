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
 *
 * Imports mediaUploadValidation.ts's own content-type SETS (not the
 * reverse) — this file stays the one place that knows "is this content
 * type consistent with THIS Reel's own current shape," since only this
 * file ever has both the real Reel document and (as of Step 9C) the
 * requested content type in hand at once.
 */
import { ALLOWED_REEL_PHOTO_CONTENT_TYPES, ALLOWED_VIDEO_CONTENT_TYPES } from './mediaUploadValidation';

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
 * Step 9A/9B/9C — the STRICTEST eligibility check in this file, for
 * exactly the reason Step 9A's own migration-scope decision exists: a
 * Reel's source can be rewritten IN PLACE, server-side, by two other
 * trusted Cloud Functions — muxReelMusic (merges picked device music
 * into an existing video) and renderPhotoToVideo (renders a photo +
 * music into a real video). BOTH became provider-aware (Step 9B and
 * 9C respectively, see reelMuxOrchestration.ts) — a Reel either one will
 * touch no longer needs to be excluded from R2 purely because a
 * server-side rewrite is still scheduled; it only needs to be excluded
 * from PUBLISHING before that rewrite actually runs (a separate concern,
 * unaffected by this check — see isValidReelPublish in firestore.rules,
 * which independently still requires `musicHash`/`needsPhotoVideoRender`
 * etc. to already be their trusted post-render values by publish time).
 *
 *  1. Reel exists, `authorUid === uid`, `status === 'uploading'` — same
 *     as every other check in this file.
 *  2. `mediaType` must be `'video'` or `'photo'` — the only two real
 *     Reel media kinds; anything else is rejected outright.
 *  3. For `mediaType === 'video'`: `musicSourceType` must be a value
 *     this codebase actually knows how to bring to R2 — `'none'`
 *     (nothing to mux) or `'device'` (Step 9B — mux runs provider-aware
 *     before publish), with a required, non-empty `musicStorageAudioPath`
 *     for the latter (defense-in-depth against an inconsistent
 *     document). An allowlist, not a blocklist — a hypothetical future
 *     music source type is rejected by default.
 *  4. For `mediaType === 'photo'`: no music/render constraint applies at
 *     all — a plain photo Reel is never render-pending by definition
 *     (see ReelMediaType's own doc comment in src/types/reel.ts).
 *  5. `contentType` — Step 9C's own new parameter — must match what
 *     THIS Reel is actually expecting RIGHT NOW: an image type
 *     (ALLOWED_REEL_PHOTO_CONTENT_TYPES) whenever the upload about to
 *     happen is still a photo (`mediaType === 'photo'`, OR
 *     `mediaType === 'video' && needsPhotoVideoRender === true` — a
 *     photo-pending-render Reel's `storagePath` still holds the
 *     ORIGINAL PHOTO until renderPhotoToVideo overwrites it — see that
 *     function's own doc comment in functions/src/index.ts), or a video
 *     type (ALLOWED_VIDEO_CONTENT_TYPES) otherwise. This is the ONE
 *     check in this file that reads BOTH the Reel's own state AND the
 *     request's own declared content type together — mediaUploadValidation.ts's
 *     own pure shape check (run earlier, with no Firestore access) can
 *     only confirm SOME allowed shape was sent, never that it's the
 *     RIGHT one for this exact Reel.
 *
 * Every Reel variant this function now accepts has its source's only
 * scheduled server-side transformation (if any) fully accounted for by a
 * provider-aware trusted function (muxReelMusic or renderPhotoToVideo) —
 * that's what makes moving all of them to R2 safe.
 */
export function checkReelVideoEligibility(reel: RawReelData | null, uid: string, contentType: string): EligibilityResult {
  if (!reel) return notFound();
  if (reel.authorUid !== uid) return permissionDenied('You do not own this Reel.');
  if (reel.status !== 'uploading') return failedPrecondition('This Reel is not awaiting a video upload.');
  if (reel.mediaType !== 'video' && reel.mediaType !== 'photo') {
    return failedPrecondition('This Reel does not have a separate video source.');
  }
  if (reel.mediaType === 'video') {
    if (reel.musicSourceType !== 'none' && reel.musicSourceType !== 'device') {
      return failedPrecondition('This Reel has an unsupported music state.');
    }
    if (reel.musicSourceType === 'device' && (typeof reel.musicStorageAudioPath !== 'string' || reel.musicStorageAudioPath.length === 0)) {
      return failedPrecondition('This Reel has an unsupported music state.');
    }
  }
  const isImageUploadExpected = reel.mediaType === 'photo' || reel.needsPhotoVideoRender === true;
  const contentTypeMatches = isImageUploadExpected
    ? ALLOWED_REEL_PHOTO_CONTENT_TYPES.has(contentType)
    : ALLOWED_VIDEO_CONTENT_TYPES.has(contentType);
  if (!contentTypeMatches) {
    return failedPrecondition('This file type does not match what this post is expecting.');
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
 * Step 9C — renderPhotoToVideo's own eligibility check, extracted from
 * that function's pre-existing inline checks the same way Step 9B
 * extracted checkReelMuxEligibility from muxReelMusic's — same shape,
 * different trigger condition:
 *  1. Reel exists, `authorUid === uid`, `status === 'uploading'` — same
 *     as every other check in this file.
 *  2. `mediaType === 'video' && needsPhotoVideoRender === true` — the
 *     ONE Reel variant this function is ever meant to touch (a plain
 *     photo Reel, `mediaType === 'photo'`, is NEVER render-pending — see
 *     checkReelVideoEligibility's own doc comment above).
 *  3. `musicSourceType === 'device'` with a real, non-empty
 *     `musicStorageAudioPath` — a render-pending Reel always has device
 *     music by construction (see CreateReelDraftInput.photoRenderPending's
 *     own doc comment in src/services/reels.ts: this render mode only
 *     ever exists BECAUSE the user picked device music for a photo), but
 *     this check costs nothing and never trusts that invariant blindly,
 *     same reasoning as checkReelMuxEligibility's own third check.
 *
 * Deliberately does NOT gate on `reel.storageProvider` at all — same
 * reasoning as checkReelMuxEligibility: the provider only decides WHICH
 * download/upload path performReelMux takes, never whether rendering is
 * allowed to run.
 */
export function checkReelPhotoRenderEligibility(reel: RawReelData | null, uid: string): EligibilityResult {
  if (!reel) return notFound();
  if (reel.authorUid !== uid) return permissionDenied('You can only process your own post.');
  if (reel.status !== 'uploading') return failedPrecondition('This post is not awaiting photo processing.');
  if (reel.mediaType !== 'video' || reel.needsPhotoVideoRender !== true) {
    return failedPrecondition('This post does not need photo-to-video rendering.');
  }
  if (reel.musicSourceType !== 'device') {
    return failedPrecondition('This post has no music to render with.');
  }
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
