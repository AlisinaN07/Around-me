/**
 * Fills in the metadata expo-camera's recordAsync() doesn't return (see
 * src/app/(app)/create/reel/camera.tsx — it resolves to only `{ uri }`,
 * unlike expo-image-picker's library assets which already carry
 * duration/width/height). Real values only, never fabricated: if the
 * player can't determine them before the timeout, this resolves to null
 * and the caller must block publishing rather than invent a number (see
 * the Step 20 spec's explicit "no fabricated metadata" requirement).
 *
 * Uses `createVideoPlayer` (the non-hook, manually-released player
 * constructor — see expo-video's own docs) rather than `useVideoPlayer`
 * because this runs as a one-shot async probe outside of a component's
 * render, not as a player a screen keeps around.
 */
import { createVideoPlayer } from 'expo-video';

export type ResolvedCameraVideoMetadata = {
  durationMs: number;
  width: number;
  height: number;
};

const PROBE_TIMEOUT_MS = 8000;

export async function resolveCameraVideoMetadata(uri: string): Promise<ResolvedCameraVideoMetadata | null> {
  const player = createVideoPlayer(uri);

  try {
    return await new Promise<ResolvedCameraVideoMetadata | null>((resolve) => {
      let settled = false;

      const finish = (result: ResolvedCameraVideoMetadata | null) => {
        if (settled) return;
        settled = true;
        subscription.remove();
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);

      // sourceLoad bundles duration (seconds) and the loaded video's own
      // tracks (which carry pixel size) in one event — the two pieces of
      // metadata this probe needs, from the one event that means "this
      // source has actually finished loading enough to know them."
      const subscription = player.addListener('sourceLoad', ({ duration, availableVideoTracks }) => {
        const track = availableVideoTracks[0];
        if (!duration || duration <= 0 || !track || !track.size.width || !track.size.height) {
          finish(null);
          return;
        }
        finish({
          durationMs: Math.round(duration * 1000),
          width: track.size.width,
          height: track.size.height,
        });
      });
    });
  } finally {
    player.release();
  }
}
