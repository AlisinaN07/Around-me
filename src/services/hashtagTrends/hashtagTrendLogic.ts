/**
 * The pure, Firestore-free half of Trending Hashtags — same "no Firebase
 * imports at all" split this codebase's other scoring subsystems already
 * follow (profileLogic.ts, hashtagInterestLogic.ts) so
 * tests/hashtagTrend.test.ts can exercise the real math directly under
 * plain tsx. hashtagTrendService.ts imports this file and adds the actual
 * Firestore read on top.
 *
 * Deliberately independent of src/services/recommendations/ entirely —
 * trending and personalized For You ranking are separate concepts (this
 * feature's own spec, Steps 32/33); nothing here is imported by, or
 * imports from, the recommendation engine.
 */
import type { CityHashtagTrendEngagementEvent, CityHashtagTrendPost } from '@/types/hashtagTrend';

import { TREND_CREATOR_DIVERSITY_FLOOR, TREND_MAX_COUNTED_POSTS_PER_CREATOR, TREND_MIN_RECENT_POSTS, TREND_SCORE_WEIGHTS } from './hashtagTrendConfig';

/**
 * The RAW (never anti-spam-adjusted) count of posts within [nowMs -
 * windowMs, nowMs] — Step 29's own "honest metric" instruction: this is
 * what a UI actually DISPLAYS next to a trend ("48 posts today"), kept
 * completely separate from the scoring-only effective count below (which
 * exists purely to resist spam, never to mislead about real volume).
 */
export function countRawRecentPosts(recentPosts: readonly CityHashtagTrendPost[], windowMs: number, nowMs: number): number {
  const windowStart = nowMs - windowMs;
  let count = 0;
  for (const post of recentPosts) {
    if (post.atMs >= windowStart && post.atMs <= nowMs) count += 1;
  }
  return count;
}

/**
 * Anti-spam-adjusted post count (Step 21) — the same raw window filter as
 * countRawRecentPosts, but a single creator's own posts stop adding
 * further count past TREND_MAX_COUNTED_POSTS_PER_CREATOR. Order-
 * independent (a Map keyed by creatorUid, not "first K by array
 * position") so re-ordering the same set of posts never changes the
 * result — determinism (Step 37's own explicit requirement).
 */
function countEffectivePosts(posts: readonly CityHashtagTrendPost[]): number {
  const perCreatorCounts = new Map<string, number>();
  let effectiveCount = 0;
  for (const post of posts) {
    const current = perCreatorCounts.get(post.creatorUid) ?? 0;
    if (current < TREND_MAX_COUNTED_POSTS_PER_CREATOR) {
      effectiveCount += 1;
      perCreatorCounts.set(post.creatorUid, current + 1);
    } else {
      perCreatorCounts.set(post.creatorUid, current + 1); // still tracked, just no longer counted — keeps the Map's own bookkeeping simple/uniform
    }
  }
  return effectiveCount;
}

export type TrendScoreInput = {
  /** Anti-spam-adjusted count of posts in the CURRENT window — see countEffectivePosts. */
  recentPostCount: number;
  /** The SAME anti-spam-adjusted count, but for the immediately-preceding, equal-length comparison period — the velocity baseline (Step 18). */
  previousPostCount: number;
  /** Distinct creatorUids among the current window's RAW posts (not anti-spam-capped — the whole point of this number is to measure genuine diversity, so capping it would defeat its own purpose). */
  uniqueCreatorCount: number;
  /** Net weighted engagement (likes/comments/saves/shares/completions/rewatches, signed — see functions/src/hashtagTrends.ts) within the current window. Can be 0 for a hashtag that's only ever been posted, never engaged with yet — a valid, scoreable state, not an error. */
  recentEngagementWeighted: number;
};

/**
 * Derives every input scoreHashtagTrend needs, purely from one document's
 * raw (bounded, capped, newest-first) arrays plus a window length and
 * "now" — never touches Firestore, never assumes anything about how
 * those arrays got there. `windowMs` doubles as both the current window's
 * own length AND the length of the comparison period immediately before
 * it (Step 18's own literal example: "posts previous comparable period"
 * — i.e. an equal-length prior window, not a different, arbitrary
 * baseline).
 */
export function deriveTrendScoreInput(
  recentPosts: readonly CityHashtagTrendPost[],
  recentEngagement: readonly CityHashtagTrendEngagementEvent[],
  windowMs: number,
  nowMs: number
): TrendScoreInput {
  const windowStart = nowMs - windowMs;
  const previousWindowStart = nowMs - windowMs * 2;

  const currentPosts = recentPosts.filter((post) => post.atMs >= windowStart && post.atMs <= nowMs);
  const previousPosts = recentPosts.filter((post) => post.atMs >= previousWindowStart && post.atMs < windowStart);

  const recentEngagementWeighted = recentEngagement
    .filter((event) => event.atMs >= windowStart && event.atMs <= nowMs)
    .reduce((sum, event) => sum + event.weight, 0);

  return {
    recentPostCount: countEffectivePosts(currentPosts),
    previousPostCount: countEffectivePosts(previousPosts),
    uniqueCreatorCount: new Set(currentPosts.map((post) => post.creatorUid)).size,
    recentEngagementWeighted,
  };
}

/**
 * The pure trend score — deterministic, Firestore-free, bounded to
 * [0, 1). Zero for anything below TREND_MIN_RECENT_POSTS (Step 19's own
 * "one isolated post must not become a major trend" instruction) —
 * checked FIRST, before any other math runs, so a barely-active hashtag
 * is excluded outright rather than merely scored low.
 *
 * Otherwise: three saturating (log1p) components —
 *   - postsComponent: recent volume, log-scaled so 10 -> 100 -> 10,000
 *     posts is a shrinking, not linear, jump in contribution (Step 17).
 *   - engagementComponent: net weighted engagement, same log scaling,
 *     clamped at 0 first (a hashtag whose recent activity is net-negative
 *     engagement — e.g. a wave of unlikes — contributes nothing extra
 *     here rather than an unstable/negative log1p input).
 *   - velocityComponent: log1p of the ratio between this window's
 *     effective post count and the immediately-preceding one, EACH
 *     with a +1 Laplace-style smoothing term added before dividing (Step
 *     18's own "avoid division-by-zero explosions" instruction) — 3
 *     posts growing from a previous 0 becomes (3+1)/(0+1)=4, a strong
 *     but finite ratio, never an actual divide-by-zero or an unbounded
 *     spike; a stagnant 500 -> 510 becomes (510+1)/(500+1)≈1.02, barely
 *     above the "no change" baseline of 1.
 * Weighted-summed (TREND_SCORE_WEIGHTS — velocity weighted heaviest, see
 * that config's own doc comment), then scaled by a creator-diversity
 * multiplier (Step 14/21: uniqueCreatorCount / recentPostCount, floored
 * at TREND_CREATOR_DIVERSITY_FLOOR rather than ever reaching 0) so one
 * account posting the same tag repeatedly can inflate raw post/engagement
 * counts but never reach the same score real distinct local interest
 * would. Finally mapped through `1 - e^-x` — a smooth, monotonic
 * saturation into [0, 1) that can never explode however large the raw
 * inputs get (Step 17's own explicit requirement), reusing the exact
 * same "large inputs, bounded comparable output" INTENT as ranking.ts's
 * own `sigmoid` helper without importing it (Step: keep trending fully
 * independent of the recommendation engine's own module).
 */
export function scoreHashtagTrend(input: TrendScoreInput): number {
  if (input.recentPostCount < TREND_MIN_RECENT_POSTS) return 0;

  const postsComponent = Math.log1p(input.recentPostCount);
  const engagementComponent = Math.log1p(Math.max(0, input.recentEngagementWeighted));
  const velocityRatio = (input.recentPostCount + 1) / (input.previousPostCount + 1);
  const velocityComponent = Math.log1p(velocityRatio);

  const creatorDiversityRatio = input.recentPostCount > 0 ? Math.min(1, input.uniqueCreatorCount / input.recentPostCount) : 0;
  const spamMultiplier = TREND_CREATOR_DIVERSITY_FLOOR + (1 - TREND_CREATOR_DIVERSITY_FLOOR) * creatorDiversityRatio;

  const raw =
    (postsComponent * TREND_SCORE_WEIGHTS.posts + engagementComponent * TREND_SCORE_WEIGHTS.engagement + velocityComponent * TREND_SCORE_WEIGHTS.velocity) *
    spamMultiplier;

  return 1 - Math.exp(-Math.max(0, raw));
}
