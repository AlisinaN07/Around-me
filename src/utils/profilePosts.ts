import type { PostContent } from '@/types/content';
import type { Reel } from '@/types/reel';

/**
 * One item in a Profile's unified Posts tab (Step 41.2C) — either a
 * published video Post (technically a Reel) or a legacy text Post
 * (content/{contentId}, type == 'post'). Both types keep rendering through
 * their own existing card/detail components; this is purely a display-
 * layer merge, never a data-model unification.
 */
export type ProfilePostItem =
  | { kind: 'reel'; sortMs: number; reel: Reel }
  | { kind: 'text'; sortMs: number; content: PostContent };

/**
 * Merges an author's already-fetched, already-bounded video Posts and
 * legacy text Posts into one reverse-chronological list. Never queries
 * anything itself — both inputs come from their own separate bounded
 * fetches (fetchProfileReels, and the caller's own type=='post' filter
 * over fetchPublicUserContent's result), so the merged list's size is
 * simply the sum of two already-bounded sources, never unbounded.
 *
 * Sort key: a published Reel's `publishedAt` (the moment it actually
 * became visible — matches the same field every other Reel feed sorts
 * by), falling back to `createdAt` only for the theoretical case of a
 * published Reel missing it. A legacy text Post has no separate
 * "published at" concept, so its `createdAt` is the canonical timestamp.
 */
export function mergeProfilePosts(reels: Reel[], textPosts: PostContent[]): ProfilePostItem[] {
  const reelItems: ProfilePostItem[] = reels.map((reel) => ({
    kind: 'reel',
    sortMs: (reel.publishedAt ?? reel.createdAt).toMillis(),
    reel,
  }));
  const textItems: ProfilePostItem[] = textPosts.map((content) => ({
    kind: 'text',
    sortMs: content.createdAt.toMillis(),
    content,
  }));
  return [...reelItems, ...textItems].sort((a, b) => b.sortMs - a.sortMs);
}
