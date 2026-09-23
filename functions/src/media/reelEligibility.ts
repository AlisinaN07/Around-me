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
 * Step 9A — the STRICTEST eligibility check in this file, for exactly the
 * reason Step 9A's own migration-scope decision exists: a Reel's video
 * source can be rewritten IN PLACE, server-side, by two other trusted
 * Cloud Functions — muxReelMusic (merges picked device music into the
 * video) and renderPhotoToVideo (renders a "FOTO"-with-music photo into a
 * real video) — both of which download `reel.storagePath` directly from
 * Firebase Storage via the Admin SDK and know nothing about R2. If either
 * of those could ever run against an R2-backed source, they would
 * silently fail (the object simply isn't in the Firebase bucket) or,
 * worse, leave the Reel in a broken half-migrated state. So this
 * EXCLUDES exactly the Reel variants those two functions still own:
 *
 *  1. Same four checks as checkReelThumbnailEligibility above (exists,
 *     owned, uploading, mediaType video).
 *  2. `musicSourceType === 'none'` — a Reel with picked device music
 *     always goes through muxReelMusic before publish; authorizing an R2
 *     source upload for one would let that function try to download an
 *     object that was never written to Firebase at all.
 *  3. `needsPhotoVideoRender !== true` — a "FOTO"-with-music draft's
 *     `storagePath` still holds the ORIGINAL PHOTO until
 *     renderPhotoToVideo overwrites it with a real rendered video; same
 *     reasoning as (2).
 *
 * A plain video Reel with no music and no pending render has NO
 * server-side source transformation scheduled before publish at all —
 * nothing else in this codebase ever touches its `storagePath` object
 * between this upload and playback, which is exactly what makes it safe
 * to move to R2.
 */
export function checkReelVideoEligibility(reel: RawReelData | null, uid: string): EligibilityResult {
  if (!reel) return notFound();
  if (reel.authorUid !== uid) return permissionDenied('You do not own this Reel.');
  if (reel.status !== 'uploading') return failedPrecondition('This Reel is not awaiting a video upload.');
  if (reel.mediaType !== 'video') return failedPrecondition('This Reel does not have a separate video source.');
  if (reel.musicSourceType !== 'none') {
    return failedPrecondition('This Reel still needs server-side music processing before its source can move.');
  }
  if (reel.needsPhotoVideoRender === true) {
    return failedPrecondition('This Reel still needs server-side photo rendering before its source can move.');
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
