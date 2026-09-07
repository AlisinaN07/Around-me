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
export type SavedTargetType = 'reel' | 'post';

export type SavedPost = {
  targetType: SavedTargetType;
  targetId: string;
  savedAt: Timestamp;
};
