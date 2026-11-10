/**
 * Plain-Node tests for checkDeleteOwnMediaEligibility
 * (functions/src/media/deleteOwnMediaEligibility.ts) — the pure decision
 * behind the deleteOwnMedia callable (the real implementation behind
 * src/services/media/r2Provider.ts's own r2MediaProvider.delete).
 *
 * Deliberately does NOT import deleteOwnMedia.ts itself (the real
 * callable) — it transitively pulls in firebase-functions/v2/https, which
 * cannot be `require()`'d under this project's plain-Node test runner
 * (see test-media-upload-auth-logic.cjs's own doc comment for the
 * confirmed reason). This is exactly why the allowlist decision was
 * extracted into its own, dependency-free file in the first place.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { checkDeleteOwnMediaEligibility } = require('../lib/media/deleteOwnMediaEligibility.js');
const { profileCoverKey, profilePhotoKey } = require('../lib/media/objectKey.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const uid = 'u1';

check('the caller\'s own profilePhotoKey is eligible', () => {
  assert.deepEqual(checkDeleteOwnMediaEligibility(uid, profilePhotoKey(uid)), { ok: true });
});

check('the caller\'s own profileCoverKey is eligible', () => {
  assert.deepEqual(checkDeleteOwnMediaEligibility(uid, profileCoverKey(uid)), { ok: true });
});

check('another user\'s profilePhotoKey is rejected with permission-denied', () => {
  const result = checkDeleteOwnMediaEligibility(uid, profilePhotoKey('someone-else'));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('an unrelated object (a Reel source key) is rejected with permission-denied', () => {
  const result = checkDeleteOwnMediaEligibility(uid, 'reels/u1/reel123/source');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('a made-up/arbitrary string is rejected with permission-denied, never trusted', () => {
  const result = checkDeleteOwnMediaEligibility(uid, 'anything-i-want');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('missing path (undefined) is rejected with invalid-argument, not a crash', () => {
  const result = checkDeleteOwnMediaEligibility(uid, undefined);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid-argument');
});

check('a non-string path (number/object/null) is rejected with invalid-argument', () => {
  assert.equal(checkDeleteOwnMediaEligibility(uid, 42).code, 'invalid-argument');
  assert.equal(checkDeleteOwnMediaEligibility(uid, {}).code, 'invalid-argument');
  assert.equal(checkDeleteOwnMediaEligibility(uid, null).code, 'invalid-argument');
});

check('an empty string is rejected with invalid-argument', () => {
  assert.equal(checkDeleteOwnMediaEligibility(uid, '').code, 'invalid-argument');
});

console.log('\n=== functions/ deleteOwnMedia eligibility logic test results ===');
let failures = 0;
for (const result of results) {
  if (result.pass) {
    console.log(`PASS — ${result.name}`);
  } else {
    failures += 1;
    console.log(`FAIL — ${result.name}`);
    console.log(`       ${result.error instanceof Error ? result.error.stack : result.error}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed.`);
if (failures > 0) process.exit(1);
