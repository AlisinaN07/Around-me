/**
 * Lightweight unit-level tests for hashtag extraction/normalization — run
 * via:
 *   npx tsx tests/hashtags.test.ts
 * Same plain assert()/check() convention as tests/cities.test.ts — see
 * that file's own doc comment for why this project uses a tiny local
 * assert instead of a full test framework or node:assert/strict.
 *
 * Covers the exact test cases from this feature's own spec, plus a few
 * boundary cases (normalizeHashtag rejecting invalid input directly, and
 * splitTextWithHashtags — the clickable-caption renderer's own helper —
 * agreeing with extractHashtags on what counts as a hashtag).
 */
import { extractHashtags, normalizeHashtag, splitTextWithHashtags } from '../src/utils/hashtags';

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

// --- Test 1-4 from the feature spec, verbatim ---

check('Test 1: "Hello #Football #Karlstad" -> ["football", "karlstad"]', () => {
  assert.deepEqual(extractHashtags('Hello #Football #Karlstad'), ['football', 'karlstad']);
});

check('Test 2: "#football #Football #FOOTBALL" -> ["football"] (case-insensitive dedupe)', () => {
  assert.deepEqual(extractHashtags('#football #Football #FOOTBALL'), ['football']);
});

check('Test 3: "Tonight 🔥 #nattliv #karlstad_student" -> ["nattliv", "karlstad_student"] (Swedish text + underscore)', () => {
  assert.deepEqual(extractHashtags('Tonight 🔥 #nattliv #karlstad_student'), ['nattliv', 'karlstad_student']);
});

check('Test 4: "Beautiful evening" (no hashtags) -> []', () => {
  assert.deepEqual(extractHashtags('Beautiful evening'), []);
});

// --- The feature spec's own worked example ---

check('worked example: emoji + mixed case -> normalized, deduplicated, order preserved', () => {
  assert.deepEqual(extractHashtags('Amazing night in Karlstad 🔥 #nightlife #Karlstad #studentlife'), [
    'nightlife',
    'karlstad',
    'studentlife',
  ]);
});

// --- Swedish characters explicitly (å, ä, ö) ---

check('Swedish characters å/ä/ö are valid hashtag characters', () => {
  assert.deepEqual(extractHashtags('Så bra #Åre #Malmö #Västerås'), ['åre', 'malmö', 'västerås']);
});

// --- Edge cases the spec calls out: ignore empty/invalid, real charset ---

check('a bare "#" with nothing after it is not a hashtag', () => {
  assert.deepEqual(extractHashtags('Just a # symbol'), []);
});

check('"word#tag" (no separator before "#") is not read as a hashtag', () => {
  assert.deepEqual(extractHashtags('word#tag should not match'), []);
});

check('an email-shaped "foo@bar" is unrelated and never matched by hashtag extraction', () => {
  assert.deepEqual(extractHashtags('contact foo@bar.com for #details'), ['details']);
});

check('numbers-only hashtags are valid ("reasonable letters, numbers, underscore")', () => {
  assert.deepEqual(extractHashtags('See you in #2026'), ['2026']);
});

check('duplicate hashtags collapse to their first occurrence, order preserved', () => {
  assert.deepEqual(extractHashtags('#b #a #b #c #a'), ['b', 'a', 'c']);
});

// --- normalizeHashtag directly ---

check('normalizeHashtag strips a leading "#" and lowercases', () => {
  assert.equal(normalizeHashtag('#Karlstad'), 'karlstad');
});

check('normalizeHashtag rejects an empty string', () => {
  assert.equal(normalizeHashtag(''), null);
  assert.equal(normalizeHashtag('#'), null);
});

check('normalizeHashtag rejects a string containing a space (not one token)', () => {
  assert.equal(normalizeHashtag('two words'), null);
});

check('normalizeHashtag rejects something far longer than any real hashtag', () => {
  assert.equal(normalizeHashtag('a'.repeat(200)), null);
});

// --- splitTextWithHashtags — the clickable-caption renderer's own helper ---

check('splitTextWithHashtags covers every character of the original text', () => {
  const text = 'Amazing night 🔥 #nightlife and #Karlstad too';
  const segments = splitTextWithHashtags(text);
  const rebuilt = segments.map((segment) => (segment.type === 'text' ? segment.value : `#${segment.raw}`)).join('');
  assert.equal(rebuilt, text);
});

check('splitTextWithHashtags keeps original casing for display but lowercases `normalized`', () => {
  const segments = splitTextWithHashtags('Great #Nightlife');
  const hashtagSegment = segments.find((segment) => segment.type === 'hashtag');
  assert.ok(hashtagSegment);
  assert.equal(hashtagSegment!.type === 'hashtag' ? hashtagSegment!.raw : null, 'Nightlife');
  assert.equal(hashtagSegment!.type === 'hashtag' ? hashtagSegment!.normalized : null, 'nightlife');
});

check('splitTextWithHashtags and extractHashtags agree on what counts as a hashtag', () => {
  const text = 'Hello #Football, word#tag, #Karlstad_student 🔥';
  const fromSplit = splitTextWithHashtags(text)
    .filter((segment) => segment.type === 'hashtag')
    .map((segment) => (segment.type === 'hashtag' ? segment.normalized : ''));
  assert.deepEqual(fromSplit, extractHashtags(text));
});

console.log('\n=== Hashtag extraction/normalization test results ===');
let failures = 0;
for (const result of results) {
  if (result.pass) {
    console.log(`PASS — ${result.name}`);
  } else {
    failures += 1;
    console.log(`FAIL — ${result.name}`);
    console.log(`       ${result.error instanceof Error ? result.error.message : result.error}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed.`);

if (failures > 0) {
  process.exit(1);
}
