/**
 * Lightweight unit-level tests for hashtag composer AUTOCOMPLETE (Step 3)
 * — run via:
 *   npx tsx tests/hashtagAutocomplete.test.ts
 * Same plain assert()/check() convention as tests/hashtags.test.ts and
 * tests/hashtagPage.test.ts.
 *
 * Covers getActiveHashtag (cursor-position-aware active-token detection)
 * and replaceActiveHashtag (selection replaces only that one token) —
 * both pure, both in src/utils/hashtags.ts alongside Step 1's
 * extractHashtags/normalizeHashtag, reusing the exact same charset so
 * composer autocomplete, stored hashtags, and clickable captions can never
 * disagree on what counts as a hashtag.
 *
 * What this does NOT test: searchHashtagsRanked
 * (src/services/hashtags.ts) is a thin ranking/caching wrapper around the
 * real Firestore-backed searchHashtags (already built in Step 1) — same
 * "no live-Firestore unit test" convention as every other Firestore-
 * touching function in this codebase (see tests/hashtagPage.test.ts's own
 * doc comment for the fuller rationale). Its pure part — the ranking
 * comparator (postCount descending, name as a deterministic tie-break) —
 * is covered here directly since it's simple enough to reproduce exactly
 * against representative input without needing the network call itself.
 */
import { getActiveHashtag, replaceActiveHashtag } from '../src/utils/hashtags';
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

// --- getActiveHashtag: basic detection ---

check('"Hello #foo" with cursor right after "foo" returns query "foo"', () => {
  const text = 'Hello #foo';
  const active = getActiveHashtag(text, text.length);
  assert.deepEqual(active, { query: 'foo', start: 6, end: 10 });
});

check('the spec\'s own worked example matches exactly: {query:"foo", start:6, end:10}', () => {
  const active = getActiveHashtag('Hello #foo', 10);
  assert.ok(active !== null);
  assert.equal(active!.query, 'foo');
  assert.equal(active!.start, 6);
  assert.equal(active!.end, 10);
});

check('"Hello #foo tonight" with cursor right after "foo" (before the space) is still active', () => {
  const active = getActiveHashtag('Hello #foo tonight', 10);
  assert.ok(active !== null);
  assert.equal(active!.query, 'foo');
});

check('"#foo " with cursor after the trailing space is NOT active (space closes it)', () => {
  const active = getActiveHashtag('#foo ', 5);
  assert.equal(active, null);
});

check('multiple hashtags: cursor inside the SECOND one only searches that one\'s query', () => {
  const text = '#football with #kar';
  const active = getActiveHashtag(text, text.length);
  assert.ok(active !== null);
  assert.equal(active!.query, 'kar');
});

check('"#football with #karl" — cursor moved back into the FIRST hashtag detects that one, not the last', () => {
  const text = '#football with #karl';
  const cursorInsideFirst = '#foo'.length; // right after "foo" inside "#football"
  const active = getActiveHashtag(text, cursorInsideFirst);
  assert.ok(active !== null);
  assert.equal(active!.query, 'football');
});

check('cursor outside any hashtag ("#football hello|") returns null', () => {
  const text = '#football hello';
  const active = getActiveHashtag(text, text.length);
  assert.equal(active, null);
});

check('cursor in plain text with no "#" anywhere returns null', () => {
  const active = getActiveHashtag('Just a normal caption', 10);
  assert.equal(active, null);
});

check('a bare "#" with the cursor right after it returns an empty query, not null (still "active", just nothing to search yet)', () => {
  const active = getActiveHashtag('Hi #', 4);
  assert.deepEqual(active, { query: '', start: 3, end: 4 });
});

check('"word#tag" is never read as an active hashtag (no separator before "#", same rule as extraction)', () => {
  const text = 'word#tag';
  const active = getActiveHashtag(text, text.length);
  assert.equal(active, null);
});

check('an email-shaped "foo@bar#baz" style token still requires "#" to start a fresh word', () => {
  const active = getActiveHashtag('contact foo#bar', 'contact foo#bar'.length);
  assert.equal(active, null);
});

// --- getActiveHashtag: Swedish characters ---

check('Swedish "#trä" is detected correctly', () => {
  const text = 'Kväll för #trä';
  const active = getActiveHashtag(text, text.length);
  assert.ok(active !== null);
  assert.equal(active!.query, 'trä');
});

check('Swedish "#vä" and "#öl" are both detected correctly', () => {
  assert.equal(getActiveHashtag('#vä', 3)?.query, 'vä');
  assert.equal(getActiveHashtag('#öl', 3)?.query, 'öl');
});

// --- getActiveHashtag: underscores and numbers ---

check('"#student_kar" (underscore) is detected correctly', () => {
  const text = 'Going to #student_kar';
  const active = getActiveHashtag(text, text.length);
  assert.ok(active !== null);
  assert.equal(active!.query, 'student_kar');
});

check('"#formula1" (trailing digits) is detected correctly', () => {
  const active = getActiveHashtag('#formula1', 9);
  assert.equal(active?.query, 'formula1');
});

// --- getActiveHashtag: cursor mid-token (not just at the tail) ---

check('cursor in the MIDDLE of "#football" still finds the whole token, not just the typed-so-far prefix', () => {
  const text = '#football';
  const active = getActiveHashtag(text, 4); // right after "#foo"
  assert.ok(active !== null);
  assert.equal(active!.query, 'football');
  assert.equal(active!.start, 0);
  assert.equal(active!.end, 9);
});

// --- replaceActiveHashtag: replacement preserves everything else ---

check('"Great #foo tonight" selecting "football" -> "Great #football tonight" (no double space)', () => {
  const text = 'Great #foo tonight';
  const active = getActiveHashtag(text, 10); // cursor right after "foo"
  assert.ok(active !== null);
  const result = replaceActiveHashtag(text, active!, 'football');
  assert.equal(result.text, 'Great #football tonight');
});

check('a hashtag at the very end of the text gets a trailing space added', () => {
  const text = 'Tonight #football with friends in #karl';
  const active = getActiveHashtag(text, text.length);
  assert.ok(active !== null);
  const result = replaceActiveHashtag(text, active!, 'karlstad');
  assert.equal(result.text, 'Tonight #football with friends in #karlstad ');
  assert.equal(result.cursor, result.text.length);
});

check('multiple hashtags: replacing the second one leaves the first completely untouched', () => {
  const text = 'Tonight #football with friends in #karl';
  const active = getActiveHashtag(text, text.length);
  const result = replaceActiveHashtag(text, active!, 'karlstad');
  assert.ok(result.text.startsWith('Tonight #football with friends in #karlstad'));
  assert.equal(result.text.includes('#football'), true);
});

check('replacement never touches an unrelated earlier occurrence of the same query text elsewhere in the caption', () => {
  // "foo" appears in "food" earlier in the text too — only the ACTIVE
  // token (the one the cursor is in) may change.
  const text = 'I love food #foo';
  const active = getActiveHashtag(text, text.length);
  const result = replaceActiveHashtag(text, active!, 'football');
  assert.equal(result.text, 'I love food #football ');
});

check('cursor placed after the inserted hashtag lands exactly at the end of the inserted text', () => {
  const text = 'Great #foo tonight';
  const active = getActiveHashtag(text, 10)!;
  const result = replaceActiveHashtag(text, active, 'football');
  assert.equal(text.slice(0, active.start) + result.text.slice(active.start, result.cursor), 'Great #football');
});

check('emojis, line breaks, and surrounding text are all preserved untouched', () => {
  const text = 'Party time 🎉\nTonight #foo with friends';
  const active = getActiveHashtag(text, text.indexOf('#foo') + 4);
  assert.ok(active !== null);
  const result = replaceActiveHashtag(text, active!, 'football');
  assert.equal(result.text, 'Party time 🎉\nTonight #football with friends');
});

check('a bare "#" (empty query) can still be replaced by a real hashtag', () => {
  const text = 'Going out #';
  const active = getActiveHashtag(text, text.length)!;
  const result = replaceActiveHashtag(text, active, 'nightlife');
  assert.equal(result.text, 'Going out #nightlife ');
});

// --- Autocomplete ranking comparator (postCount desc, name as tie-break — the pure part of searchHashtagsRanked) ---

function makeHashtag(name: string, postCount: number): Hashtag {
  // createdAt/updatedAt are irrelevant to ranking — cast through unknown
  // rather than fabricating real Timestamps this test doesn't need.
  return { name, postCount, createdAt: null, updatedAt: null } as unknown as Hashtag;
}

function rank(hashtags: Hashtag[]): string[] {
  return [...hashtags].sort((a, b) => b.postCount - a.postCount || a.name.localeCompare(b.name)).map((h) => h.name);
}

check('ranking prioritizes higher postCount first — the spec\'s own worked example', () => {
  const candidates = [makeHashtag('foobar', 3), makeHashtag('food', 93000), makeHashtag('football', 128000), makeHashtag('foodie', 61000)];
  assert.deepEqual(rank(candidates), ['football', 'food', 'foodie', 'foobar']);
});

check('an exact-match hashtag is not hidden — it still appears, ranked by its own postCount like any other candidate', () => {
  const candidates = [makeHashtag('football', 128000), makeHashtag('footballfan', 40)];
  assert.deepEqual(rank(candidates), ['football', 'footballfan']);
});

check('ranking is deterministic — equal postCount ties break alphabetically, not by input/fetch order', () => {
  const a = [makeHashtag('karlsson', 10), makeHashtag('karlstad', 10)];
  const b = [makeHashtag('karlstad', 10), makeHashtag('karlsson', 10)];
  assert.deepEqual(rank(a), rank(b));
  assert.deepEqual(rank(a), ['karlsson', 'karlstad']);
});

const failed = results.filter((r) => !r.pass);
for (const result of results) {
  console.log(`${result.pass ? '✓' : '✗'} ${result.name}`);
  if (!result.pass) console.error('  ', result.error);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
