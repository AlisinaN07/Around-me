/**
 * Step 9A — plain-Node tests for the pure Reel-media eligibility checks in
 * functions/src/media/reelEligibility.ts: checkReelThumbnailEligibility,
 * checkReelVideoEligibility, checkReelDiscardEligibility. These are the
 * DECISION logic behind requestMediaUploadAuthorization.ts's
 * verifyReelThumbnailOwnership/verifyReelVideoOwnership and
 * discardReelSource.ts's own ownership check — extracted into their own
 * dependency-free file specifically so this logic is directly testable
 * without a live Firestore/Admin SDK (see reelEligibility.ts's own doc
 * comment). Runs against the COMPILED lib/ output — `npm run build` first.
 *
 * This is the authoritative coverage for Part 7's authorization-security
 * matrix (unauthenticated is checked one level up, in handleRequest,
 * before either eligibility function is ever reached — not re-tested
 * here) and Part 5's ownership/status/mediaType/music/render-pending
 * cases, plus discardReelSource's own ownership+status checks (Part 8).
 */
const assert = require('node:assert/strict');
const {
  checkReelThumbnailEligibility,
  checkReelVideoEligibility,
  checkReelDiscardEligibility,
} = require('../lib/media/reelEligibility.js');

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

/** A plain, eligible video Reel with no music and no pending render — the ONE variant R2 video upload should accept. */
function baseEligibleVideoReel(overrides = {}) {
  return {
    authorUid: UID,
    status: 'uploading',
    mediaType: 'video',
    musicSourceType: 'none',
    needsPhotoVideoRender: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkReelThumbnailEligibility
// ---------------------------------------------------------------------------

check('thumbnail: nonexistent Reel (null) is not-found', () => {
  const result = checkReelThumbnailEligibility(null, UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-found');
});

check('thumbnail: wrong owner is permission-denied', () => {
  const result = checkReelThumbnailEligibility(baseEligibleVideoReel(), OTHER_UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('thumbnail: status published is failed-precondition', () => {
  const result = checkReelThumbnailEligibility(baseEligibleVideoReel({ status: 'published' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('thumbnail: photo mediaType is failed-precondition — no separate thumbnail object exists', () => {
  const result = checkReelThumbnailEligibility(baseEligibleVideoReel({ mediaType: 'photo' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('thumbnail: a video Reel WITH music is still ELIGIBLE for a thumbnail upload — music only affects the video source', () => {
  const result = checkReelThumbnailEligibility(baseEligibleVideoReel({ musicSourceType: 'device' }), UID);
  assert.equal(result.ok, true);
});

check('thumbnail: a render-pending video Reel is still ELIGIBLE for a thumbnail upload', () => {
  const result = checkReelThumbnailEligibility(baseEligibleVideoReel({ needsPhotoVideoRender: true, musicSourceType: 'device' }), UID);
  assert.equal(result.ok, true);
});

check('thumbnail: correct owner + uploading + video is eligible', () => {
  assert.equal(checkReelThumbnailEligibility(baseEligibleVideoReel(), UID).ok, true);
});

// ---------------------------------------------------------------------------
// checkReelVideoEligibility — Part 5's core matrix
// ---------------------------------------------------------------------------

check('video: nonexistent Reel (null) is not-found', () => {
  const result = checkReelVideoEligibility(null, UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-found');
});

check('video: wrong owner is permission-denied', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel(), OTHER_UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('video: status published is failed-precondition', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ status: 'published' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: photo Reel is REJECTED — Part 5/16, photo Reels never reach the reelVideo R2 path', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ mediaType: 'photo' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: music Reel (musicSourceType "device") is REJECTED — Part 4/2 migration-scope exclusion', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ musicSourceType: 'device' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: pending photo-render Reel (needsPhotoVideoRender true) is REJECTED even though mediaType is already "video"', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ needsPhotoVideoRender: true, musicSourceType: 'device' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: pending photo-render Reel is rejected even if (hypothetically) musicSourceType were "none" — needsPhotoVideoRender alone is disqualifying', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ needsPhotoVideoRender: true }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: plain video, no music, no pending render, correct owner, uploading — the ONE eligible shape', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel(), UID);
  assert.equal(result.ok, true);
});

check('video: ownership is checked before status — a wrong-owner nonexistent-status combo still reports permission-denied, not failed-precondition (checks run in a fixed order)', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ status: 'published' }), OTHER_UID);
  assert.equal(result.code, 'permission-denied');
});

// ---------------------------------------------------------------------------
// checkReelDiscardEligibility — deliberately looser than checkReelVideoEligibility
// ---------------------------------------------------------------------------

check('discard: nonexistent Reel is not-found', () => {
  assert.equal(checkReelDiscardEligibility(null, UID).code, 'not-found');
});

check('discard: wrong owner is permission-denied', () => {
  assert.equal(checkReelDiscardEligibility(baseEligibleVideoReel(), OTHER_UID).code, 'permission-denied');
});

check('discard: published Reel is rejected — mirrors storage.rules\' own Reel-source allow-delete condition exactly', () => {
  const result = checkReelDiscardEligibility(baseEligibleVideoReel({ status: 'published' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('discard: a photo Reel draft CAN be discarded — discard has no mediaType/music/render constraint, unlike video-upload authorization', () => {
  assert.equal(checkReelDiscardEligibility(baseEligibleVideoReel({ mediaType: 'photo' }), UID).ok, true);
});

check('discard: a music Reel draft CAN be discarded', () => {
  assert.equal(checkReelDiscardEligibility(baseEligibleVideoReel({ musicSourceType: 'device' }), UID).ok, true);
});

check('discard: a render-pending Reel draft CAN be discarded', () => {
  assert.equal(checkReelDiscardEligibility(baseEligibleVideoReel({ needsPhotoVideoRender: true }), UID).ok, true);
});

check('discard: correct owner + uploading is eligible regardless of media shape', () => {
  assert.equal(checkReelDiscardEligibility(baseEligibleVideoReel(), UID).ok, true);
});

console.log('\n=== functions/ Reel eligibility logic test results ===');
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
