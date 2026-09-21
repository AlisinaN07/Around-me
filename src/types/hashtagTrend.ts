import type { Timestamp } from 'firebase/firestore';

/**
 * cityHashtagTrends/{cityId}__{hashtag} — trusted, server-aggregated
 * city-level hashtag activity (see functions/src/hashtagTrends.ts for the
 * full write-side design). NEVER client-writable — see firestore.rules'
 * own `match /cityHashtagTrends/{docId}` (`allow write: if false`
 * unconditionally; only the Admin SDK, bypassing Rules via IAM, ever
 * writes here).
 *
 * Deliberately NO stored trend score, `posts24h`, or any other
 * time-window-derived number — both arrays below are the raw (bounded,
 * capped, newest-first) material a window count/velocity/score is always
 * DERIVED from at READ time (see src/services/hashtagTrends/
 * hashtagTrendLogic.ts), never pre-computed and stored. This is what lets
 * "24h ago" mean the SAME thing whether this document was last written a
 * minute ago or three days ago, with no scheduled recompute/decay job
 * needed to keep it honest.
 */
export type CityHashtagTrendPost = {
  reelId: string;
  /** Epoch ms — a plain number (not a Firestore Timestamp) since this lives inside an array, and array elements can't be individually queried/ordered by Firestore anyway; only ever read back client-side for window filtering. */
  atMs: number;
  creatorUid: string;
};

export type CityHashtagTrendEngagementEvent = {
  atMs: number;
  /** Positive for a new like/comment/save/share/completion/rewatch; negative for its reversal (an unlike, an unsave, ...) — see functions/src/hashtagTrends.ts's computeWeightedTrendEngagement. Summing every entry's weight within a window gives that window's net engagement, reversals included. */
  weight: number;
};

export type CityHashtagTrend = {
  /** Canonical city key — the SAME `cityKey` every Reel/BrowseScope already uses (src/types/reel.ts, src/types/browseScope.ts) — never a second city representation. */
  cityId: string;
  /** Canonical lowercase hashtag name — same convention as hashtags/{hashtagId} (src/types/hashtag.ts). */
  hashtag: string;
  /** Bounded, newest-first, capped at TREND_RECENT_POST_CAP (functions/src/hashtagTrends.ts) — one entry per Reel-publish contribution, removed again (where still present) if that Reel is later deleted. */
  recentPosts: CityHashtagTrendPost[];
  /** Bounded, newest-first, capped at TREND_RECENT_ENGAGEMENT_CAP. */
  recentEngagement: CityHashtagTrendEngagementEvent[];
  /** Server timestamp of the most recent real contribution (a publish OR an engagement change — never bumped by a delete/removal) — what getTrendingHashtagsForCity's own bounded candidate query orders/filters by. */
  lastActivityAt: Timestamp;
  updatedAt: Timestamp;
};

/** getTrendingHashtagsForCity's own public return shape — internal aggregation documents and the trend score's own internal numeric value are never exposed beyond this (Step 30's own "trend score is internal" instruction). */
export type TrendingHashtag = {
  hashtag: string;
  /** An HONEST, window-scoped count (Step 29's own instruction) — e.g. "48" meaning 48 posts in the requested window, never a lifetime postCount mislabeled as a trend figure. */
  recentPostCount: number;
};
