import { File, UploadType } from 'expo-file-system';
import { httpsCallable } from 'firebase/functions';

import { functions } from '../functions';
import { performReelVideoUpload } from './reelVideoUploadCore';
import type { MediaStorageProvider, MediaUploadProgressCallback, MediaUploadRequest, MediaUploadResult } from './provider';
import type { MediaKind } from './types';

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
  mediaKind: MediaKind,
  contentType: string,
  fileSizeBytes: number,
  draftId?: string,
  reelId?: string,
  storyId?: string
): Promise<MediaUploadAuthorizationResponse> {
  if (!functions) {
    throw new Error('This feature is not available right now.');
  }
  const callable = httpsCallable<
    { mediaKind: string; contentType: string; fileSizeBytes: number; draftId?: string; reelId?: string; storyId?: string },
    MediaUploadAuthorizationResponse
  >(functions, 'requestMediaUploadAuthorization');
  const result = await callable({
    mediaKind,
    contentType,
    fileSizeBytes,
    ...(draftId ? { draftId } : {}),
    ...(reelId ? { reelId } : {}),
    ...(storyId ? { storyId } : {}),
  });
  return result.data;
}

type DirectUploadOutcome = { ok: true; authorization: MediaUploadAuthorizationResponse } | { ok: false; message: string };

/**
 * The shared "authorize, then PUT" mechanics behind both
 * r2MediaProvider.upload (the generic MediaStorageProvider
 * implementation) and uploadProfilePhotoToR2/uploadProfileCoverToR2 (the
 * real, display-capable paths — see their own doc comments below) — kept
 * as one function so the actual upload behavior (content-type
 * resolution, error handling, non-2xx rejection) is defined exactly
 * once, regardless of which media kind is being uploaded.
 */
async function performDirectUpload(
  mediaKind: MediaKind,
  localUri: string,
  contentType: string,
  onProgress: MediaUploadProgressCallback,
  draftId?: string,
  reelId?: string,
  storyId?: string
): Promise<DirectUploadOutcome> {
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
    authorization = await requestUploadAuthorization(mediaKind, resolvedContentType, blob.size, draftId, reelId, storyId);
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
 * proof of the direct-upload path, for 'profilePhoto'/'profileCover'
 * (see provider.ts's own doc comment on why 'upload' takes a mediaKind
 * rather than a pre-decided path — R2's server-authorized flow is
 * exactly why that shape changed from Step 4's first draft). This
 * generic interface implementation intentionally still only proves the
 * write path (its own MediaReference result carries no display URL),
 * since MediaStorageProvider's shape is meant to stay provider-neutral
 * for future media kinds, not grow a profile-photo/cover-specific
 * `mediaUrl` field — see uploadProfilePhotoToR2/uploadProfileCoverToR2
 * below for the REAL, display-capable paths userProfile.ts actually
 * wires up.
 *
 * `resolveUrl` returns `null` deliberately, not because R2 delivery
 * doesn't exist (it does — see uploadProfilePhotoToR2/
 * uploadProfileCoverToR2) but because doing real URL resolution here
 * would mean this file keeping its OWN copy of the public media base URL
 * (an EXPO_PUBLIC_R2_MEDIA_BASE_URL client env var) — exactly the
 * config-duplication the Step 5B report chose to avoid. The single
 * source of truth for this URL is the server's own
 * `R2_PUBLIC_MEDIA_BASE_URL`, consulted only inside
 * requestMediaUploadAuthorization.ts, and returned directly as part of
 * its own response (`mediaUrl`) rather than reconstructed here.
 */
export const r2MediaProvider: MediaStorageProvider = {
  provider: 'r2',

  async upload({ mediaKind, localUri, contentType, onProgress }: MediaUploadRequest): Promise<MediaUploadResult> {
    const outcome = await performDirectUpload(mediaKind, localUri, contentType, onProgress);
    if (!outcome.ok) return outcome;
    return { ok: true, reference: { provider: 'r2', path: outcome.authorization.path } };
  },

  async resolveUrl(): Promise<string | null> {
    return null;
  },

  /**
   * Calls the trusted `deleteOwnMedia` Cloud Function — R2 has no
   * client-reachable delete path of its own (credentials never leave the
   * backend, see functions/src/media/r2Config.ts's own doc comment), so
   * this can never delete anything directly. The server independently
   * re-verifies `path` belongs to the caller before deleting anything —
   * see deleteOwnMedia.ts's own doc comment — so passing an unexpected
   * path here fails safely (a rejected call), never a wrong deletion.
   */
  async delete(path: string): Promise<void> {
    if (!functions) {
      throw new Error('This feature is not available right now.');
    }
    const callable = httpsCallable<{ path: string }, { path: string; attempted: boolean }>(functions, 'deleteOwnMedia');
    await callable({ path });
  },
};

type DisplayableUploadResult = { ok: true; photoURL: string } | { ok: false; message: string };

/** Legacy alias kept for the existing profile-photo call site's own naming — see uploadProfilePhotoToR2 below. */
export type ProfilePhotoUploadResult = DisplayableUploadResult;

/**
 * Shared implementation behind both uploadProfilePhotoToR2 and
 * uploadProfileCoverToR2 below — uploads via the exact same
 * authorize-then-PUT mechanics as r2MediaProvider.upload, and
 * additionally surfaces the server-computed `mediaUrl` as a real,
 * displayable URL the EXISTING profile-update flow can persist exactly
 * like a Firebase download URL (see userProfile.ts's own
 * uploadProfilePhotoViaR2/uploadProfileCoverViaR2, the only callers).
 *
 * Deliberately returns `ok: false` — never a fabricated or empty URL —
 * when the upload itself succeeded but `mediaUrl` came back `null` (no
 * public media domain configured yet): this app must never persist a
 * URL nothing can actually resolve, and must never blank a real user's
 * visible photo/cover just because a developer flipped
 * EXPO_PUBLIC_MEDIA_STORAGE_PROVIDER=r2 for testing before delivery was
 * configured. See the Step 5B report's own "Firestore changes" for why
 * this needs no new field: the entire cache-busted URL (including its
 * `?v=` query string) is exactly what gets persisted into the EXISTING
 * `photoURL`/`coverPhotoURL` string fields, unchanged in shape from a
 * Firebase URL.
 */
async function uploadDisplayableMediaToR2(
  mediaKind: MediaKind,
  localUri: string,
  onProgress: MediaUploadProgressCallback,
  notConfiguredMessage: string,
  draftId?: string,
  reelId?: string,
  storyId?: string,
  contentType = 'image/jpeg'
): Promise<DisplayableUploadResult> {
  const outcome = await performDirectUpload(mediaKind, localUri, contentType, onProgress, draftId, reelId, storyId);
  if (!outcome.ok) return outcome;

  if (!outcome.authorization.mediaUrl) {
    return { ok: false, message: notConfiguredMessage };
  }
  return { ok: true, photoURL: outcome.authorization.mediaUrl };
}

/** The real, production-wired profile-photo upload path — see uploadDisplayableMediaToR2's own doc comment for the full behavior. */
export async function uploadProfilePhotoToR2(localUri: string, onProgress: MediaUploadProgressCallback): Promise<ProfilePhotoUploadResult> {
  return uploadDisplayableMediaToR2(
    'profilePhoto',
    localUri,
    onProgress,
    'Uploaded to R2, but no public media domain is configured yet — this photo is not displayable.'
  );
}

/** The real, production-wired profile-cover upload path — see uploadDisplayableMediaToR2's own doc comment for the full behavior (identical to uploadProfilePhotoToR2, just for the `profileCover` media kind and its own `profileCovers/{uid}/photo` object key). */
export async function uploadProfileCoverToR2(localUri: string, onProgress: MediaUploadProgressCallback): Promise<ProfilePhotoUploadResult> {
  return uploadDisplayableMediaToR2(
    'profileCover',
    localUri,
    onProgress,
    'Uploaded to R2, but no public media domain is configured yet — this cover photo is not displayable.'
  );
}

/**
 * The real, production-wired Event-cover upload path — see
 * uploadDisplayableMediaToR2's own doc comment for the shared upload
 * behavior. `draftId` is REQUIRED here (unlike profile photo/cover,
 * which need no client-supplied identifier at all) — see
 * requestMediaUploadAuthorization.ts's own doc comment on why an Event
 * cover, uploaded before the real Event document exists, needs one;
 * this must be the exact same draftId content.ts's existing
 * generateEventDraftId() already produces for the Create Event screen's
 * own lifetime, so a later createEvent call's own object identity stays
 * consistent within one creation session — exactly mirroring the
 * existing Firebase `eventCovers/{uid}/{draftId}/photo` behavior.
 */
export async function uploadEventCoverToR2(
  draftId: string,
  localUri: string,
  onProgress: MediaUploadProgressCallback
): Promise<ProfilePhotoUploadResult> {
  return uploadDisplayableMediaToR2(
    'eventCover',
    localUri,
    onProgress,
    'Uploaded to R2, but no public media domain is configured yet — this cover photo is not displayable.',
    draftId
  );
}

/**
 * The real, production-wired Reel-thumbnail upload path — see
 * uploadDisplayableMediaToR2's own doc comment for the shared upload
 * behavior. `reelId` is REQUIRED (unlike profile photo/cover) — see
 * requestMediaUploadAuthorization.ts's own verifyReelThumbnailOwnership
 * for why: the server loads this exact Reel and verifies the caller
 * owns it and it's still awaiting its thumbnail BEFORE ever creating a
 * presigned URL, so a made-up/foreign reelId is rejected server-side
 * regardless of what this client-side function passes along.
 *
 * Unlike profile photo/cover/event cover — whose callers persist the
 * returned `photoURL` themselves — this function's own caller
 * (reels.ts's uploadReelThumbnail) is responsible for ALSO writing the
 * returned URL into the Reel's own `thumbnailUrl`/
 * `thumbnailStorageProvider` fields via confirmReelThumbnailProvider,
 * since uploadReelThumbnail's existing contract exposes no URL to ITS
 * own caller at all (unlike edit.tsx's profile-photo flow) — see
 * reels.ts's own doc comment on that function for the full reasoning.
 */
export async function uploadReelThumbnailToR2(
  reelId: string,
  localUri: string,
  onProgress: MediaUploadProgressCallback
): Promise<ProfilePhotoUploadResult> {
  return uploadDisplayableMediaToR2(
    'reelThumbnail',
    localUri,
    onProgress,
    'Uploaded to R2, but no public media domain is configured yet — this thumbnail is not displayable.',
    undefined,
    reelId
  );
}

type ReelVideoUploadResult = { ok: true; sourceUrl: string } | { ok: false; message: string };

/**
 * Step 9A — the real, production-wired Reel-VIDEO upload path. Unlike
 * every other R2 upload above (all built on performDirectUpload's own
 * `fetch(localUri) -> Blob -> fetch(presignedUrl, PUT)` mechanics), this
 * deliberately does NOT reuse that helper — see the "Large file handling"
 * section of the Step 9A report for the full investigation this
 * divergence is based on. In short:
 *
 *  - React Native's own `Response.blob()` (what performDirectUpload's
 *    `fetch(localUri)` step relies on) is documented as "may be slow for
 *    large responses" — acceptable for a 5-8 MB image, not for a video up
 *    to REEL_VIDEO_MAX_SIZE_BYTES (50 MB): it would fully buffer the
 *    entire file into a JS-visible Blob before the PUT even starts, and
 *    plain `fetch(uploadUrl, { body: blob })` gives no real upload
 *    progress at all (the existing image paths simply accept a fake
 *    0 -> 100 jump for this reason — not acceptable for a multi-second
 *    video upload).
 *  - expo-file-system's `File.createUploadTask` (already used elsewhere
 *    in this app — see camera.tsx/music.tsx's own `new File(uri).size`
 *    usage) performs a NATIVE-level upload straight from the local file
 *    on disk, supports `httpMethod: 'PUT'` and
 *    `uploadType: UploadType.BINARY_CONTENT` (a raw-body PUT, exactly
 *    what a presigned R2 URL expects — no multipart framing), and
 *    reports REAL `onProgress({ bytesSent, totalBytes })` events from
 *    the native layer — without ever pulling the whole file through JS
 *    as a Blob or base64 string.
 *
 * No new dependency was added — expo-file-system is already a direct
 * dependency of this project for unrelated reasons (see above).
 *
 * `onUploadTaskReady`, if provided, is called synchronously with a real
 * `cancel()` function the moment the native upload task exists — this is
 * what lets reels.ts's own uploadReelVideoViaR2 wire up GENUINE upload
 * cancellation (unlike uploadReelThumbnailViaR2's own thumbnail-upload
 * cancel, which only ever ignores a still-in-flight small image request
 * rather than actually aborting it — acceptable for a few-hundred-KB
 * image, not for tens of MB of video the user might reasonably want to
 * stop mid-transfer).
 *
 * DELIBERATELY THIN: every byte of actual decision logic (read file size
 * -> authorize -> PUT -> gate success on a real 2xx status AND a real
 * `mediaUrl` -> report progress) lives in the pure, dependency-free
 * performReelVideoUpload (reelVideoUploadCore.ts), which has no
 * expo-file-system import and so IS directly unit-testable under plain
 * Node — see that file's own top doc comment for why this split exists.
 * This function's only remaining job is to satisfy that file's own
 * `UploadAdapter` contract with the real native calls — `httpMethod:
 * 'PUT'`, `uploadType: UploadType.BINARY_CONTENT` (a raw-body PUT with no
 * multipart framing, exactly what a presigned R2 URL expects), and a
 * real file-size read via `new File(localUri).size` — which is
 * EXECUTION-UNVERIFIED in this repo's own test suite (expo-file-system's
 * native module registry only exists inside a real Expo/RN runtime) and
 * is instead verified by direct static source review — see the Step 9A
 * verification report's own "Upload-adapter contract" section for
 * exactly what was checked.
 */
export async function uploadReelVideoToR2(
  reelId: string,
  localUri: string,
  contentType: string,
  onProgress: MediaUploadProgressCallback,
  onUploadTaskReady?: (cancel: () => void) => void
): Promise<ReelVideoUploadResult> {
  return performReelVideoUpload(
    () => {
      const file = new File(localUri);
      // Captured here, populated inside `start` — `cancel` needs the SAME
      // task instance `start` creates, and performReelVideoUpload may call
      // `onUploadTaskReady` (which wires up `cancel`) before `start` ever
      // runs, so `cancel` must tolerate being called before `task` exists
      // (a no-op — nothing to cancel yet, matching every other upload
      // handle's own "safe to call even before transferring starts"
      // contract in this codebase, e.g. UploadReelVideoHandle's own doc
      // comment in reels.ts).
      let task: ReturnType<File['createUploadTask']> | null = null;
      return {
        getFileSize: () => file.size,
        start: (url, headers, onAdapterProgress) => {
          task = file.createUploadTask(url, {
            httpMethod: 'PUT',
            uploadType: UploadType.BINARY_CONTENT,
            headers,
            onProgress: ({ bytesSent, totalBytes }) => onAdapterProgress(bytesSent, totalBytes),
          });
          return task.uploadAsync();
        },
        cancel: () => task?.cancel(),
      };
    },
    (contentType, fileSizeBytes, reelId) => requestUploadAuthorization('reelVideo', contentType, fileSizeBytes, undefined, reelId).then((authorization) => ({
      uploadUrl: authorization.uploadUrl,
      contentType: authorization.contentType,
      mediaUrl: authorization.mediaUrl,
    })),
    reelId,
    contentType,
    onProgress,
    onUploadTaskReady
  );
}

/**
 * Step 10A — the real, production-wired Story-PHOTO upload path. Reuses
 * the exact same authorize-then-PUT mechanics as every other image
 * upload above (uploadDisplayableMediaToR2) — a Story photo is the same
 * size class as a Reel photo (same REEL_PHOTO_MAX_FILE_SIZE_BYTES cap,
 * see src/services/stories.ts's own createStoryDraft), so the plain
 * `fetch(localUri) -> Blob -> PUT` path already used for profile/cover/
 * thumbnail images is appropriate here too — see this function's own
 * Part 6 "reuse the existing R2 image-upload approach" instruction.
 *
 * `contentType` is passed through explicitly (unlike the other
 * uploadDisplayableMediaToR2 callers, which all hardcode 'image/jpeg')
 * because a Story photo's real MIME type can be png/webp/heic/heif too
 * (library-picked, same as a plain photo Reel — see
 * mediaUploadValidation.ts's own ALLOWED_REEL_PHOTO_CONTENT_TYPES doc
 * comment) — this must be the ACTUAL file's own type, not a guess.
 */
export async function uploadStoryImageToR2(
  storyId: string,
  localUri: string,
  contentType: string,
  onProgress: MediaUploadProgressCallback
): Promise<ProfilePhotoUploadResult> {
  return uploadDisplayableMediaToR2(
    'storyMedia',
    localUri,
    onProgress,
    'Uploaded to R2, but no public media domain is configured yet — this Story is not displayable.',
    undefined,
    undefined,
    storyId,
    contentType
  );
}

type StoryVideoUploadResult = { ok: true; mediaUrl: string } | { ok: false; message: string };

/**
 * Step 10A — the real, production-wired Story-VIDEO upload path. Reuses
 * the EXACT same native file-based upload architecture as
 * uploadReelVideoToR2 (performReelVideoUpload + expo-file-system's
 * `File.createUploadTask`) rather than the Blob-based path above — a
 * Story video is the same size class as a Reel video (up to
 * REEL_MAX_FILE_SIZE_BYTES, 50 MB), so the same "avoid fetch -> Blob for
 * large video" reasoning applies identically — see uploadReelVideoToR2's
 * own doc comment for the full investigation this reuse is based on.
 * `performReelVideoUpload`'s own `reelId` parameter is a fully opaque
 * identifier string passed straight through to `authorize` — it has no
 * Reel-specific meaning at all, so passing a `storyId` through it here is
 * not a hack, just this file's own generic orchestration doing exactly
 * what it already does for a Reel.
 */
export async function uploadStoryVideoToR2(
  storyId: string,
  localUri: string,
  contentType: string,
  onProgress: MediaUploadProgressCallback,
  onUploadTaskReady?: (cancel: () => void) => void
): Promise<StoryVideoUploadResult> {
  const result = await performReelVideoUpload(
    () => {
      const file = new File(localUri);
      let task: ReturnType<File['createUploadTask']> | null = null;
      return {
        getFileSize: () => file.size,
        start: (url, headers, onAdapterProgress) => {
          task = file.createUploadTask(url, {
            httpMethod: 'PUT',
            uploadType: UploadType.BINARY_CONTENT,
            headers,
            onProgress: ({ bytesSent, totalBytes }) => onAdapterProgress(bytesSent, totalBytes),
          });
          return task.uploadAsync();
        },
        cancel: () => task?.cancel(),
      };
    },
    (contentType, fileSizeBytes, storyId) =>
      requestUploadAuthorization('storyMedia', contentType, fileSizeBytes, undefined, undefined, storyId).then((authorization) => ({
        uploadUrl: authorization.uploadUrl,
        contentType: authorization.contentType,
        mediaUrl: authorization.mediaUrl,
      })),
    storyId,
    contentType,
    onProgress,
    onUploadTaskReady
  );
  if (!result.ok) return result;
  return { ok: true, mediaUrl: result.sourceUrl };
}

type ReelMusicUploadResult = { ok: true } | { ok: false; message: string };

/**
 * Step 10B — the real, production-wired Reel-MUSIC upload path. Reuses
 * the EXACT same native file-based upload architecture as
 * uploadReelVideoToR2/uploadStoryVideoToR2 (performReelVideoUpload +
 * expo-file-system's `File.createUploadTask`) rather than the Blob-based
 * path above — up to REEL_MUSIC_MAX_FILE_SIZE_BYTES (20 MB), the same
 * size class justification Part 6 of this step's own spec calls for.
 *
 * Unlike the video/Story-media variants, this never surfaces a
 * `mediaUrl` — a Reel's own music object has no paired public URL at all
 * (see Reel.musicStorageProvider's own doc comment, src/types/reel.ts:
 * only mux/render ever read it back, server-side, via an authenticated
 * R2 read, never a public delivery URL) — so a successful upload here
 * just reports `{ok:true}`; the caller (reels.ts's own
 * uploadReelMusicAudioViaR2) is responsible for the follow-up
 * confirmReelMusicProvider write, which persists no URL either.
 */
export async function uploadReelMusicToR2(
  reelId: string,
  localUri: string,
  contentType: string,
  onProgress: MediaUploadProgressCallback,
  onUploadTaskReady?: (cancel: () => void) => void
): Promise<ReelMusicUploadResult> {
  const result = await performReelVideoUpload(
    () => {
      const file = new File(localUri);
      let task: ReturnType<File['createUploadTask']> | null = null;
      return {
        getFileSize: () => file.size,
        start: (url, headers, onAdapterProgress) => {
          task = file.createUploadTask(url, {
            httpMethod: 'PUT',
            uploadType: UploadType.BINARY_CONTENT,
            headers,
            onProgress: ({ bytesSent, totalBytes }) => onAdapterProgress(bytesSent, totalBytes),
          });
          return task.uploadAsync();
        },
        cancel: () => task?.cancel(),
      };
    },
    (contentType, fileSizeBytes, reelId) =>
      requestUploadAuthorization('reelMusic', contentType, fileSizeBytes, undefined, reelId).then((authorization) => ({
        uploadUrl: authorization.uploadUrl,
        contentType: authorization.contentType,
        // Deliberately ignored by this function's own caller — see this
        // function's own doc comment on why a Reel's music object has no
        // real `mediaUrl` concept at all. performReelVideoUpload itself
        // still requires SOME non-null value to report success (its own
        // "never fabricate a URL" gate) — the server DOES still compute
        // one (harmlessly unused) whenever R2_PUBLIC_MEDIA_BASE_URL is
        // configured, so this only ever actually blocks an upload when
        // R2 delivery isn't configured server-side AT ALL yet, same
        // "fail closed until real infra exists" posture every other R2
        // media kind already has.
        mediaUrl: authorization.mediaUrl,
      })),
    reelId,
    contentType,
    onProgress,
    onUploadTaskReady
  );
  if (!result.ok) return result;
  return { ok: true };
}
