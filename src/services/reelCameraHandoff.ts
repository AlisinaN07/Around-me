/**
 * A tiny, module-level handoff for exactly one value: the fully-resolved
 * `SelectedReelVideo` a user picked or recorded on the capture/preview
 * screen (src/app/(app)/create/reel/camera.tsx — Step 41.2D.1's Stage 1/2),
 * passed forward to the caption/category/publish screen
 * (src/app/(app)/create/reel/index.tsx — Stage 3) when the user taps Next.
 *
 * This exists purely because Expo Router's params are meant for
 * serializable route state, not for handing an ephemeral local-file URI
 * (plus its resolved metadata) to a freshly-pushed screen instance — a
 * `router.push('/create/reel')` plus this module-level value, read once on
 * mount, is the simplest correct fit for a single ephemeral in-memory
 * handoff — no new state-management dependency needed for one value.
 */
import type { SelectedReelVideo } from '@/types/reel';

let pendingSelectedVideo: SelectedReelVideo | null = null;

export function setPendingSelectedVideo(video: SelectedReelVideo): void {
  pendingSelectedVideo = video;
}

/** Reads and clears the pending video in one step, so it's only ever consumed once. */
export function takePendingSelectedVideo(): SelectedReelVideo | null {
  const video = pendingSelectedVideo;
  pendingSelectedVideo = null;
  return video;
}
