/**
 * Shared validation for a SelectedReelVideo (src/types/reel.ts), reused by
 * both the camera and library selection paths in
 * src/app/(app)/create/reel/index.tsx — one validation implementation,
 * never duplicated per source. These are the exact same limits Firestore
 * Rules independently re-validate on create (see firestore.rules and
 * src/services/reels.ts) — this function exists so the UI can reject an
 * invalid selection before ever attempting an upload, not as a substitute
 * for that server-side check.
 */

import { REEL_MAX_DURATION_MS, REEL_MAX_FILE_SIZE_BYTES, type SelectedReelVideo } from '@/types/reel';

export type ReelVideoValidationResult = { ok: true } | { ok: false; message: string };

/**
 * Only validates fields that are already known (non-null). Callers are
 * responsible for ensuring every field is resolved (real, not fabricated)
 * before treating a `{ ok: true }` result as "safe to publish" — see
 * resolveCameraVideoMetadata for how camera-sourced videos fill in the
 * fields expo-camera's recordAsync() doesn't return.
 */
export function validateSelectedReelVideo(video: SelectedReelVideo): ReelVideoValidationResult {
  if (!video.mimeType || !video.mimeType.startsWith('video/')) {
    return { ok: false, message: 'That file type is not a supported video.' };
  }
  if (video.fileSizeBytes === null || video.fileSizeBytes <= 0) {
    return { ok: false, message: "Couldn't determine this video's file size — try a different video." };
  }
  if (video.fileSizeBytes > REEL_MAX_FILE_SIZE_BYTES) {
    return { ok: false, message: 'Video must be under 50 MB.' };
  }
  if (video.durationMs === null || video.durationMs <= 0) {
    return { ok: false, message: "Couldn't determine this video's length — try a different video." };
  }
  if (video.durationMs > REEL_MAX_DURATION_MS) {
    return { ok: false, message: 'Video must be 60 seconds or shorter.' };
  }
  if (!video.width || !video.height) {
    return { ok: false, message: "Couldn't read this video's dimensions — try a different video." };
  }
  return { ok: true };
}
