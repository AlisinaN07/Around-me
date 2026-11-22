/**
 * Lightweight unit-level tests for Trending Hashtags by City and Time
 * Window — run via:
 *   npx tsx tests/hashtagTrend.test.ts
 * Same plain assert()/check() convention as the other hashtag test files.
 *
 * Covers the pure scoring math (hashtagTrendLogic.ts) directly — no
 * Firestore, no Cloud Functions runtime. hashtagTrendService.ts's own
 * Firestore query/cache is NOT unit-tested here, same "no live-Firestore
 * unit test" convention as every other Firestore-touching function in
 * this codebase (see tests/hashtagPage.test.ts's own doc comment for the
 * fuller rationale) — its query shape (bounded, city-scoped, ordered by
 * lastActivityAt) and limit-clamping are instead verified directly by
 * reading hashtagTrendService.ts's own source in this feature's final
 * report, plus TypeScript itself enforcing the return/option shapes.
 */
import { countRawRecentPosts, deriveTrendScoreInput, scoreHashtagTrend, type TrendScoreInput } from '../src/services/hashtagTrends/hashtagTrendLogic';
import { TREND_MAX_COUNTED_POSTS_PER_CREATOR, TREND_MIN_RECENT_POSTS, TREND_WINDOW_MS } from '../src/services/hashtagTrends/hashtagTrendConfig';
import type { CityHashtagTrendEngagementEvent, CityHashtagTrendPost } from '../src/types/hashtagTrend';

const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `Expected truthy value, got ${String(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  },
  greater(actual: number, expected: number, message?: string): void {
    if (!(actual > expected)) throw new Error(message ?? `Expected ${actual} > ${expected}`);
  },
};

const results: { name: string; pass: boolean; error?: unknown }[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const NOW = Date.now();
const WINDOW_MS = TREND_WINDOW_MS['24h'];

function post(reelId: string, hoursAgo: number, creatorUid = `creator-${reelId}`): CityHashtagTrendPost {
  return { reelId, atMs: NOW - hoursAgo * 60 * 60 * 1000, creatorUid };
}

function engagement(hoursAgo: number, weight: number): CityHashtagTrendEngagementEvent {
  return { atMs: NOW - hoursAgo * 60 * 60 * 1000, weight };
}

function makeInput(overrides: Partial<TrendScoreInput> = {}): TrendScoreInput {
  return { recentPostCount: 0, previousPostCount: 0, uniqueCreatorCount: 0, recentEngagementWeighted: 0, ...overrides };
}

// --- No activity ---

check('scoreHashtagTrend: no activity at all returns exactly 0', () => {
  assert.equal(scoreHashtagTrend(makeInput()), 0);
});

check('scoreHashtagTrend: below TREND_MIN_RECENT_POSTS returns exactly 0, even with strong engagement', () => {
  const score = scoreHashtagTrend(
    makeInput({ recentPostCount: TREND_MIN_RECENT_POSTS - 1, uniqueCreatorCount: TREND_MIN_RECENT_POSTS - 1, recentEngagementWeighted: 500 })
  );
  assert.equal(score, 0);
});

// --- More recent posts increase score ---

check('scoreHashtagTrend: more recent posts (same everything else) increases the score', () => {
  const fewer = scoreHashtagTrend(makeInput({ recentPostCount: TREND_MIN_RECENT_POSTS, previousPostCount: TREND_MIN_RECENT_POSTS, uniqueCreatorCount: TREND_MIN_RECENT_POSTS }));
  const more = scoreHashtagTrend(makeInput({ recentPostCount: TREND_MIN_RECENT_POSTS * 4, previousPostCount: TREND_MIN_RECENT_POSTS, uniqueCreatorCount: TREND_MIN_RECENT_POSTS * 4 }));
  assert.greater(more, fewer);
});

// --- Engagement ---

check('scoreHashtagTrend: equivalent post volume with stronger engagement scores higher', () => {
  const base = { recentPostCount: 10, previousPostCount: 10, uniqueCreatorCount: 10 };
  const weakEngagement = scoreHashtagTrend(makeInput({ ...base, recentEngagementWeighted: 2 }));
  const strongEngagement = scoreHashtagTrend(makeInput({ ...base, recentEngagementWeighted: 200 }));
  assert.greater(strongEngagement, weakEngagement);
});

check('scoreHashtagTrend: net-negative engagement (a wave of unlikes) never produces a negative or NaN score', () => {
  const score = scoreHashtagTrend(makeInput({ recentPostCount: 5, previousPostCount: 5, uniqueCreatorCount: 5, recentEngagementWeighted: -50 }));
  assert.ok(Number.isFinite(score) && score >= 0, `Expected a finite, non-negative score, got ${score}`);
});

// --- Velocity ---

check('scoreHashtagTrend: a rapidly accelerating smaller hashtag can outrank a stagnant larger one — the spec\'s own worked example', () => {
  // Hashtag A: previous 3 -> current 30 (rapid growth from a small base).
  const rapidlyAccelerating = scoreHashtagTrend(makeInput({ recentPostCount: 30, previousPostCount: 3, uniqueCreatorCount: 25, recentEngagementWeighted: 20 }));
  // Hashtag B: previous 500 -> current 510 (much larger, but stagnant).
  const stagnantButLarger = scoreHashtagTrend(makeInput({ recentPostCount: 510, previousPostCount: 500, uniqueCreatorCount: 25, recentEngagementWeighted: 20 }));
  assert.greater(rapidlyAccelerating, stagnantButLarger, `Expected the rapidly-accelerating hashtag (${rapidlyAccelerating}) to outrank the stagnant, larger one (${stagnantButLarger})`);
});

check('scoreHashtagTrend: zero baseline (growth from 0) stays finite and stable, no division-by-zero explosion', () => {
  const score = scoreHashtagTrend(makeInput({ recentPostCount: 10, previousPostCount: 0, uniqueCreatorCount: 8, recentEngagementWeighted: 5 }));
  assert.ok(Number.isFinite(score), `Expected a finite score, got ${score}`);
  assert.ok(score > 0 && score < 1, `Expected a bounded (0,1) score, got ${score}`);
});

check('scoreHashtagTrend: growth is rewarded over stagnation even at equal current volume', () => {
  const growing = scoreHashtagTrend(makeInput({ recentPostCount: 20, previousPostCount: 5, uniqueCreatorCount: 15 }));
  const stagnant = scoreHashtagTrend(makeInput({ recentPostCount: 20, previousPostCount: 20, uniqueCreatorCount: 15 }));
  assert.greater(growing, stagnant);
});

// --- Huge values ---

check('scoreHashtagTrend: huge post/engagement values never explode past the [0,1] bound', () => {
  // At truly extreme inputs, 1 - e^-x floating-point-saturates to exactly
  // 1 (e^-x underflows to 0) rather than mathematically exceeding it —
  // still a hard, bounded ceiling (never > 1, never NaN/Infinity), just
  // not strictly < 1 at this scale. The real "does not explode" property
  // is verified below by comparing against a moderate input instead.
  const score = scoreHashtagTrend(makeInput({ recentPostCount: 1_000_000, previousPostCount: 1, uniqueCreatorCount: 1_000_000, recentEngagementWeighted: 10_000_000 }));
  assert.ok(Number.isFinite(score) && score <= 1 && score >= 0, `Expected a bounded [0,1] score, got ${score}`);
});

check('scoreHashtagTrend: 10,000 posts is not literally 1,000x more important than 10 (saturating, not linear)', () => {
  const ten = scoreHashtagTrend(makeInput({ recentPostCount: 10, previousPostCount: 10, uniqueCreatorCount: 10 }));
  const tenThousand = scoreHashtagTrend(makeInput({ recentPostCount: 10_000, previousPostCount: 10_000, uniqueCreatorCount: 10_000 }));
  assert.ok(tenThousand < ten * 1000, `Expected saturating growth, not linear: ten=${ten}, tenThousand=${tenThousand}`);
});

// --- Minimum floor ---

check('scoreHashtagTrend: one isolated post going from 0 to 1 does not incorrectly become a major trend', () => {
  const score = scoreHashtagTrend(makeInput({ recentPostCount: 1, previousPostCount: 0, uniqueCreatorCount: 1 }));
  assert.equal(score, 0, 'A single post must not clear TREND_MIN_RECENT_POSTS');
});

// --- Determinism ---

check('scoreHashtagTrend: the same inputs always produce the same result', () => {
  const input = makeInput({ recentPostCount: 15, previousPostCount: 5, uniqueCreatorCount: 12, recentEngagementWeighted: 40 });
  const a = scoreHashtagTrend(input);
  const b = scoreHashtagTrend(input);
  const c = scoreHashtagTrend(input);
  assert.equal(a, b);
  assert.equal(b, c);
});

// --- Anti-spam (Step 21) ---

check('scoreHashtagTrend: 50 posts from 1 creator scores lower than 50 posts from 40 creators, all else equal', () => {
  const singleCreator = scoreHashtagTrend(makeInput({ recentPostCount: 50, previousPostCount: 50, uniqueCreatorCount: 1, recentEngagementWeighted: 10 }));
  const manyCreators = scoreHashtagTrend(makeInput({ recentPostCount: 50, previousPostCount: 50, uniqueCreatorCount: 40, recentEngagementWeighted: 10 }));
  assert.greater(manyCreators, singleCreator, `Expected the diverse-creator hashtag (${manyCreators}) to outscore the single-creator one (${singleCreator})`);
});

check('scoreHashtagTrend: a single-creator spam hashtag is suppressed, never fully zeroed (a real early local moment isn\'t erased outright)', () => {
  const score = scoreHashtagTrend(makeInput({ recentPostCount: 50, previousPostCount: 5, uniqueCreatorCount: 1, recentEngagementWeighted: 10 }));
  assert.greater(score, 0, 'Expected a suppressed but non-zero score');
});

// --- deriveTrendScoreInput (raw arrays -> scoring input) ---

check('deriveTrendScoreInput: only counts posts within the requested window', () => {
  const posts = [post('a', 1), post('b', 5), post('c', 30)]; // 30h ago is outside a 24h window
  const input = deriveTrendScoreInput(posts, [], WINDOW_MS, NOW);
  assert.equal(input.recentPostCount, 2);
});

check('deriveTrendScoreInput: previousPostCount is the equal-length PRIOR period, not the whole history', () => {
  const posts = [post('a', 2), post('b', 30), post('c', 40)]; // 30h/40h ago fall in the [24h,48h) previous window
  const input = deriveTrendScoreInput(posts, [], WINDOW_MS, NOW);
  assert.equal(input.recentPostCount, 1);
  assert.equal(input.previousPostCount, 2);
});

check('deriveTrendScoreInput: uniqueCreatorCount counts distinct creators within the window, uncapped by the anti-spam limit', () => {
  const posts = [post('a', 1, 'same-creator'), post('b', 2, 'same-creator'), post('c', 3, 'same-creator'), post('d', 4, 'same-creator'), post('e', 5, 'another-creator')];
  const input = deriveTrendScoreInput(posts, [], WINDOW_MS, NOW);
  assert.equal(input.uniqueCreatorCount, 2);
});

check(`deriveTrendScoreInput: a single creator's own posts stop counting toward recentPostCount past TREND_MAX_COUNTED_POSTS_PER_CREATOR (${TREND_MAX_COUNTED_POSTS_PER_CREATOR})`, () => {
  const posts = Array.from({ length: 10 }, (_, i) => post(`r${i}`, 1, 'spammer'));
  const input = deriveTrendScoreInput(posts, [], WINDOW_MS, NOW);
  assert.equal(input.recentPostCount, TREND_MAX_COUNTED_POSTS_PER_CREATOR);
});

check('deriveTrendScoreInput: sums signed engagement weights within the window, including reversals', () => {
  const events = [engagement(1, 10), engagement(2, -3), engagement(30, 100)]; // 30h ago is outside the window
  const input = deriveTrendScoreInput([], events, WINDOW_MS, NOW);
  assert.equal(input.recentEngagementWeighted, 7);
});

check('deriveTrendScoreInput: an empty history for a hashtag with no posts/engagement at all is a valid, zeroed, non-throwing input', () => {
  const input = deriveTrendScoreInput([], [], WINDOW_MS, NOW);
  assert.equal(input.recentPostCount, 0);
  assert.equal(input.previousPostCount, 0);
  assert.equal(input.uniqueCreatorCount, 0);
  assert.equal(input.recentEngagementWeighted, 0);
  assert.equal(scoreHashtagTrend(input), 0);
});

// --- countRawRecentPosts (the HONEST, un-anti-spammed display count — Step 29) ---

check('countRawRecentPosts: counts every post in the window, WITHOUT the anti-spam per-creator cap (the displayed count must be honest, not suppressed)', () => {
  const posts = Array.from({ length: 10 }, (_, i) => post(`r${i}`, 1, 'one-creator'));
  assert.equal(countRawRecentPosts(posts, WINDOW_MS, NOW), 10);
});

check('countRawRecentPosts: excludes posts outside the window', () => {
  const posts = [post('a', 1), post('b', 23), post('c', 25), post('d', 100)];
  assert.equal(countRawRecentPosts(posts, WINDOW_MS, NOW), 2);
});

const failed = results.filter((r) => !r.pass);
for (const result of results) {
  console.log(`${result.pass ? '✓' : '✗'} ${result.name}`);
  if (!result.pass) console.error('  ', result.error);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
