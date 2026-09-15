import type { Timestamp } from 'firebase/firestore';

/**
 * users/{uid}/saved/{savedId} — Step 41.2E. A private bookmark: a
 * reference to another account's Post (never a snapshot). `savedId` is
 * always the deterministic `${targetType}_${targetId}` (see
 * src/services/saved.ts), so one save relationship can ever exist per
 * user/Post pair — never two Saved docs pointing at the same target.
 *
 * Deliberately carries no denormalized caption/body/username/displayName/
 * media URL/like count/author metadata — Saved always resolves the real,
 * current original document at read time (see fetchSavedPosts), so it can
 * never go stale or leak a deleted/edited Post's old content.
 */
/**
 * 'sound' (see Reel.musicHash's own doc comment in src/types/reel.ts) is
 * a saved SOUND, not a saved Post — its `targetId` is a musicHash, not a
 * reelId/contentId. Resolved for display in fetchSavedPosts (src/services/saved.ts)
 * via whichever Reel is currently the oldest published one sharing that
 * hash, since there is no separate client-readable "sound" document to
 * show details from (soundOrigins/{musicHash} is server-only).
 */
export type SavedTargetType = 'reel' | 'post' | 'sound';

export type SavedPost = {
  targetType: SavedTargetType;
  targetId: string;
  savedAt: Timestamp;
};
