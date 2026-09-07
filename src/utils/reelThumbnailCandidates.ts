/**
 * Extracts a handful of real still frames from a recorded/picked Reel
 * video, for the camera screen's automatic cover-frame selection (see
 * camera.tsx's `handleNext`, which always uses the middle candidate —
 * there is no cover picker shown to the user) — never a generic
 * placeholder, always an actual moment from that exact video.
 *
 * Uses `expo-video-thumbnails` (still present and functional in this
 * Expo SDK, just marked deprecated in favor of `expo-video`'s newer
 * `VideoPlayer.generateThumbnailsAsync`) rather than the newer API: the
 * newer one returns a native image reference (`VideoThumbnail`, a
 * `SharedRef`) that itself still needs `expo-image-manipulator` to turn
 * into a real, uploadable file — an extra dependency and conversion step
 * for no behavioral difference here. `getThumbnailAsync` returns a ready
 * local file URI directly, which is exactly what uploadReelThumbnail
 * (src/services/reels.ts) needs. Revisit if a future SDK actually removes
 * expo-video-thumbnails.
 */
import * as VideoThumbnails from 'expo-video-thumbnails';

// Evenly spread across the middle of the clip, never the very first or
// last instant (often blurry/mid-motion right as recording starts or
// stops) — see the "clean and steady" framing goal this exists for.
const CANDIDATE_FRACTIONS = [0.15, 0.35, 0.5, 0.65, 0.85];
const THUMBNAIL_QUALITY = 0.85;

export type ReelThumbnailCandidate = {
  uri: string;
  width: number;
  height: number;
  /** The exact point in the video (ms) this frame was taken from — not shown in the UI today, kept for potential future use (e.g. re-deriving mimeType-free metadata). */
  timeMs: number;
};

/**
 * Real frames only: a candidate whose extraction fails (e.g. a time past
 * a slightly-shorter-than-declared file) is silently dropped rather than
 * substituted with anything fabricated — callers may end up with fewer
 * than `CANDIDATE_FRACTIONS.length` results, or in the worst case none —
 * camera.tsx's `handleNext` treats an empty result as a real failure
 * (shows an error rather than publishing with no cover) rather than ever
 * gating the button itself on this having already resolved.
 */
export async function generateReelThumbnailCandidates(videoUri: string, durationMs: number): Promise<ReelThumbnailCandidate[]> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [];

  const times = CANDIDATE_FRACTIONS.map((fraction) => Math.round(durationMs * fraction));
  const settled = await Promise.allSettled(
    times.map((timeMs) => VideoThumbnails.getThumbnailAsync(videoUri, { time: timeMs, quality: THUMBNAIL_QUALITY }))
  );

  const candidates: ReelThumbnailCandidate[] = [];
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      candidates.push({ uri: result.value.uri, width: result.value.width, height: result.value.height, timeMs: times[index] });
    }
  });
  return candidates;
}
