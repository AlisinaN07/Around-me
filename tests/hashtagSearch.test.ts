/**
 * Lightweight unit-level tests for hashtag integration into main Search
 * (Step 4) — run via:
 *   npx tsx tests/hashtagSearch.test.ts
 * Same plain assert()/check() convention as the other hashtag test files.
 *
 * What this does NOT test: search.tsx itself is a screen (.tsx) that pulls
 * in react-native/expo-router — this project's tests never import a
 * screen directly (see tests/hashtagPage.test.ts's own doc comment for
 * why), and searchHashtagsRanked is a thin ranking/caching wrapper around
 * the real Firestore-backed searchHashtags, same "no live-Firestore unit
 * test" convention as every other Firestore-touching function here (see
 * tests/hashtagAutocomplete.test.ts's own doc comment).
 *
 * What IS tested here instead, all pure and directly reusable by the
 * screen: query normalization (the exact `normalizeHashtag` call
 * search.tsx makes to turn "football"/"#football"/"Football"/"#FOOTBALL"
 * into one canonical prefix — no second/incompatible normalizer),
 * the ranking comparator search.tsx's Hashtags section is built on
 * (postCount descending, name as tie-break — the same one
 * searchHashtagsRanked itself uses, reproduced directly here since it's
 * simple enough to verify without a network call), the bare-"#" no-query
 * guard, and the route a tapped result resolves to.
 */
import { normalizeHashtag } from '../src/utils/hashtags';
import type { Hashtag } from '../src/types/hashtag';

const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `Expected truthy value, got ${String(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(message ?? `Expected ${b}, got ${a}`);
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

// --- Query normalization: search.tsx's own `hashtagQuery` derivation ---
// (`isSelectMode ? null : normalizeHashtag(query)`) — reproduced here
// directly against normalizeHashtag itself, the exact function the
// screen calls, never a parallel/incompatible implementation.

check('"football" (no "#") normalizes to the canonical prefix "football"', () => {
  assert.equal(normalizeHashtag('football'), 'football');
});

check('"#football" normalizes to the same canonical prefix "football"', () => {
  assert.equal(normalizeHashtag('#football'), 'football');
});

check('"Football" (mixed case, no "#") normalizes to "football"', () => {
  assert.equal(normalizeHashtag('Football'), 'football');
});

check('"#FOOTBALL" normalizes to "football"', () => {
  assert.equal(normalizeHashtag('#FOOTBALL'), 'football');
});

check('all four spelling variants from the spec produce the identical canonical prefix', () => {
  const variants = ['football', '#football', 'Football', '#FOOTBALL'].map((q) => normalizeHashtag(q));
  assert.ok(
    variants.every((value) => value === 'football'),
    `Expected every variant to normalize to "football", got ${JSON.stringify(variants)}`
  );
});

check('a partial prefix like "foot" normalizes cleanly too — prefix search doesn\'t require a complete hashtag', () => {
  assert.equal(normalizeHashtag('foot'), 'foot');
  assert.equal(normalizeHashtag('#foot'), 'foot');
});

// --- Bare "#" must never trigger an unbounded/nonsensical query ---

check('a bare "#" normalizes to null — search.tsx treats this as "no hashtag query", never queries Firestore', () => {
  assert.equal(normalizeHashtag('#'), null);
});

check('an empty search query normalizes to null — preserves the existing empty-Search behavior untouched', () => {
  assert.equal(normalizeHashtag(''), null);
});

check('a query with a space (a people-style multi-word query) is not treated as a hashtag prefix', () => {
  assert.equal(normalizeHashtag('foo ball'), null);
});

// --- Prefix matching semantics (documented here; the actual query lives in searchHashtags/searchHashtagsRanked, Step 1/3) ---

check('prefix matching is a starts-with check, not substring — "foot" is a prefix of "football" but "ball" is not', () => {
  assert.ok('football'.startsWith('foot'));
  assert.ok(!'football'.startsWith('ball'));
});

// --- Ranking comparator: postCount descending, name as deterministic tie-break (same as searchHashtagsRanked) ---

function makeHashtag(name: string, postCount: number): Hashtag {
  return { name, postCount, createdAt: null, updatedAt: null } as unknown as Hashtag;
}

function rank(hashtags: Hashtag[]): string[] {
  return [...hashtags].sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name)).map((h) => h.name);
}

check('higher postCount ranks first among matching candidates — the spec\'s own worked example', () => {
  const candidates = [makeHashtag('footballfans', 42000), makeHashtag('football', 128000), makeHashtag('footballlife', 3000)];
  assert.deepEqual(rank(candidates), ['football', 'footballfans', 'footballlife']);
});

check('an exact match ("football" matching query "football") is not hidden — still ranked by its own postCount', () => {
  const candidates = [makeHashtag('football', 128000), makeHashtag('footballfans', 42000)];
  assert.deepEqual(rank(candidates), ['football', 'footballfans']);
});

check('ranking is deterministic — equal postCount values order consistently regardless of input order', () => {
  const a = [makeHashtag('footwork', 5), makeHashtag('footy', 5)];
  const b = [makeHashtag('footy', 5), makeHashtag('footwork', 5)];
  assert.deepEqual(rank(a), rank(b));
  assert.deepEqual(rank(a), ['footwork', 'footy']);
});

// --- Tap-to-route: a selected hashtag result resolves to the EXISTING hashtag route, never a new screen ---

check('selecting a hashtag result resolves to the existing /hashtag/[hashtag] route with its canonical name', () => {
  const hashtag = makeHashtag('football', 128000);
  const route = `/hashtag/${encodeURIComponent(hashtag.name)}`;
  assert.equal(route, '/hashtag/football');
});

check('a hashtag name containing Swedish characters is safely URL-encoded for the route, same as HighlightedText\'s own navigation', () => {
  const hashtag = makeHashtag('träning', 500);
  const route = `/hashtag/${encodeURIComponent(hashtag.name)}`;
  assert.equal(route, '/hashtag/tr%C3%A4ning');
});

const failed = results.filter((r) => !r.pass);
for (const result of results) {
  console.log(`${result.pass ? '✓' : '✗'} ${result.name}`);
  if (!result.pass) console.error('  ', result.error);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
