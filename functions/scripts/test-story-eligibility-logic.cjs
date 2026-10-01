/**
 * Step 10A — plain-Node tests for the pure Story-media eligibility checks
 * in functions/src/media/storyEligibility.ts: checkStoryMediaEligibility
 * and checkStoryDeleteEligibility. These are the DECISION logic behind
 * requestMediaUploadAuthorization.ts's verifyStoryMediaOwnership and
 * deleteStoryMedia.ts's own ownership check — extracted into their own
 * dependency-free file specifically so this logic is directly testable
 * without a live Firestore/Admin SDK (see storyEligibility.ts's own doc
 * comment). Runs against the COMPILED lib/ output — `npm run build`
 * first.
 */
const assert = require('node:assert/strict');
const { checkStoryMediaEligibility, checkStoryDeleteEligibility } = require('../lib/media/storyEligibility.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const UID = 'author-uid-1';
const OTHER_UID = 'someone-else-uid';
const PHOTO_CONTENT_TYPE = 'image/jpeg';
const VIDEO_CONTENT_TYPE = 'video/mp4';

function baseVideoStory(overrides = {}) {
  return { authorUid: UID, status: 'uploading', mediaType: 'video', ...overrides };
}
function basePhotoStory(overrides = {}) {
  return { authorUid: UID, status: 'uploading', mediaType: 'photo', ...overrides };
}

// ---------------------------------------------------------------------------
// checkStoryMediaEligibility
// ---------------------------------------------------------------------------

check('media: nonexistent Story (null) is not-found', () => {
  const result = checkStoryMediaEligibility(null, UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-found');
});

check('media: wrong owner is permission-denied', () => {
  const result = checkStoryMediaEligibility(baseVideoStory(), OTHER_UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('media: status published is failed-precondition', () => {
  const result = checkStoryMediaEligibility(baseVideoStory({ status: 'published' }), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('media: a video Story with a video contentType is eligible', () => {
  assert.equal(checkStoryMediaEligibility(baseVideoStory(), UID, VIDEO_CONTENT_TYPE).ok, true);
});

check('media: a photo Story with an image contentType is eligible', () => {
  assert.equal(checkStoryMediaEligibility(basePhotoStory(), UID, PHOTO_CONTENT_TYPE).ok, true);
});

check('media: HEIC is accepted for a photo Story — same allowlist as a photo Reel, genuinely unnormalized library picks', () => {
  assert.equal(checkStoryMediaEligibility(basePhotoStory(), UID, 'image/heic').ok, true);
});

check('media: contentType mismatch — a video Story sending an image contentType is REJECTED', () => {
  const result = checkStoryMediaEligibility(baseVideoStory(), UID, PHOTO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('media: contentType mismatch — a photo Story sending a video contentType is REJECTED', () => {
  const result = checkStoryMediaEligibility(basePhotoStory(), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('media: an arbitrary/unsupported contentType is REJECTED regardless of the Story\'s own shape', () => {
  const result = checkStoryMediaEligibility(basePhotoStory(), UID, 'application/pdf');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('media: ownership is checked before status — a wrong-owner published-status combo still reports permission-denied', () => {
  const result = checkStoryMediaEligibility(baseVideoStory({ status: 'published' }), OTHER_UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.code, 'permission-denied');
});

// ---------------------------------------------------------------------------
// checkStoryDeleteEligibility — deliberately looser than checkStoryMediaEligibility:
// no status constraint, matching a Story's own simpler, single-tier delete
// model (storage.rules' own Story `allow delete` condition has none either).
// ---------------------------------------------------------------------------

check('delete: nonexistent Story is not-found', () => {
  assert.equal(checkStoryDeleteEligibility(null, UID).code, 'not-found');
});

check('delete: wrong owner is permission-denied', () => {
  assert.equal(checkStoryDeleteEligibility(baseVideoStory(), OTHER_UID).code, 'permission-denied');
});

check('delete: a still-uploading Story draft CAN be deleted/discarded', () => {
  assert.equal(checkStoryDeleteEligibility(baseVideoStory(), UID).ok, true);
});

check('delete: an already-published Story CAN also be deleted — unlike a Reel, a Story has no publish-locks-media-deletion rule', () => {
  assert.equal(checkStoryDeleteEligibility(baseVideoStory({ status: 'published' }), UID).ok, true);
});

check('delete: a photo Story can be deleted too, regardless of mediaType', () => {
  assert.equal(checkStoryDeleteEligibility(basePhotoStory({ status: 'published' }), UID).ok, true);
});

console.log('\n=== functions/ Story eligibility logic test results ===');
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
