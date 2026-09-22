import { httpsCallable } from 'firebase/functions';

import { functions } from '../functions';
import type { MediaStorageProvider, MediaUploadProgressCallback, MediaUploadRequest, MediaUploadResult } from './provider';

/**
 * The safe, minimal shape the `requestMediaUploadAuthorization` callable
 * returns (see functions/src/media/requestMediaUploadAuthorization.ts's
 * own RequestMediaUploadAuthorizationResult) — deliberately redeclared
 * here rather than imported, matching this codebase's own established
 * boundary: functions/ and src/ are separate TypeScript compilation
 * roots with no shared module resolution (the same reason REGION is
 * duplicated across every functions/src/*.ts file rather than imported
 * from one shared location). Keep this in sync with that file's own
 * result type if it ever changes.
 */
type MediaUploadAuthorizationResponse = {
  provider: 'r2';
  path: string;
  uploadUrl: string;
  contentType: string;
  /** Unix ms. */
  expiresAt: number;
  /**
   * Step 5B — the stable, cache-busted, public delivery URL this object
   * is reachable at once the upload succeeds. `null` when
   * `R2_PUBLIC_MEDIA_BASE_URL` isn't configured server-side yet — see
   * requestMediaUploadAuthorization.ts's own doc comment on this same
   * field for the full reasoning (server is the ONE source of truth for
   * this URL; the client never constructs it itself).
   */
  mediaUrl: string | null;
};

async function requestUploadAuthorization(
  mediaKind: 'profilePhoto',
  contentType: string,
  fileSizeBytes: number
): Promise<MediaUploadAuthorizationResponse> {
  if (!functions) {
    throw new Error('This feature is not available right now.');
  }
  const callable = httpsCallable<{ mediaKind: string; contentType: string; fileSizeBytes: number }, MediaUploadAuthorizationResponse>(
    functions,
    'requestMediaUploadAuthorization'
  );
  const result = await callable({ mediaKind, contentType, fileSizeBytes });
  return result.data;
}

type DirectUploadOutcome = { ok: true; authorization: MediaUploadAuthorizationResponse } | { ok: false; message: string };

/**
 * The shared "authorize, then PUT" mechanics behind both
 * r2MediaProvider.upload (the generic MediaStorageProvider
 * implementation) and uploadProfilePhotoToR2 (the real, display-capable
 * path — see its own doc comment below) — kept as one function so the
 * actual upload behavior (content-type resolution, error handling,
 * non-2xx rejection) is defined exactly once.
 */
async function performDirectUpload(localUri: string, contentType: string, onProgress: MediaUploadProgressCallback): Promise<DirectUploadOutcome> {
  let blob: Blob;
  try {
    const response = await fetch(localUri);
    blob = await response.blob();
  } catch {
    return { ok: false, message: "Couldn't read this file." };
  }

  // Deliberately the ACTUAL fetched blob's own contentType/size (with
  // `contentType` as only a fallback for a blob that reports none) —
  // this is what the callable validates and binds into the presigned
  // URL's own signature, so it must match exactly what's about to be
  // uploaded, never a caller's earlier guess.
  const resolvedContentType = blob.type || contentType;

  let authorization: MediaUploadAuthorizationResponse;
  try {
    authorization = await requestUploadAuthorization('profilePhoto', resolvedContentType, blob.size);
  } catch {
    return { ok: false, message: "Couldn't prepare this upload." };
  }

  onProgress(0);
  let putResponse: Response;
  try {
    putResponse = await fetch(authorization.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': authorization.contentType },
      body: blob,
    });
  } catch {
    return { ok: false, message: "Couldn't upload this file." };
  }
  if (!putResponse.ok) {
    // A non-2xx PUT response (e.g. the presigned URL expired, or the
    // actual body didn't match the signed Content-Length) — never
    // treated as success just because the network request itself
    // completed.
    return { ok: false, message: "Couldn't upload this file." };
  }
  // Plain fetch/PUT gives no incremental upload-progress events in
  // React Native (unlike Firebase's own uploadBytesResumable, which this
  // provider intentionally does NOT try to replicate here — see the
  // Step 5A report's own risks/limitations) — 0 -> 100 brackets the
  // request rather than fabricating a false middle value.
  onProgress(100);

  return { ok: true, authorization };
}

/**
 * The R2 implementation of MediaStorageProvider — Step 5A's generic
 * proof of the direct-upload path, for 'profilePhoto' only (see
 * provider.ts's own doc comment on why 'upload' takes a mediaKind rather
 * than a pre-decided path — R2's server-authorized flow is exactly why
 * that shape changed from Step 4's first draft). Kept exactly as Step 5A
 * shipped it — see uploadProfilePhotoToR2 below for the REAL,
 * display-capable path Step 5B actually wires userProfile.ts to; this
 * generic interface implementation intentionally still only proves the
 * write path (its own MediaReference result carries no display URL),
 * since MediaStorageProvider's shape is meant to stay provider-neutral
 * for future media kinds, not grow a profile-photo-specific `mediaUrl`
 * field.
 *
 * `resolveUrl` returns `null` deliberately, not because R2 delivery
 * doesn't exist (it does, as of Step 5B — see uploadProfilePhotoToR2) but
 * because doing real URL resolution here would mean this file keeping
 * its OWN copy of the public media base URL (an
 * EXPO_PUBLIC_R2_MEDIA_BASE_URL client env var) — exactly the
 * config-duplication Step 5B's own report chose to avoid. The single
 * source of truth for this URL is the server's own
 * `R2_PUBLIC_MEDIA_BASE_URL`, consulted only inside
 * requestMediaUploadAuthorization.ts, and returned directly as part of
 * its own response (`mediaUrl`) rather than reconstructed here.
 */
export const r2MediaProvider: MediaStorageProvider = {
  provider: 'r2',

  async upload({ mediaKind, localUri, contentType, onProgress }: MediaUploadRequest): Promise<MediaUploadResult> {
    if (mediaKind !== 'profilePhoto') {
      return { ok: false, message: 'This media type is not supported on R2 yet.' };
    }
    const outcome = await performDirectUpload(localUri, contentType, onProgress);
    if (!outcome.ok) return outcome;
    return { ok: true, reference: { provider: 'r2', path: outcome.authorization.path } };
  },

  async resolveUrl(): Promise<string | null> {
    return null;
  },

  async delete(): Promise<void> {
    throw new Error('R2 delete is not implemented yet — Step 5A/5B only prove the upload+display path.');
  },
};

export type ProfilePhotoUploadResult = { ok: true; photoURL: string } | { ok: false; message: string };

/**
 * Step 5B — the real, production-wired profile-photo upload path:
 * uploads to R2 via the exact same authorize-then-PUT mechanics as
 * r2MediaProvider.upload above, and additionally surfaces the server-
 * computed `mediaUrl` as a real `photoURL` the EXISTING profile-update
 * flow can persist exactly like a Firebase download URL (see
 * userProfile.ts's own uploadProfilePhotoViaR2, the only caller).
 *
 * Deliberately returns `ok: false` — never a fabricated or empty
 * `photoURL` — when the upload itself succeeded but `mediaUrl` came back
 * `null` (no public media domain configured yet): this app must never
 * persist a URL nothing can actually resolve, and must never blank a
 * real user's visible photo just because a developer flipped
 * EXPO_PUBLIC_MEDIA_STORAGE_PROVIDER=r2 for testing before delivery was
 * configured. See the Step 5B report's own "Firestore changes" for why
 * this needs no new field: the entire cache-busted URL (including its
 * `?v=` query string) is exactly what gets persisted into the EXISTING
 * `photoURL` string field, unchanged in shape from a Firebase URL.
 */
export async function uploadProfilePhotoToR2(localUri: string, onProgress: MediaUploadProgressCallback): Promise<ProfilePhotoUploadResult> {
  const outcome = await performDirectUpload(localUri, 'image/jpeg', onProgress);
  if (!outcome.ok) return outcome;

  if (!outcome.authorization.mediaUrl) {
    return { ok: false, message: 'Uploaded to R2, but no public media domain is configured yet — this photo is not displayable.' };
  }
  return { ok: true, photoURL: outcome.authorization.mediaUrl };
}
