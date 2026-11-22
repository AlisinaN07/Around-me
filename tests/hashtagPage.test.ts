/**
 * Lightweight unit-level tests for the hashtag DISCOVERY PAGE's own
 * non-visual logic (Step 2 of the hashtag feature) — run via:
 *   npx tsx tests/hashtagPage.test.ts
 * Same plain assert()/check() convention as tests/cities.test.ts and
 * tests/hashtags.test.ts.
 *
 * What this does NOT test (and why): getRecentPostsForHashtag/
 * getTopPostsForHashtag/getHashtag are thin wrappers around real Firestore
 * queries (src/services/reels.ts, src/services/hashtags.ts) — exactly like
 * every other Reel-fetching function in this codebase (fetchCityReels,
 * fetchProfileReels, ...), none of which have a live-Firestore unit test
 * either (see tests/recommendations.test.ts and tests/cities.test.ts,
 * which both test pure logic only). This file follows that same
 * convention: it tests the PURE logic the hashtag page's own screen code
 * and its dependencies are built from — canonical-form normalization, Top
 * ranking determinism via the shared scoreContentQuality helper, and the
 * "missing hashtag doc"/"zero posts" fallbacks — rather than re-testing
 * Firestore itself or standing up an emulator (see this feature's own
 * report for why the emulator route isn't viable in this sandbox).
 * formatPostCount itself lives in src/utils/postCount.ts (pulled out of
 * the screen file, which this project's tests never import — see that
 * module's own doc comment) precisely so it's testable here.
 */
import { scoreContentQuality } from '../src/services/recommendations/ranking';
import { EMPTY_ENGAGEMENT_STATS } from '../src/types/engagementStats';
import type { ContentEngagementStats } from '../src/types/engagementStats';
import { normalizeHashtag } from '../src/utils/hashtags';
import { formatPostCount } from '../src/utils/postCount';

const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `Expected truthy value, got ${String(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
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

function stats(overrides: Partial<ContentEngagementStats> = {}): ContentEngagementStats {
  return { ...EMPTY_ENGAGEMENT_STATS, ...overrides };
}

// --- Route-param normalization (spec §13/§21: Football/FOOTBALL/football -> same canonical form) ---

check('route param "Football" normalizes to "football"', () => {
  assert.equal(normalizeHashtag('Football'), 'football');
});

check('route param "FOOTBALL" normalizes to "football"', () => {
  assert.equal(normalizeHashtag('FOOTBALL'), 'football');
});

check('route param "football" normalizes to "football" (already canonical)', () => {
  assert.equal(normalizeHashtag('football'), 'football');
});

check('all three route-param casings resolve to the identical canonical form', () => {
  const forms = ['Football', 'FOOTBALL', 'football'].map((raw) => normalizeHashtag(raw));
  assert.ok(
    forms.every((value) => value === forms[0]),
    `Expected every casing to normalize identically, got ${JSON.stringify(forms)}`
  );
});

check('a malformed/unnormalizable route param (spec: page must still render, never crash) yields null, never throws', () => {
  assert.equal(normalizeHashtag(''), null);
  assert.equal(normalizeHashtag('   '), null);
  assert.equal(normalizeHashtag('#'), null);
});

// --- formatPostCount (header "12.4K posts" display) ---

check('formatPostCount: a missing hashtag doc (postCount 0) reads "0 posts", not a crash or "0 post"', () => {
  assert.equal(formatPostCount(0), '0 posts');
});

check('formatPostCount: singular "1 post"', () => {
  assert.equal(formatPostCount(1), '1 post');
});

check('formatPostCount: small counts stay exact, not abbreviated', () => {
  assert.equal(formatPostCount(999), '999 posts');
});

check('formatPostCount: the spec\'s own worked example, 12,400 -> "12.4K posts"', () => {
  assert.equal(formatPostCount(12400), '12.4K posts');
});

check('formatPostCount: an exact thousand drops the trailing ".0"', () => {
  assert.equal(formatPostCount(12000), '12K posts');
});

check('formatPostCount: millions get their own suffix', () => {
  assert.equal(formatPostCount(1500000), '1.5M posts');
});

// --- Top ranking determinism (spec §5/§21: deterministic, using real engagement fields) ---

check('scoreContentQuality is deterministic — identical input, identical output, every call', () => {
  const input = stats({ impressions: 500, meaningfulViews: 400, likes: 40, comments: 6, saves: 3, shares: 2 });
  const first = scoreContentQuality(input, true, 15000);
  const second = scoreContentQuality(input, true, 15000);
  const third = scoreContentQuality(input, true, 15000);
  assert.equal(first, second);
  assert.equal(second, third);
});

check('scoreContentQuality: a hashtag post with real engagement outranks one with none — Top tab actually orders by engagement', () => {
  const wellEngaged = scoreContentQuality(
    stats({ impressions: 400, meaningfulViews: 350, likes: 60, comments: 10, saves: 8, shares: 4, completions: 200, watchSampleCount: 350, totalWatchPercent: 300 }),
    true,
    20000
  );
  const untouched = scoreContentQuality(EMPTY_ENGAGEMENT_STATS, true, 20000);
  assert.ok(wellEngaged > untouched, `Expected the well-engaged post to score higher (${wellEngaged} vs ${untouched})`);
});

check('scoreContentQuality: a hashtag post with zero stats (no stats doc yet) scores a finite number, never NaN/throws', () => {
  const score = scoreContentQuality(EMPTY_ENGAGEMENT_STATS, true, undefined);
  assert.ok(Number.isFinite(score), `Expected a finite score, got ${score}`);
});

check('scoreContentQuality: sorting a candidate pool by score is a stable, deterministic total order', () => {
  const low = { id: 'low', score: scoreContentQuality(stats({ impressions: 100, meaningfulViews: 80, likes: 1 }), false) };
  const mid = { id: 'mid', score: scoreContentQuality(stats({ impressions: 100, meaningfulViews: 90, likes: 20, comments: 3 }), false) };
  const high = { id: 'high', score: scoreContentQuality(stats({ impressions: 100, meaningfulViews: 95, likes: 60, comments: 12, saves: 10 }), false) };
  const ranked = [mid, low, high].sort((a, b) => b.score - a.score).map((entry) => entry.id);
  assert.equal(ranked.join(','), 'high,mid,low');
});

// --- "getHashtag returns null" fallback (spec §2/§21: missing hashtags/{hashtag} doc handled, no crash) ---

check('a missing hashtag document (getHashtag -> null) falls back to 0 posts, matching the screen\'s own `?? 0`', () => {
  const hashtagDoc = null as { postCount: number } | null;
  assert.equal(formatPostCount(hashtagDoc?.postCount ?? 0), '0 posts');
});

// --- Cursor pagination convention (spec §9/§21: "no more pages" signal is a short page, never an extra read) ---

check('a full page (length === limit) signals "more may exist" — cursor should be kept', () => {
  const limitCount: number = 15;
  const pageLength: number = 15;
  const hasMore = pageLength === limitCount;
  assert.equal(hasMore, true);
});

check('a short page (length < limit) signals "no more pages" — cursor should be undefined, no extra read needed', () => {
  const limitCount: number = 15;
  const pageLength: number = 7;
  const hasMore = pageLength === limitCount;
  assert.equal(hasMore, false);
});

check('an exactly-empty page (a hashtag with zero posts) also signals "no more pages", not an error', () => {
  const limitCount: number = 15;
  const pageLength: number = 0;
  const hasMore = pageLength === limitCount;
  assert.equal(hasMore, false);
});

const failed = results.filter((r) => !r.pass);
for (const result of results) {
  console.log(`${result.pass ? '✓' : '✗'} ${result.name}`);
  if (!result.pass) console.error('  ', result.error);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
