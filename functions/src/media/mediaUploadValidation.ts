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
 * throw an HttpsError directly.
 */

/** The only media kinds this callable supports — Step 5A added 'profilePhoto', Step 5C adds 'profileCover'. Any other value (Reels, Stories, Events, audio, thumbnails, or a made-up future kind) is rejected. */
export type AllowedMediaKind = 'profilePhoto' | 'profileCover';

/** Narrowly restricted to formats the app's existing profile-photo/cover picker flows actually produce — no video/*, no application/*, no arbitrary MIME type. Same set for both media kinds — the existing Firebase cover-photo flow (userProfile.ts's uploadProfileCoverPhoto) uses the exact same `blob.type || 'image/jpeg'` fallback and no separate content-type restriction of its own, so there's no reason to diverge here. */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Mirrors src/types/user.ts's own PROFILE_PHOTO_MAX_SIZE_BYTES exactly — functions/ and the app are separate TypeScript compilation roots (this codebase's own established, pre-existing convention — see e.g. REGION being duplicated across every functions/src/*.ts file rather than imported), so this is a deliberate, documented duplication to keep in sync, not an oversight. */
export const PROFILE_PHOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** Mirrors src/types/user.ts's own PROFILE_COVER_PHOTO_MAX_SIZE_BYTES exactly (8 MB — the existing Firebase cover-upload flow's own limit, larger than the profile-photo limit since a cover banner is a wider image) — same duplication reasoning as PROFILE_PHOTO_MAX_SIZE_BYTES above. */
export const PROFILE_COVER_PHOTO_MAX_SIZE_BYTES = 8 * 1024 * 1024;

/** The exact per-mediaKind maximum — inspected from, and must be kept in sync with, the existing Firebase upload limits in userProfile.ts (5 MB for profilePhoto, 8 MB for profileCover). */
function maxSizeForMediaKind(mediaKind: AllowedMediaKind): number {
  return mediaKind === 'profileCover' ? PROFILE_COVER_PHOTO_MAX_SIZE_BYTES : PROFILE_PHOTO_MAX_SIZE_BYTES;
}

export type ValidatedMediaUploadInput = {
  mediaKind: AllowedMediaKind;
  contentType: string;
  fileSizeBytes: number;
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
 * Reads ONLY `mediaKind`/`contentType`/`fileSizeBytes` from `data` —
 * never a `uid`/`path`/any identity-shaped field, even if a hostile
 * payload includes one. There is no code path anywhere in this function
 * that could let a client-supplied uid or path influence anything; see
 * requestMediaUploadAuthorization.ts's own handleRequest for where the
 * actual object key is derived (from `request.auth.uid` only, never
 * from this validated input).
 */
export function validateMediaUploadInput(data: unknown): ValidatedMediaUploadInput {
  const invalid = () => new MediaUploadValidationError('This upload request is not valid.');
  if (typeof data !== 'object' || data === null) throw invalid();

  const { mediaKind, contentType, fileSizeBytes } = data as Record<string, unknown>;

  // Only 'profilePhoto'/'profileCover' — any other value (including a
  // real future media kind name typed too early) is rejected here, not
  // silently accepted.
  if (mediaKind !== 'profilePhoto' && mediaKind !== 'profileCover') throw invalid();
  if (typeof contentType !== 'string' || !ALLOWED_CONTENT_TYPES.has(contentType)) throw invalid();
  const maxSizeBytes = maxSizeForMediaKind(mediaKind);
  if (typeof fileSizeBytes !== 'number' || !Number.isFinite(fileSizeBytes) || fileSizeBytes <= 0 || fileSizeBytes > maxSizeBytes) {
    throw invalid();
  }

  return { mediaKind, contentType, fileSizeBytes };
}
