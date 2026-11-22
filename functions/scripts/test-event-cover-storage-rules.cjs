/**
 * DETERMINISTIC MIRROR of firestore.rules' own `isValidEventShape`
 * coverStoragePath/coverStorageProvider clause, reimplemented here as a
 * plain JS predicate and tested against fixtures — same reasoning and
 * same real-emulator-unavailability caveat as
 * test-event-hashtag-rules.cjs/test-reel-rules-predicates.cjs's own top
 * doc comments (a `fetch failed`/`ECONNRESET` at the TCP level against
 * every emulator REST endpoint beyond its trivial health check,
 * reproduced across Node 18/20/22 — a sandbox/environment limitation).
 *
 * THIS FILE IS NOT A SUBSTITUTE for a real emulator run — it only proves
 * the PREDICATE LOGIC itself is correct, never that Firestore's real
 * rules engine parses/evaluates the actual `.rules` syntax identically
 * (the string concatenation into an equality check, the `in`/`hasOnly`
 * operators, etc.). Do not report this file's results as emulator
 * verification.
 *
 * Step 2B — the real rule now requires EXACT equality against
 * `eventCovers/{authorUid}/{contentId}/photo` (this document's own
 * `contentId`, not just a same-uid namespace prefix with an arbitrary
 * trailing segment). The tests below specifically exercise the
 * cross-Event-reuse case this tightening exists to reject.
 */
const assert = require('node:assert/strict');

// Mirrors firestore.rules' own isValidEventShape coverStoragePath/
// coverStorageProvider clause exactly (Step 2B version).
function isValidEventCoverStorageShape(data) {
  const hasPath = Object.prototype.hasOwnProperty.call(data, 'coverStoragePath');
  const hasProvider = Object.prototype.hasOwnProperty.call(data, 'coverStorageProvider');

  if (hasPath !== hasProvider) return false;
  if (hasProvider && data.coverStorageProvider !== 'firebase' && data.coverStorageProvider !== 'r2') return false;
  if (hasPath) {
    if (typeof data.coverStoragePath !== 'string') return false;
    const expected = `eventCovers/${data.authorUid}/${data.contentId}/photo`;
    if (data.coverStoragePath !== expected) return false;
  }
  return true;
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

const authorUid = 'u1';
const contentId = 'event-A';

check('no cover-storage fields at all (an Event with no cover, or a legacy Event) is valid', () => {
  assert.equal(isValidEventCoverStorageShape({ authorUid, contentId }), true);
});

check('both fields present, well-formed, EXACTLY matching this document\'s own authorUid + contentId, is valid', () => {
  assert.equal(
    isValidEventCoverStorageShape({ authorUid, contentId, coverStoragePath: `eventCovers/${authorUid}/${contentId}/photo`, coverStorageProvider: 'firebase' }),
    true
  );
});

check('a valid "r2" provider is also accepted', () => {
  assert.equal(
    isValidEventCoverStorageShape({ authorUid, contentId, coverStoragePath: `eventCovers/${authorUid}/${contentId}/photo`, coverStorageProvider: 'r2' }),
    true
  );
});

check('coverStoragePath present WITHOUT coverStorageProvider is rejected — they are written together or not at all', () => {
  assert.equal(isValidEventCoverStorageShape({ authorUid, contentId, coverStoragePath: `eventCovers/${authorUid}/${contentId}/photo` }), false);
});

check('coverStorageProvider present WITHOUT coverStoragePath is rejected', () => {
  assert.equal(isValidEventCoverStorageShape({ authorUid, contentId, coverStorageProvider: 'firebase' }), false);
});

check('an unrecognized coverStorageProvider value is rejected', () => {
  assert.equal(
    isValidEventCoverStorageShape({ authorUid, contentId, coverStoragePath: `eventCovers/${authorUid}/${contentId}/photo`, coverStorageProvider: 'aws-s3' }),
    false
  );
});

check('SECURITY — cross-Event reuse: a coverStoragePath for a DIFFERENT contentId (same author) is rejected', () => {
  assert.equal(
    isValidEventCoverStorageShape({
      authorUid,
      contentId,
      coverStoragePath: `eventCovers/${authorUid}/some-other-event-id/photo`,
      coverStorageProvider: 'firebase',
    }),
    false
  );
});

check('SECURITY — cross-user: a coverStoragePath under a DIFFERENT uid\'s namespace is rejected', () => {
  assert.equal(
    isValidEventCoverStorageShape({
      authorUid,
      contentId,
      coverStoragePath: `eventCovers/someone-else/${contentId}/photo`,
      coverStorageProvider: 'firebase',
    }),
    false
  );
});

check('SECURITY — a legacy draftId-scheme path (independent of this document\'s real contentId) is rejected', () => {
  assert.equal(
    isValidEventCoverStorageShape({
      authorUid,
      contentId,
      coverStoragePath: `eventCovers/${authorUid}/unrelated-random-draft-id/photo`,
      coverStorageProvider: 'firebase',
    }),
    false
  );
});

check('SECURITY — a path for an unrelated media kind (a Reel source key) is rejected', () => {
  assert.equal(
    isValidEventCoverStorageShape({ authorUid, contentId, coverStoragePath: `reels/${authorUid}/reel1/source`, coverStorageProvider: 'firebase' }),
    false
  );
});

check('a path missing the trailing /photo segment is rejected', () => {
  assert.equal(
    isValidEventCoverStorageShape({ authorUid, contentId, coverStoragePath: `eventCovers/${authorUid}/${contentId}`, coverStorageProvider: 'firebase' }),
    false
  );
});

check('a non-string coverStoragePath is rejected', () => {
  assert.equal(isValidEventCoverStorageShape({ authorUid, contentId, coverStoragePath: 12345, coverStorageProvider: 'firebase' }), false);
});

console.log('\n=== functions/ Event cover-storage rules predicate mirror test results (Step 2B — exact contentId binding) ===');
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
