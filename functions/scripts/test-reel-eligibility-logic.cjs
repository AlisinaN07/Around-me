/**
 * Step 9A/9B — plain-Node tests for the pure Reel-media eligibility checks
 * in functions/src/media/reelEligibility.ts: checkReelThumbnailEligibility,
 * checkReelVideoEligibility, checkReelDiscardEligibility, and (Step 9B)
 * checkReelMuxEligibility. These are the DECISION logic behind
 * requestMediaUploadAuthorization.ts's verifyReelThumbnailOwnership/
 * verifyReelVideoOwnership, discardReelSource.ts's own ownership check,
 * and index.ts's own muxReelMusic — extracted into their own
 * dependency-free file specifically so this logic is directly testable
 * without a live Firestore/Admin SDK (see reelEligibility.ts's own doc
 * comment). Runs against the COMPILED lib/ output — `npm run build` first.
 *
 * This is the authoritative coverage for Part 5/7's authorization-security
 * matrix (unauthenticated is checked one level up, in handleRequest,
 * before either eligibility function is ever reached — not re-tested
 * here), Step 9B's own eligibility-relaxation matrix (Part 15's
 * "Eligibility" list), and discardReelSource's/muxReelMusic's own
 * ownership+status checks.
 */
const assert = require('node:assert/strict');
const {
  checkReelThumbnailEligibility,
  checkReelVideoEligibility,
  checkReelDiscardEligibility,
  checkReelMuxEligibility,
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

/** A plain, eligible video Reel with no music and no pending render — the baseline every test mutates from. */
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

/** Same baseline, but with a real, consistent device-picked music state — musicSourceType alone is never enough on a real document; a genuine music Reel always also has a real musicStorageAudioPath (see createReelDraft in src/services/reels.ts). Tests that specifically want to exercise an INCONSISTENT state override musicStorageAudioPath back out explicitly. */
function baseEligibleMusicVideoReel(overrides = {}) {
  return baseEligibleVideoReel({
    musicSourceType: 'device',
    musicStorageAudioPath: `reels/${UID}/reel1/music`,
    musicStorageContentType: 'audio/mp4',
    musicTitle: 'Song.mp3',
    ...overrides,
  });
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
  const result = checkReelThumbnailEligibility(baseEligibleMusicVideoReel(), UID);
  assert.equal(result.ok, true);
});

check('thumbnail: a render-pending video Reel is still ELIGIBLE for a thumbnail upload', () => {
  const result = checkReelThumbnailEligibility(baseEligibleMusicVideoReel({ needsPhotoVideoRender: true }), UID);
  assert.equal(result.ok, true);
});

check('thumbnail: correct owner + uploading + video is eligible', () => {
  assert.equal(checkReelThumbnailEligibility(baseEligibleVideoReel(), UID).ok, true);
});

// ---------------------------------------------------------------------------
// checkReelVideoEligibility — Step 9A's original matrix plus Step 9B's
// relaxation (plain video AND device-music video are now both eligible;
// photo and render-pending remain excluded either way).
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

check('video: photo Reel is REJECTED — Part 14/16, photo Reels never reach the reelVideo R2 path', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ mediaType: 'photo' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: plain video, no music, no pending render — the Step 9A eligible shape, unaffected by Step 9B', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel(), UID);
  assert.equal(result.ok, true);
});

check('video: Step 9B — a video Reel WITH device-picked music, and a real musicStorageAudioPath, is now ELIGIBLE', () => {
  const result = checkReelVideoEligibility(baseEligibleMusicVideoReel(), UID);
  assert.equal(result.ok, true);
});

check('video: Step 9B — a music Reel missing musicStorageAudioPath (inconsistent state) is REJECTED, not silently accepted', () => {
  const result = checkReelVideoEligibility(baseEligibleMusicVideoReel({ musicStorageAudioPath: '' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: Step 9B — a music Reel with musicStorageAudioPath missing entirely (not even an empty string) is REJECTED', () => {
  const reel = baseEligibleMusicVideoReel();
  delete reel.musicStorageAudioPath;
  const result = checkReelVideoEligibility(reel, UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: an unrecognized/future musicSourceType value is REJECTED — an allowlist, not a blocklist', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ musicSourceType: 'catalog' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: pending photo-render Reel (needsPhotoVideoRender true) is REJECTED even with otherwise-valid device music', () => {
  const result = checkReelVideoEligibility(baseEligibleMusicVideoReel({ needsPhotoVideoRender: true }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: pending photo-render Reel is rejected even with no music at all — needsPhotoVideoRender alone is disqualifying', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ needsPhotoVideoRender: true }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
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
  assert.equal(checkReelDiscardEligibility(baseEligibleMusicVideoReel(), UID).ok, true);
});

check('discard: a render-pending Reel draft CAN be discarded', () => {
  assert.equal(checkReelDiscardEligibility(baseEligibleVideoReel({ needsPhotoVideoRender: true }), UID).ok, true);
});

check('discard: correct owner + uploading is eligible regardless of media shape', () => {
  assert.equal(checkReelDiscardEligibility(baseEligibleVideoReel(), UID).ok, true);
});

// ---------------------------------------------------------------------------
// checkReelMuxEligibility — Step 9B, muxReelMusic's own ownership/status/
// music-consistency gate.
// ---------------------------------------------------------------------------

check('mux: nonexistent Reel (null) is not-found', () => {
  assert.equal(checkReelMuxEligibility(null, UID).code, 'not-found');
});

check('mux: wrong owner is permission-denied', () => {
  assert.equal(checkReelMuxEligibility(baseEligibleMusicVideoReel(), OTHER_UID).code, 'permission-denied');
});

check('mux: status published is failed-precondition — mux only ever runs pre-publish', () => {
  const result = checkReelMuxEligibility(baseEligibleMusicVideoReel({ status: 'published' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('mux: a Reel with no music at all (musicSourceType "none") is rejected — nothing to merge', () => {
  const result = checkReelMuxEligibility(baseEligibleVideoReel(), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('mux: a music Reel missing musicStorageAudioPath (inconsistent state) is REJECTED — Part 9\'s own "reject inconsistent states"', () => {
  const result = checkReelMuxEligibility(baseEligibleMusicVideoReel({ musicStorageAudioPath: '' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('mux: a valid, owned, uploading, device-music Reel with a real musicStorageAudioPath is eligible', () => {
  assert.equal(checkReelMuxEligibility(baseEligibleMusicVideoReel(), UID).ok, true);
});

check('mux: eligibility does NOT depend on storageProvider — an R2-sourced music Reel is exactly as eligible for mux as a Firebase one', () => {
  assert.equal(checkReelMuxEligibility(baseEligibleMusicVideoReel({ storageProvider: 'r2' }), UID).ok, true);
  assert.equal(checkReelMuxEligibility(baseEligibleMusicVideoReel({ storageProvider: 'firebase' }), UID).ok, true);
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
