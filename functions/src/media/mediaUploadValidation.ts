/**
 * Pure, dependency-free input validation for requestMediaUploadAuthorization
 * — deliberately its own file with ZERO firebase-functions/firebase-admin
 * import (not even transitively), for the same reason objectKey.ts is
 * kept pure: `firebase-functions/v2/https` pulls in `firebase-admin`'s
 * auth module, which pulls in `jwks-rsa` -> `jose` (a pure-ESM package) —
 * under this project's plain-Node test-runner setup that chain fails to
 * `require()` (confirmed empirically; the same reason
 * test-collaborative-logic.cjs already reports this exact limitation for
 * collaborative.ts). Keeping validation logic here, with no such import
 * at all, is what makes it directly unit-testable — see
 * functions/scripts/test-media-upload-validation-logic.cjs.
 *
 * requestMediaUploadAuthorization.ts imports this and wraps
 * MediaUploadValidationError into a real HttpsError('invalid-argument',
 * ...) — this file itself never touches firebase-functions, so it can't
 * throw an HttpsError directly. Real ownership/draft-status verification
 * for 'reelThumbnail'/'reelVideo' (a real Firestore read) can't live here
 * either — that stays in requestMediaUploadAuthorization.ts's own
 * handleRequest, right after this pure shape validation passes.
 */
import { isSafePathSegment } from './objectKey';

/** The only media kinds this callable supports — Step 5A added 'profilePhoto', Step 5C added 'profileCover', Step 5D added 'eventCover', Step 5E added 'reelThumbnail', Step 9A adds 'reelVideo', Step 10A adds 'storyMedia', Step 10B adds 'reelMusic'. Any other value (a made-up future kind) is rejected. */
export type AllowedMediaKind = 'profilePhoto' | 'profileCover' | 'eventCover' | 'reelThumbnail' | 'reelVideo' | 'storyMedia' | 'reelMusic';

/** Narrowly restricted to formats the app's existing image-upload flows actually produce — no video/*, no application/*, no arbitrary MIME type. Same set for every IMAGE media kind, including reelThumbnail: every real thumbnail-generation code path observed (src/utils/reelThumbnailCandidates.ts's expo-video-thumbnails output, and camera.tsx's own SaveFormat.JPEG render for a "FOTO" cover) only ever produces JPEG, but this allowlist is kept at the same 3-format set used elsewhere rather than narrowed to jpeg-only, since narrowing further without being certain every code path is JPEG-only would risk silently breaking a legitimate upload. Never used for 'reelVideo' — see ALLOWED_VIDEO_CONTENT_TYPES below for that kind's own, separate allowlist. */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Step 9A — 'reelVideo' only. Built by directly inspecting this app's OWN
 * video-producing code paths rather than accepting a generic `video/*`
 * wildcard (the same wildcard storage.rules' own existing Reel-source
 * rule already uses — this callable is deliberately narrower):
 *
 *  - src/app/(app)/create/reel/camera.tsx's own KNOWN_VIDEO_EXTENSIONS
 *    map is the authoritative "what this app's camera capture actually
 *    produces" declaration — it already REJECTS (via
 *    inferMimeTypeFromUri returning null, caught by
 *    validateSelectedReelVideo) any extension outside exactly these
 *    four: mp4, mov (quicktime), m4v (x-m4v), webm.
 *  - The library-picker path (expo-image-picker) reports whatever
 *    `asset.mimeType` the OS itself declares for a picked video — live
 *    testing has confirmed `video/quicktime` (iOS .mov) alongside
 *    `video/mp4`, matching this same four-value set; nothing in this
 *    app's own code has ever been observed to produce a fifth kind.
 *
 * A rare/exotic library-picked video outside this set is rejected here
 * rather than silently widened to `video/*` — consistent with this
 * file's own "narrow, observed-behavior allowlist, not a broad wildcard"
 * approach for images above.
 */
export const ALLOWED_VIDEO_CONTENT_TYPES: ReadonlySet<string> = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm']);

/**
 * Step 9C — 'reelVideo' ONLY, for the "this upload is actually an image"
 * sub-case (a plain photo Reel, or a photo-pending-render Reel whose
 * `storagePath` still holds the ORIGINAL PHOTO — see
 * ValidatedMediaUploadInput's own doc comment). Deliberately a SEPARATE,
 * WIDER set than ALLOWED_CONTENT_TYPES above (jpeg/png/webp only): this
 * is the one Reel-media path where the app can upload a user's ORIGINAL,
 * unprocessed library photo as the Reel's own primary source, not a
 * locally-re-encoded derivative —
 * src/app/(app)/create/reel/camera.tsx's own library-picker branch for a
 * plain photo (`asset.type === 'image'`) reports whatever `asset.mimeType`
 * iOS/Android itself declares (`ImagePicker.launchImageLibraryAsync`'s
 * own `preferredAssetRepresentationMode` stays at its `Automatic`
 * default — inspected directly in the installed expo-image-picker types,
 * not assumed — which does NOT force a JPEG/HEIC conversion), and only
 * validates `startsWith('image/')` before upload — never narrowing
 * further or normalizing HEIC client-side. Camera-CAPTURED photos are
 * always `image/jpeg` or `image/png` (expo-camera's own
 * `takePictureAsync()` format, mapped directly) — HEIC/HEIF are
 * exclusively a LIBRARY-pick possibility, added here rather than assumed
 * away, matching the app's own actual, unnormalized behavior rather than
 * a narrower guess. `image/webp` is included for the same
 * already-established reason ALLOWED_CONTENT_TYPES includes it elsewhere
 * in this file — a real, if less common, library-image format this
 * app's own `startsWith('image/')` client check already permits through
 * today's existing Firebase path (storage.rules' own Reel-source rule
 * uses a plain `image/.*` wildcard, never narrower than this set).
 */
export const ALLOWED_REEL_PHOTO_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export const PROFILE_PHOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;
export const PROFILE_COVER_PHOTO_MAX_SIZE_BYTES = 8 * 1024 * 1024;
export const EVENT_COVER_PHOTO_MAX_SIZE_BYTES = 8 * 1024 * 1024;
export const REEL_THUMBNAIL_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Step 9A — mirrors src/types/reel.ts's own REEL_MAX_FILE_SIZE_BYTES and
 * storage.rules' own existing `request.resource.size <= 50 * 1024 * 1024`
 * cap for a video-mediaType Reel source exactly (inspected directly, not
 * guessed) — this is the app's own EXISTING limit (informed by
 * REEL_MAX_DURATION_MS's 60-second cap and typical mobile capture
 * bitrates), preserved as-is rather than introduced fresh. Same
 * duplication reasoning as every other size constant in this file.
 */
export const REEL_VIDEO_MAX_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Step 9C — mirrors src/types/reel.ts's own REEL_PHOTO_MAX_FILE_SIZE_BYTES
 * and firestore.rules' own existing `data.fileSizeBytes <= 10485760` cap
 * for BOTH a plain photo Reel and a photo-pending-render Reel's own
 * original-photo upload (inspected directly in isValidReelCreate — the
 * same 10 MB bound applies to both variants already, today, on Firebase).
 * Deliberately larger than REEL_THUMBNAIL_MAX_SIZE_BYTES (5 MB): this is
 * the Reel's own full-resolution primary source, not a small derived
 * cover crop.
 */
export const REEL_PHOTO_SOURCE_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Step 10B — mirrors src/types/reel.ts's own REEL_MUSIC_MAX_FILE_SIZE_BYTES
 * and storage.rules' own existing `request.resource.size <= 20 * 1024 * 1024`
 * cap for a Reel's own device-picked music file exactly (inspected
 * directly, not guessed). Generous relative to the video/photo caps
 * above — the app uploads the full picked audio file, not just the
 * portion actually heard (see ReelMusicSourceType's own doc comment,
 * src/types/reel.ts: there is no trim step).
 */
export const REEL_MUSIC_MAX_SIZE_BYTES = 20 * 1024 * 1024;

/** The exact per-mediaKind maximum for an IMAGE upload — inspected from, and must be kept in sync with, the existing Firebase upload limits (5 MB for profilePhoto/reelThumbnail, 8 MB for profileCover/eventCover). Never consulted for 'reelVideo' — see REEL_VIDEO_MAX_SIZE_BYTES above, checked directly in validateMediaUploadInput's own 'reelVideo' branch instead. */
function maxSizeForMediaKind(mediaKind: AllowedMediaKind): number {
  if (mediaKind === 'profileCover' || mediaKind === 'eventCover') return PROFILE_COVER_PHOTO_MAX_SIZE_BYTES;
  if (mediaKind === 'reelThumbnail') return REEL_THUMBNAIL_MAX_SIZE_BYTES;
  return PROFILE_PHOTO_MAX_SIZE_BYTES;
}

export type ValidatedMediaUploadInput = {
  mediaKind: AllowedMediaKind;
  contentType: string;
  fileSizeBytes: number;
  /**
   * Present only for `mediaKind === 'eventCover'` — see
   * requestMediaUploadAuthorization.ts's own doc comment on why event
   * covers, unlike profile photo/cover, need a client-supplied
   * identifier at all: the cover is uploaded to a client-generated
   * `draftId` slot (content.ts's existing generateEventDraftId())
   * BEFORE the real Event document exists, so there is nothing
   * server-side yet to derive this from. Validated here as a safe path
   * segment (same isSafePathSegment check objectKey.ts's own key
   * builders already apply) so a malformed/hostile value is rejected
   * with a clean error instead of throwing inside eventCoverKey.
   */
  draftId?: string;
  /**
   * Present only for `mediaKind === 'reelThumbnail'` or `'reelVideo'` —
   * unlike Event covers, a Reel draft DOES already exist in Firestore by
   * the time either of these uploads happens (see src/services/reels.ts's
   * createReelDraft, which always runs first), so `reelId` identifies an
   * EXISTING, ownership-checkable document rather than a bare
   * client-chosen slot. Validated here only as a safe path segment
   * (defense in depth, mirroring draftId above) — the REAL security
   * property (this Reel belongs to the caller, is still awaiting this
   * exact media, and — for 'reelVideo' specifically — has no server-side
   * source transformation pending that would make an R2-backed source
   * unsafe) is a Firestore read that can only happen in
   * requestMediaUploadAuthorization.ts's own handleRequest, never in
   * this pure, Firestore-free file.
   */
  reelId?: string;
  /**
   * Present only for `mediaKind === 'storyMedia'` — same reasoning as
   * `reelId` above: a Story draft already exists in Firestore by the time
   * this upload happens (src/services/stories.ts's createStoryDraft
   * always runs first), so this identifies an EXISTING, ownership-
   * checkable document. Validated here only as a safe path segment —
   * the real ownership/status/mediaType-match check is
   * checkStoryMediaEligibility's own job (storyEligibility.ts), run in
   * requestMediaUploadAuthorization.ts's own handleRequest against a
   * real Firestore read, never in this pure, Firestore-free file.
   */
  storyId?: string;
};

/** Thrown by validateMediaUploadInput — a plain Error subclass, never an HttpsError (this file has no firebase-functions import — see this file's own top doc comment). The caller (requestMediaUploadAuthorization.ts) is responsible for translating this into a real HttpsError('invalid-argument', ...). */
export class MediaUploadValidationError extends Error {}

/**
 * Full runtime validation of the callable's own untrusted request data —
 * never trust its shape just because a client's TypeScript types say so.
 * Deliberately throws the SAME generic message for every failure (never
 * a distinct one per field) so a malformed/hostile request never learns
 * more than "this request was rejected" — no help narrowing down which
 * exact field/value tripped the check.
 *
 * Reads ONLY `mediaKind`/`contentType`/`fileSizeBytes`/`draftId`/`reelId`/
 * `storyId` from `data` — never a `uid`/`path`/any identity-shaped field,
 * even if a hostile payload includes one. There is no code path anywhere
 * in this function that could let a client-supplied uid or full path
 * influence anything; see requestMediaUploadAuthorization.ts's own
 * handleRequest for where the actual object key is derived (the uid
 * segment always from `request.auth.uid`, never from this validated
 * input — `draftId`/`reelId`/`storyId` are the one exception each, and
 * only ever become ONE safe path SEGMENT under the caller's own uid,
 * never a full path — and for `reelId`/`storyId` specifically, ownership
 * is separately re-verified against a real Firestore document before
 * either is ever used, which this pure function cannot do itself).
 */
export function validateMediaUploadInput(data: unknown): ValidatedMediaUploadInput {
  const invalid = () => new MediaUploadValidationError('This upload request is not valid.');
  if (typeof data !== 'object' || data === null) throw invalid();

  const { mediaKind, contentType, fileSizeBytes, draftId, reelId, storyId } = data as Record<string, unknown>;

  // Only these seven exact kinds — any other value (including a real
  // future media kind name typed too early) is rejected here, not
  // silently accepted.
  if (
    mediaKind !== 'profilePhoto' &&
    mediaKind !== 'profileCover' &&
    mediaKind !== 'eventCover' &&
    mediaKind !== 'reelThumbnail' &&
    mediaKind !== 'reelVideo' &&
    mediaKind !== 'storyMedia' &&
    mediaKind !== 'reelMusic'
  ) {
    throw invalid();
  }

  // 'reelVideo' uses its own, separate content-type allowlists and size
  // caps (see ALLOWED_VIDEO_CONTENT_TYPES/ALLOWED_REEL_PHOTO_CONTENT_TYPES's
  // own doc comments) — every other kind is an image, sharing the one
  // ALLOWED_CONTENT_TYPES set and its own per-kind size cap below.
  //
  // Step 9C — 'reelVideo' now accepts EITHER shape here (a real video, OR
  // an image — covering a plain photo Reel's own source, and a
  // photo-pending-render Reel's still-a-photo original upload): this
  // pure layer has no access to the Reel's own `mediaType`/
  // `needsPhotoVideoRender`, so it can only validate that SOME allowed
  // shape was sent, not that it's the RIGHT shape for THIS exact Reel.
  // That cross-check (does this content type actually match what this
  // Reel is currently expecting?) is checkReelVideoEligibility's own job
  // (reelEligibility.ts) — it has the real Firestore document this file
  // deliberately never reads.
  if (mediaKind === 'reelVideo') {
    const isValidVideoShape =
      typeof contentType === 'string' &&
      ALLOWED_VIDEO_CONTENT_TYPES.has(contentType) &&
      typeof fileSizeBytes === 'number' &&
      Number.isFinite(fileSizeBytes) &&
      fileSizeBytes > 0 &&
      fileSizeBytes <= REEL_VIDEO_MAX_SIZE_BYTES;
    const isValidPhotoShape =
      typeof contentType === 'string' &&
      ALLOWED_REEL_PHOTO_CONTENT_TYPES.has(contentType) &&
      typeof fileSizeBytes === 'number' &&
      Number.isFinite(fileSizeBytes) &&
      fileSizeBytes > 0 &&
      fileSizeBytes <= REEL_PHOTO_SOURCE_MAX_SIZE_BYTES;
    if (!isValidVideoShape && !isValidPhotoShape) throw invalid();
    if (typeof reelId !== 'string' || !isSafePathSegment(reelId)) throw invalid();
    return { mediaKind, contentType: contentType as string, fileSizeBytes: fileSizeBytes as number, reelId };
  }

  // Step 10B — 'reelMusic', for a Reel's own device-picked music upload.
  // Deliberately a WIDE `audio/*` prefix check, not a narrow Set-based
  // allowlist like every other media kind here — unlike camera/library-
  // captured video/photo (a genuinely bounded output), Reel music comes
  // from the device's own arbitrary file picker (expo-document-picker,
  // `type: 'audio/*'` — see src/app/(app)/create/reel/music.tsx and
  // src/utils/reelMusicValidation.ts's own identical `startsWith('audio/')`
  // check), so its real MIME universe cannot be enumerated the way a
  // camera's fixed output can — mirrors storage.rules' own pre-existing
  // `musicStorageContentType.matches('audio/.*')` wildcard exactly, not a
  // narrower guess.
  if (mediaKind === 'reelMusic') {
    const isValidAudioShape =
      typeof contentType === 'string' &&
      contentType.startsWith('audio/') &&
      typeof fileSizeBytes === 'number' &&
      Number.isFinite(fileSizeBytes) &&
      fileSizeBytes > 0 &&
      fileSizeBytes <= REEL_MUSIC_MAX_SIZE_BYTES;
    if (!isValidAudioShape) throw invalid();
    if (typeof reelId !== 'string' || !isSafePathSegment(reelId)) throw invalid();
    return { mediaKind, contentType: contentType as string, fileSizeBytes: fileSizeBytes as number, reelId };
  }

  // Step 10A — 'storyMedia' reuses the EXACT same two shapes/allowlists/
  // size caps as 'reelVideo' above, not a separate set: a Story is
  // created from the exact same camera/picker code path as a Reel (see
  // src/types/story.ts's own doc comment — camera.tsx's "Story" button
  // shares the same `photo`/`video` capture state as the "Next" (Reel)
  // button), so its own real MIME/size universe is provably identical,
  // never a guess. Unlike 'reelVideo', there is no render-pending
  // sub-case here at all — a Story is always exactly the raw camera
  // output (no "FOTO"-with-music rendering concept — see Story.mediaType's
  // own doc comment), so this pure layer's "which shape" ambiguity is
  // only ever "photo Story" vs. "video Story," cross-checked against the
  // Story's own `mediaType` by checkStoryMediaEligibility (storyEligibility.ts),
  // exactly mirroring checkReelVideoEligibility's own contentType check.
  if (mediaKind === 'storyMedia') {
    const isValidVideoShape =
      typeof contentType === 'string' &&
      ALLOWED_VIDEO_CONTENT_TYPES.has(contentType) &&
      typeof fileSizeBytes === 'number' &&
      Number.isFinite(fileSizeBytes) &&
      fileSizeBytes > 0 &&
      fileSizeBytes <= REEL_VIDEO_MAX_SIZE_BYTES;
    const isValidPhotoShape =
      typeof contentType === 'string' &&
      ALLOWED_REEL_PHOTO_CONTENT_TYPES.has(contentType) &&
      typeof fileSizeBytes === 'number' &&
      Number.isFinite(fileSizeBytes) &&
      fileSizeBytes > 0 &&
      fileSizeBytes <= REEL_PHOTO_SOURCE_MAX_SIZE_BYTES;
    if (!isValidVideoShape && !isValidPhotoShape) throw invalid();
    if (typeof storyId !== 'string' || !isSafePathSegment(storyId)) throw invalid();
    return { mediaKind, contentType: contentType as string, fileSizeBytes: fileSizeBytes as number, storyId };
  }

  if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) throw invalid();
  const maxSizeBytes = maxSizeForMediaKind(mediaKind);
  if (typeof fileSizeBytes !== 'number' || !Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > maxSizeBytes) {
    throw invalid();
  }

  if (mediaKind === 'eventCover') {
    // Required for this media kind only — see this file's own
    // ValidatedMediaUploadInput doc comment on draftId for why.
    if (typeof draftId !== 'string' || !isSafePathSegment(draftId)) throw invalid();
    return { mediaKind, contentType, fileSizeBytes, draftId };
  }

  if (mediaKind === 'reelThumbnail') {
    // Required for this media kind only — see this file's own
    // ValidatedMediaUploadInput doc comment on reelId for why.
    if (typeof reelId !== 'string' || !isSafePathSegment(reelId)) throw invalid();
    return { mediaKind, contentType, fileSizeBytes, reelId };
  }

  return { mediaKind, contentType, fileSizeBytes };
}
