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
import type { SelectedReelMusic, SelectedReelThumbnail, SelectedReelVideo } from '@/types/reel';

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

// A second, independent one-shot slot for the music the user picked
// alongside the video on the same capture screen — `null` means no music
// (the ordinary case, and always the case for a library-picked video; see
// camera.tsx). Kept separate from pendingSelectedVideo rather than
// bundling them into one object so a future caller that only cares about
// the video (there is none today) isn't forced to know about music.
let pendingSelectedMusic: SelectedReelMusic | null = null;

export function setPendingSelectedMusic(music: SelectedReelMusic | null): void {
  pendingSelectedMusic = music;
}

/** Reads and clears the pending music in one step, so it's only ever consumed once. */
export function takePendingSelectedMusic(): SelectedReelMusic | null {
  const music = pendingSelectedMusic;
  pendingSelectedMusic = null;
  return music;
}

// A third one-shot slot for the cover-frame thumbnail — chosen entirely
// automatically from the video, never by the user (see camera.tsx and
// SelectedReelThumbnail's own doc comment) — unlike music, this is never
// null by the time Next is pressed: every Reel requires a real thumbnail
// (see Reel.thumbnailStoragePath's own doc comment in src/types/reel.ts).
let pendingSelectedThumbnail: SelectedReelThumbnail | null = null;

export function setPendingSelectedThumbnail(thumbnail: SelectedReelThumbnail | null): void {
  pendingSelectedThumbnail = thumbnail;
}

/** Reads and clears the pending thumbnail in one step, so it's only ever consumed once. */
export function takePendingSelectedThumbnail(): SelectedReelThumbnail | null {
  const thumbnail = pendingSelectedThumbnail;
  pendingSelectedThumbnail = null;
  return thumbnail;
}
