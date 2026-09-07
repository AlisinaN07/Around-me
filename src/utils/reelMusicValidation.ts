/**
 * Shared validation for a SelectedReelMusic (src/types/reel.ts) — same
 * "no fabricated metadata, reject rather than guess" reasoning and the
 * exact same limits Firestore/Storage Rules independently re-validate on
 * create (see firestore.rules, storage.rules, and src/services/reels.ts)
 * as reelVideoValidation.ts already applies to SelectedReelVideo.
 */

import { REEL_MUSIC_MAX_DURATION_MS, REEL_MUSIC_MAX_FILE_SIZE_BYTES, type SelectedReelMusic } from '@/types/reel';

export type ReelMusicValidationResult = { ok: true } | { ok: false; message: string };

export function validateSelectedReelMusic(music: SelectedReelMusic): ReelMusicValidationResult {
  if (!music.mimeType || !music.mimeType.startsWith('audio/')) {
    return { ok: false, message: 'That file type is not a supported audio file.' };
  }
  if (music.fileSizeBytes <= 0) {
    return { ok: false, message: "Couldn't determine this audio file's size — try a different file." };
  }
  if (music.fileSizeBytes > REEL_MUSIC_MAX_FILE_SIZE_BYTES) {
    return { ok: false, message: 'Audio file must be under 20 MB.' };
  }
  if (music.durationMs === null || music.durationMs <= 0) {
    return { ok: false, message: "Couldn't determine this audio file's length — try a different file." };
  }
  if (music.durationMs > REEL_MUSIC_MAX_DURATION_MS) {
    return { ok: false, message: 'Audio file must be 10 minutes or shorter.' };
  }
  return { ok: true };
}
