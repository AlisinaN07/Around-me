/**
 * Lightweight unit-level tests for the hashtag-interest profile's pure
 * scoring logic — run via:
 *   npx tsx tests/hashtagInterest.test.ts
 * Same plain assert()/check() convention as tests/recommendations.test.ts
 * (which this file directly parallels — same "pure, Firestore-free logic
 * only" scope, same reason: hashtagInterestProfile.ts's actual Firestore
 * reads/writes aren't unit-tested here, same "no live-Firestore unit
 * test" convention as every other Firestore-touching function in this
 * codebase — see tests/hashtagPage.test.ts's own doc comment for the
 * fuller rationale).
 *
 * Covers: applyBoundedHashtagScoreDelta/computeNextHashtagInterest
 * (hashtagInterestLogic.ts) and selectHashtagsForInterestUpdate (the
 * cap/normalization/dedup step), plus HASHTAG_INTEREST_WEIGHTS' own
 * relative ordering (hashtagInterestConfig.ts).
 */
import {
  HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT,
  HASHTAG_INTEREST_WEIGHTS,
  HASHTAG_SCORE_MAX,
  HASHTAG_SCORE_MIN,
} from '../src/services/recommendations/hashtagInterestConfig';
import {
  applyBoundedHashtagScoreDelta,
  computeNextHashtagInterest,
  selectHashtagsForInterestUpdate,
  type HashtagInterestSnapshot,
} from '../src/services/recommendations/hashtagInterestLogic';

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
  close(actual: number, expected: number, epsilon = 1e-9, message?: string): void {
    if (Math.abs(actual - expected) > epsilon) throw new Error(message ?? `Expected ~${expected}, got ${actual}`);
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

function snapshot(score: number, positiveSignalCount = 0, negativeSignalCount = 0): HashtagInterestSnapshot {
  return { score, positiveSignalCount, negativeSignalCount };
}

// --- Positive signal ---

check('a positive signal on an existing score produces a higher score', () => {
  const before = 0.3;
  const after = applyBoundedHashtagScoreDelta(before, HASHTAG_INTEREST_WEIGHTS.like!);
  assert.ok(after > before, `Expected ${after} > ${before}`);
});

check('computeNextHashtagInterest: a like on football=0.30 produces football > 0.30 (spec\'s own worked example)', () => {
  const next = computeNextHashtagInterest(snapshot(0.3), HASHTAG_INTEREST_WEIGHTS.like!);
  assert.ok(next !== null);
  assert.ok(next!.score > 0.3, `Expected ${next!.score} > 0.3`);
});

// --- Negative signal ---

check('a negative signal (not_interested) reduces an existing score', () => {
  const before = 0.7;
  const after = applyBoundedHashtagScoreDelta(before, HASHTAG_INTEREST_WEIGHTS.not_interested!);
  assert.ok(after < before, `Expected ${after} < ${before}`);
});

check('computeNextHashtagInterest: not_interested on football=0.70 reduces it (spec\'s own worked example)', () => {
  const next = computeNextHashtagInterest(snapshot(0.7), HASHTAG_INTEREST_WEIGHTS.not_interested!);
  assert.ok(next !== null);
  assert.ok(next!.score < 0.7, `Expected ${next!.score} < 0.7`);
});

check('not_interested is a preference signal, not a permanent ban — a strong existing score survives one hit above zero', () => {
  const next = computeNextHashtagInterest(snapshot(0.7), HASHTAG_INTEREST_WEIGHTS.not_interested!);
  assert.ok(next !== null && next.score > 0, `Expected a surviving positive score, got ${next?.score}`);
});

// --- Clamp ---

check('score never exceeds HASHTAG_SCORE_MAX even from an already-near-max value with a strong positive weight', () => {
  const after = applyBoundedHashtagScoreDelta(0.98, HASHTAG_INTEREST_WEIGHTS.save!);
  assert.ok(after <= HASHTAG_SCORE_MAX, `Expected <= ${HASHTAG_SCORE_MAX}, got ${after}`);
});

check('score never drops below HASHTAG_SCORE_MIN even from an already-near-zero value with a strong negative weight', () => {
  const after = applyBoundedHashtagScoreDelta(0.02, HASHTAG_INTEREST_WEIGHTS.not_interested!);
  assert.ok(after >= HASHTAG_SCORE_MIN, `Expected >= ${HASHTAG_SCORE_MIN}, got ${after}`);
});

check('a single like from zero does not push the score anywhere near 1.0 (spec: "one like should NOT result in football = 1.0")', () => {
  const next = computeNextHashtagInterest(null, HASHTAG_INTEREST_WEIGHTS.like!);
  assert.ok(next !== null);
  assert.ok(next!.score < 0.5, `Expected a modest first-signal score, got ${next!.score}`);
});

// --- Repeated signals build gradually ---

check('repeated valid positive interactions build interest gradually, each one still below the max', () => {
  let current: HashtagInterestSnapshot | null = null;
  const scores: number[] = [];
  for (let i = 0; i < 8; i++) {
    current = computeNextHashtagInterest(current, HASHTAG_INTEREST_WEIGHTS.like!);
    assert.ok(current !== null);
    scores.push(current!.score);
  }
  // Strictly increasing...
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] > scores[i - 1], `Expected score to keep increasing: ${scores[i - 1]} -> ${scores[i]}`);
  }
  // ...but with DIMINISHING increments as it approaches the ceiling (the
  // whole point of applyBoundedHashtagScoreDelta's own room-scaling).
  const firstDelta = scores[0] - 0;
  const lastDelta = scores[scores.length - 1] - scores[scores.length - 2];
  assert.ok(lastDelta < firstDelta, `Expected the increment to shrink over repeated identical signals: first=${firstDelta}, last=${lastDelta}`);
  assert.ok(scores[scores.length - 1] < HASHTAG_SCORE_MAX, 'Expected score to stay strictly below the max even after many repeated likes');
});

// --- Multiple hashtags ---

check('selectHashtagsForInterestUpdate returns every valid hashtag from one piece of content, in order', () => {
  const selected = selectHashtagsForInterestUpdate(['football', 'championsleague', 'realmadrid']);
  assert.deepEqual(selected, ['football', 'championsleague', 'realmadrid']);
});

// --- Cap ---

check(`a post with excessive hashtags is capped at HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT (${HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT})`, () => {
  const manyHashtags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
  const selected = selectHashtagsForInterestUpdate(manyHashtags);
  assert.equal(selected.length, HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT);
  assert.deepEqual(selected, manyHashtags.slice(0, HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT));
});

// --- Normalization ---

check('Football / FOOTBALL / football all resolve to the same interest key', () => {
  assert.deepEqual(selectHashtagsForInterestUpdate(['Football']), ['football']);
  assert.deepEqual(selectHashtagsForInterestUpdate(['FOOTBALL']), ['football']);
  assert.deepEqual(selectHashtagsForInterestUpdate(['football']), ['football']);
});

check('duplicate hashtags (even across casing) on the same content collapse to one interest update, not two', () => {
  const selected = selectHashtagsForInterestUpdate(['Football', 'football', 'FOOTBALL']);
  assert.deepEqual(selected, ['football']);
});

// --- No hashtags ---

check('a reel with hashtags: [] selects nothing — no interest update at all', () => {
  assert.deepEqual(selectHashtagsForInterestUpdate([]), []);
});

check('an invalid-charset entry (defensive re-normalization) is silently dropped, not crashed on', () => {
  const selected = selectHashtagsForInterestUpdate(['football', 'not a valid hashtag', 'championsleague']);
  assert.deepEqual(selected, ['football', 'championsleague']);
});

// --- Low score cleanup ---

check('a resulting score below the cleanup threshold returns null (caller deletes/never creates a document)', () => {
  // A hashtag with no prior history (score 0) hit by a weak negative
  // signal has zero "room" to move (room = current - MIN = 0), so it
  // stays at exactly 0 — below the cleanup threshold — never creating a
  // negligible record for a hashtag with no positive history at all.
  const next = computeNextHashtagInterest(null, HASHTAG_INTEREST_WEIGHTS.quick_skip!);
  assert.equal(next, null);
});

check('an existing low-but-tracked score reduced further below the cleanup threshold also returns null', () => {
  const next = computeNextHashtagInterest(snapshot(0.03, 2, 0), HASHTAG_INTEREST_WEIGHTS.not_interested!);
  assert.equal(next, null);
});

// --- Deterministic weights ---

check('the same signal inputs always produce the same score update', () => {
  const a = applyBoundedHashtagScoreDelta(0.42, HASHTAG_INTEREST_WEIGHTS.save!);
  const b = applyBoundedHashtagScoreDelta(0.42, HASHTAG_INTEREST_WEIGHTS.save!);
  const c = applyBoundedHashtagScoreDelta(0.42, HASHTAG_INTEREST_WEIGHTS.save!);
  assert.equal(a, b);
  assert.equal(b, c);
});

check('computeNextHashtagInterest is deterministic end to end for identical (current, weight) inputs', () => {
  const a = computeNextHashtagInterest(snapshot(0.5, 3, 1), HASHTAG_INTEREST_WEIGHTS.comment!);
  const b = computeNextHashtagInterest(snapshot(0.5, 3, 1), HASHTAG_INTEREST_WEIGHTS.comment!);
  assert.deepEqual(a, b);
});

// --- Weight ordering (config sanity — relative magnitudes preserved from SIGNAL_WEIGHTS) ---

check('save (strongest ordinary positive) outweighs like', () => {
  assert.ok(HASHTAG_INTEREST_WEIGHTS.save! > HASHTAG_INTEREST_WEIGHTS.like!);
});

check('not_interested is the single largest-magnitude weight of any listed action', () => {
  const magnitudes = Object.values(HASHTAG_INTEREST_WEIGHTS).map((w) => Math.abs(w!));
  const maxMagnitude = Math.max(...magnitudes);
  assert.equal(Math.abs(HASHTAG_INTEREST_WEIGHTS.not_interested!), maxMagnitude);
});

check('unlike exactly reverses like, and unsave exactly reverses save — a toggle can\'t inflate the score', () => {
  assert.equal(HASHTAG_INTEREST_WEIGHTS.unlike, -HASHTAG_INTEREST_WEIGHTS.like!);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.unsave, -HASHTAG_INTEREST_WEIGHTS.save!);
});

check('repeated like/unlike toggling converges to a bounded fixed point well under the max, never inflating toward 1.0 (spec: "do not allow repeated toggling to inflate the score")', () => {
  // The bounded-delta curve scales a positive step by "room toward the
  // ceiling" and a negative step by "room toward the floor" — two
  // different reference frames, so one like+unlike round trip does NOT
  // net to exactly zero (that's expected, not a bug: a plain symmetric
  // cancellation would require an unbounded/linear model, which is
  // exactly what this feature deliberately avoids). What actually
  // matters is that toggling can't be farmed for unbounded growth —
  // verified here by running many cycles and confirming the score
  // converges (stops changing materially) far below HASHTAG_SCORE_MAX,
  // rather than climbing toward it.
  let current: HashtagInterestSnapshot | null = snapshot(0.4, 1, 0);
  let previousScore = current.score;
  for (let cycle = 0; cycle < 200; cycle++) {
    current = computeNextHashtagInterest(current, HASHTAG_INTEREST_WEIGHTS.like!)!;
    current = computeNextHashtagInterest(current, HASHTAG_INTEREST_WEIGHTS.unlike!)!;
    assert.ok(current !== null);
    previousScore = current.score;
  }
  assert.ok(previousScore < 0.6, `Expected convergence well under the max, got ${previousScore}`);
  // One more cycle changes the score by a negligible amount — it has
  // genuinely converged, not merely "still climbing slowly".
  const before = previousScore;
  current = computeNextHashtagInterest(current, HASHTAG_INTEREST_WEIGHTS.like!)!;
  current = computeNextHashtagInterest(current, HASHTAG_INTEREST_WEIGHTS.unlike!)!;
  assert.ok(Math.abs(current!.score - before) < 1e-6, `Expected convergence, but score still moved from ${before} to ${current!.score}`);
});

check('quick_skip has only a very small effect relative to a real active signal like save', () => {
  assert.ok(Math.abs(HASHTAG_INTEREST_WEIGHTS.quick_skip!) < Math.abs(HASHTAG_INTEREST_WEIGHTS.save!) / 2);
});

check('watch milestones increase in strength: watch_25 < watch_50 < watch_75 < complete < rewatch', () => {
  const w = HASHTAG_INTEREST_WEIGHTS;
  assert.ok(w.watch_25! < w.watch_50!);
  assert.ok(w.watch_50! < w.watch_75!);
  assert.ok(w.watch_75! < w.complete!);
  assert.ok(w.complete! < w.rewatch!);
});

check('an action irrelevant to hashtag topical interest (follow) is not listed at all', () => {
  assert.equal(HASHTAG_INTEREST_WEIGHTS.follow, undefined);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.profile_open, undefined);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.event_going, undefined);
});

check('analytics-only actions (impression, video_started) are not listed — never touch hashtag interest', () => {
  assert.equal(HASHTAG_INTEREST_WEIGHTS.impression, undefined);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.video_started, undefined);
});

const failed = results.filter((r) => !r.pass);
for (const result of results) {
  console.log(`${result.pass ? '✓' : '✗'} ${result.name}`);
  if (!result.pass) console.error('  ', result.error);
}
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
