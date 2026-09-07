/**
 * Fills in the metadata expo-document-picker doesn't return for a picked
 * audio file (just a uri/name/size — no duration; see
 * src/app/(app)/create/reel/camera.tsx's music picker). Mirrors
 * resolveCameraVideoMetadata's exact probe-with-timeout pattern: real
 * values only, never fabricated — if the player can't determine the
 * duration before the timeout, this resolves to null and the caller must
 * reject the pick rather than invent a number (same "no fabricated
 * metadata" rule as camera-recorded video).
 *
 * Uses `createAudioPlayer` (the non-hook, manually-released player
 * constructor — see expo-audio's own docs) rather than `useAudioPlayer`
 * because this runs as a one-shot async probe outside of a component's
 * render, not as a player a screen keeps around.
 */
import { createAudioPlayer } from 'expo-audio';

const PROBE_TIMEOUT_MS = 8000;

export async function resolveAudioDurationMs(uri: string): Promise<number | null> {
  const player = createAudioPlayer(uri);

  try {
    return await new Promise<number | null>((resolve) => {
      let settled = false;

      const finish = (result: number | null) => {
        if (settled) return;
        settled = true;
        subscription.remove();
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);

      // playbackStatusUpdate fires repeatedly (see AudioPlayerOptions'
      // updateInterval) — the first one carrying a real, loaded duration
      // is what this probe is waiting for.
      const subscription = player.addListener('playbackStatusUpdate', (status) => {
        if (!status.isLoaded || !status.duration || status.duration <= 0) return;
        finish(Math.round(status.duration * 1000));
      });
    });
  } finally {
    player.remove();
  }
}
