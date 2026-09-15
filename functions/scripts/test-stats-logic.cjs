/**
 * Recommendation Engine — Step 4, Step 29 — plain-Node tests for the pure
 * (no Firestore Admin call) parts of engagementStats.ts: bumpField (Step
 * 8/21 — counters never go negative) and validateWatchSample (Step 11 —
 * an impossible/out-of-range watch sample is rejected or clamped, never
 * trusted as-is). Runs against the COMPILED lib/ output — `npm run build`
 * first (see the `test` script in package.json).
 *
 * This deliberately does NOT stand up the Firestore/Functions emulator —
 * withIdempotentStatsUpdate and every exported trigger itself need a
 * real (or emulated) Firestore Admin connection, which this pass does not
 * attempt to wire up (see this feature's own final report for exactly
 * what a follow-up emulator-based end-to-end validation would still need
 * to cover: real duplicate-event idempotency, real trigger firing on a
 * genuine document create/delete).
 */
const assert = require('node:assert/strict');
const { bumpField, validateWatchSample, isMeaningfulView } = require('../lib/engagementStats.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

// ---------------------------------------------------------------------------
// Step 8/21 — bumpField: counters never go negative.
// ---------------------------------------------------------------------------
check('bumpField floors a decrement at zero rather than going negative', () => {
  assert.equal(bumpField({ likes: 0 }, 'likes', -1), 0);
});
check('bumpField decrements normally once above zero', () => {
  assert.equal(bumpField({ likes: 3 }, 'likes', -1), 2);
});
check('bumpField treats a missing field as 0', () => {
  assert.equal(bumpField({}, 'likes', 1), 1);
});
check('bumpField treats a corrupt (non-number) field as 0 rather than propagating NaN', () => {
  assert.equal(bumpField({ likes: 'not-a-number' }, 'likes', 1), 1);
});
check('bumpField(floorAtZero=false) allows accumulating sums (totalWatchMs) without a zero floor', () => {
  assert.equal(bumpField({ totalWatchMs: 100 }, 'totalWatchMs', 50, false), 150);
});
check('bumpField can decrement well past zero and multiple times without ever reading below 0', () => {
  let likes = 1;
  likes = bumpField({ likes }, 'likes', -1); // 0
  likes = bumpField({ likes }, 'likes', -1); // still 0, never -1
  assert.equal(likes, 0);
});

// ---------------------------------------------------------------------------
// Step 11 — validateWatchSample: reject impossible durations, clamp
// out-of-range percentages.
// ---------------------------------------------------------------------------
check('a normal watch sample validates unchanged', () => {
  const result = validateWatchSample(3000, 0.6);
  assert.deepEqual(result, { watchDurationMs: 3000, watchPercentage: 0.6 });
});
check('a negative duration is rejected outright (not clamped to 0)', () => {
  assert.equal(validateWatchSample(-500, 0.5), null);
});
check('a NaN duration is rejected', () => {
  assert.equal(validateWatchSample(Number.NaN, 0.5), null);
});
check('a non-number duration is rejected', () => {
  assert.equal(validateWatchSample('5000', 0.5), null);
});
check('an implausible multi-hour duration on what must be a short Reel is rejected (Step 11’s own example)', () => {
  assert.equal(validateWatchSample(6 * 60 * 60 * 1000, 0.9), null);
});
check('an 800% watch percentage is clamped to 1, not rejected (Step 11’s own example)', () => {
  const result = validateWatchSample(5000, 8.0);
  assert.equal(result.watchPercentage, 1);
});
check('a negative watch percentage is clamped to 0', () => {
  const result = validateWatchSample(5000, -3);
  assert.equal(result.watchPercentage, 0);
});

// ---------------------------------------------------------------------------
// Step 5/12 — isMeaningfulView: the "watch >= 2s OR watch >= 25%" bar.
// ---------------------------------------------------------------------------
check('a view under both the duration and percentage bar is not meaningful', () => {
  assert.equal(isMeaningfulView({ watchDurationMs: 500, watchPercentage: 0.05 }), false);
});
check('a view clearing only the absolute-duration bar is meaningful (long video, low percentage)', () => {
  assert.equal(isMeaningfulView({ watchDurationMs: 3000, watchPercentage: 0.05 }), true);
});
check('a view clearing only the percentage bar is meaningful (short video, high percentage)', () => {
  assert.equal(isMeaningfulView({ watchDurationMs: 800, watchPercentage: 0.3 }), true);
});

console.log('\n=== functions/ engagement-stats logic test results ===');
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
