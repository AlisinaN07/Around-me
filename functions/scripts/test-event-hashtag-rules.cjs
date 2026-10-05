/**
 * Step 12D — DETERMINISTIC MIRROR of firestore.rules' own `isValidEventShape`
 * hashtags addition (`data.hashtags is list && data.hashtags.size() <= 30`),
 * reimplemented here as a plain JS predicate and tested against fixtures.
 *
 * Real Firestore emulator rules testing (`npm run test:rules`) cannot
 * execute in this sandbox — see tests/firestore.rules.test.mjs and
 * functions/scripts/test-reel-rules-predicates.cjs's own top doc comment
 * for the full, already-diagnosed reason (a `fetch failed`/`ECONNRESET`
 * at the TCP level against every emulator REST endpoint beyond its
 * trivial health check, reproduced across Node 18/20/22 and multiple
 * firebase-tools versions — a sandbox/environment limitation, not
 * something fixable by editing this repo's own code). Re-confirmed for
 * this step rather than assumed: this file does NOT attempt to spin up
 * the emulator again, since that investigation already exists and
 * nothing about this step's own rule change would alter its outcome.
 *
 * THIS FILE IS NOT A SUBSTITUTE for that real emulator run — it only
 * proves the PREDICATE LOGIC itself is correct (the same scope the Reel
 * mirror file above already limits itself to), never that Firestore's
 * real rules engine parses/evaluates the actual `.rules` syntax
 * identically. The one real new thing this step's rule adds —
 * `data.hashtags is list && data.hashtags.size() <= 30` — is a direct,
 * line-for-line copy of the EXISTING Reel rule's own identical hashtags
 * check (reels/{reelId}'s isValidReelCreate), which that emulator-
 * limitation doc comment already applies to equally.
 */
const assert = require('node:assert/strict');

// Mirrors firestore.rules' own isValidEventShape hashtags clause exactly:
// `data.hashtags is list && data.hashtags.size() <= 30`.
function isValidEventHashtagsShape(hashtags) {
  return Array.isArray(hashtags) && hashtags.length <= 30;
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

check('an empty array is valid (an Event with no hashtags in its description)', () => {
  assert.equal(isValidEventHashtagsShape([]), true);
});
check('a normal small array of strings is valid', () => {
  assert.equal(isValidEventHashtagsShape(['music', 'karlstad']), true);
});
check('exactly 30 entries is valid — the bound is inclusive, matching Reel\'s own <= 30', () => {
  assert.equal(isValidEventHashtagsShape(Array.from({ length: 30 }, (_, i) => `tag${i}`)), true);
});
check('31 entries is rejected — one past the same bound Reels already enforce', () => {
  assert.equal(isValidEventHashtagsShape(Array.from({ length: 31 }, (_, i) => `tag${i}`)), false);
});
check('a non-array value (string, number, object, null, undefined) is always rejected', () => {
  assert.equal(isValidEventHashtagsShape('music'), false);
  assert.equal(isValidEventHashtagsShape(42), false);
  assert.equal(isValidEventHashtagsShape({}), false);
  assert.equal(isValidEventHashtagsShape(null), false);
  assert.equal(isValidEventHashtagsShape(undefined), false);
});

console.log('\n=== functions/ Event hashtags rules-predicate mirror test results ===');
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
if (failures > 0) process.exit(1);
