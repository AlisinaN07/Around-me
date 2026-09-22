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
 * throw an HttpsError directly. Reel-ownership/draft-status verification
 * for 'reelThumbnail' (a real Firestore read) can't live here either —
 * that stays in requestMediaUploadAuthorization.ts's own handleRequest,
 * right after this pure shape validation passes.
 */
import { isSafePathSegment } from './objectKey';

/** The only media kinds this callable supports — Step 5A added 'profilePhoto', Step 5C added 'profileCover', Step 5D added 'eventCover', Step 5E adds 'reelThumbnail'. Any other value (the Reel video/audio itself, Stories, or a made-up future kind) is rejected. */
export type AllowedMediaKind = 'profilePhoto' | 'profileCover' | 'eventCover' | 'reelThumbnail';

/** Narrowly restricted to formats the app's existing image-upload flows actually produce — no video/*, no application/*, no arbitrary MIME type. Same set for every media kind, including reelThumbnail: every real thumbnail-generation code path observed (src/utils/reelThumbnailCandidates.ts's expo-video-thumbnails output, and camera.tsx's own SaveFormat.JPEG render for a "FOTO" cover) only ever produces JPEG, but this allowlist is kept at the same 3-format set used elsewhere rather than narrowed to jpeg-only, since narrowing further without being certain every code path is JPEG-only would risk silently breaking a legitimate upload. */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Mirrors src/types/user.ts's own PROFILE_PHOTO_MAX_SIZE_BYTES exactly — functions/ and the app are separate TypeScript compilation roots (this codebase's own established, pre-existing convention — see e.g. REGION being duplicated across every functions/src/*.ts file rather than imported), so this is a deliberate, documented duplication to keep in sync, not an oversight. */
export const PROFILE_PHOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** Mirrors src/types/user.ts's own PROFILE_COVER_PHOTO_MAX_SIZE_BYTES exactly (8 MB — the existing Firebase cover-upload flow's own limit, larger than the profile-photo limit since a cover banner is a wider image) — same duplication reasoning as PROFILE_PHOTO_MAX_SIZE_BYTES above. */
export const PROFILE_COVER_PHOTO_MAX_SIZE_BYTES = 8 * 1024 * 1024;

/** Mirrors src/types/content.ts's own EVENT_COVER_PHOTO_MAX_SIZE_BYTES exactly (8 MB — inspected directly from content.ts's existing uploadEventCoverPhoto, same limit as profile cover) — same duplication reasoning as above. */
export const EVENT_COVER_PHOTO_MAX_SIZE_BYTES = 8 * 1024 * 1024;

/** Mirrors src/types/reel.ts's own REEL_THUMBNAIL_MAX_FILE_SIZE_BYTES exactly (5 MB — inspected directly from firestore.rules' own isValidReelThumbnail, which already caps a video Reel's real cover-image object at exactly this value) — same duplication reasoning as above. */
export const REEL_THUMBNAIL_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** The exact per-mediaKind maximum — inspected from, and must be kept in sync with, the existing Firebase upload limits (5 MB for profilePhoto/reelThumbnail, 8 MB for profileCover/eventCover). */
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
   * Present only for `mediaKind === 'reelThumbnail'` — unlike Event
   * covers, a Reel draft DOES already exist in Firestore by the time its
   * thumbnail uploads (see src/services/reels.ts's createReelDraft,
   * which always runs first), so `reelId` identifies an EXISTING,
   * ownership-checkable document rather than a bare client-chosen slot.
   * Validated here only as a safe path segment (defense in depth,
   * mirroring draftId above) — the REAL security property (this Reel
   * belongs to the caller and is still awaiting its thumbnail) is a
   * Firestore read that can only happen in
   * requestMediaUploadAuthorization.ts's own handleRequest, never in
   * this pure, Firestore-free file.
   */
  reelId?: string;
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
 * Reads ONLY `mediaKind`/`contentType`/`fileSizeBytes`/`draftId`/`reelId`
 * from `data` — never a `uid`/`path`/any identity-shaped field, even if
 * a hostile payload includes one. There is no code path anywhere in this
 * function that could let a client-supplied uid or full path influence
 * anything; see requestMediaUploadAuthorization.ts's own handleRequest
 * for where the actual object key is derived (the uid segment always
 * from `request.auth.uid`, never from this validated input — `draftId`/
 * `reelId` are the one exception each, and only ever become ONE safe
 * path SEGMENT under the caller's own uid, never a full path — and for
 * `reelId` specifically, ownership is separately re-verified against a
 * real Firestore document before it's ever used, which this pure
 * function cannot do itself).
 */
export function validateMediaUploadInput(data: unknown): ValidatedMediaUploadInput {
  const invalid = () => new MediaUploadValidationError('This upload request is not valid.');
  if (typeof data !== 'object' || data === null) throw invalid();

  const { mediaKind, contentType, fileSizeBytes, draftId, reelId } = data as Record<string, unknown>;

  // Only these four exact kinds — any other value (including a real
  // future media kind name typed too early, or the Reel's own video/
  // audio) is rejected here, not silently accepted.
  if (mediaKind !== 'profilePhoto' && mediaKind !== 'profileCover' && mediaKind !== 'eventCover' && mediaKind !== 'reelThumbnail') {
    throw invalid();
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
