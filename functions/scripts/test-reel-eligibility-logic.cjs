/**
 * Step 9A/9B/9C — plain-Node tests for the pure Reel-media eligibility
 * checks in functions/src/media/reelEligibility.ts:
 * checkReelThumbnailEligibility, checkReelVideoEligibility,
 * checkReelDiscardEligibility, checkReelMuxEligibility (Step 9B), and
 * checkReelPhotoRenderEligibility (Step 9C). These are the DECISION logic
 * behind requestMediaUploadAuthorization.ts's verifyReelThumbnailOwnership/
 * verifyReelVideoOwnership, discardReelSource.ts's own ownership check,
 * index.ts's own muxReelMusic, and (Step 9C) index.ts's own
 * renderPhotoToVideo — extracted into their own dependency-free file
 * specifically so this logic is directly testable without a live
 * Firestore/Admin SDK (see reelEligibility.ts's own doc comment). Runs
 * against the COMPILED lib/ output — `npm run build` first.
 *
 * This is the authoritative coverage for Part 5/7's authorization-security
 * matrix (unauthenticated is checked one level up, in handleRequest,
 * before either eligibility function is ever reached — not re-tested
 * here), Step 9B's own eligibility-relaxation matrix (Part 15's
 * "Eligibility" list), Step 9C's own eligibility relaxation (photo/
 * render-pending Reels, plus the new contentType cross-check), and
 * discardReelSource's/muxReelMusic's/renderPhotoToVideo's own
 * ownership+status checks.
 */
const assert = require('node:assert/strict');
const {
  checkReelThumbnailEligibility,
  checkReelVideoEligibility,
  checkReelDiscardEligibility,
  checkReelMuxEligibility,
  checkReelPhotoRenderEligibility,
  checkReelMusicUploadEligibility,
  checkReelVideoFinalizationEligibility,
} = require('../lib/media/reelEligibility.js');

const VIDEO_CONTENT_TYPE = 'video/mp4';
const PHOTO_CONTENT_TYPE = 'image/jpeg';
const AUDIO_CONTENT_TYPE = 'audio/mp4';

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

/** Step 9C — a plain photo Reel: never render-pending, no music constraint at all. */
function baseEligiblePhotoReel(overrides = {}) {
  return {
    authorUid: UID,
    status: 'uploading',
    mediaType: 'photo',
    needsPhotoVideoRender: false,
    ...overrides,
  };
}

/** Step 9C — a "FOTO"-with-music render-pending Reel: mediaType stays 'video', needsPhotoVideoRender true, always device music with a real musicStorageAudioPath (see CreateReelDraftInput.photoRenderPending's own doc comment in src/services/reels.ts). */
function baseEligibleRenderPendingReel(overrides = {}) {
  return baseEligibleMusicVideoReel({
    needsPhotoVideoRender: true,
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
// checkReelVideoEligibility — Step 9A's original matrix, Step 9B's
// relaxation (device-music video also eligible), and Step 9C's own
// relaxation (photo AND render-pending are now eligible too, plus the new
// contentType cross-check).
// ---------------------------------------------------------------------------

check('video: nonexistent Reel (null) is not-found', () => {
  const result = checkReelVideoEligibility(null, UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'not-found');
});

check('video: wrong owner is permission-denied', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel(), OTHER_UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('video: status published is failed-precondition', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ status: 'published' }), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: an unrecognized mediaType is REJECTED — only "video"/"photo" are real Reel media kinds', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ mediaType: 'story' }), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: plain video, no music, no pending render — the Step 9A eligible shape, unaffected by Step 9B/9C', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel(), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, true);
});

check('video: Step 9B — a video Reel WITH device-picked music, and a real musicStorageAudioPath, is ELIGIBLE', () => {
  const result = checkReelVideoEligibility(baseEligibleMusicVideoReel(), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, true);
});

check('video: Step 9B — a music Reel missing musicStorageAudioPath (inconsistent state) is REJECTED, not silently accepted', () => {
  const result = checkReelVideoEligibility(baseEligibleMusicVideoReel({ musicStorageAudioPath: '' }), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: Step 9B — a music Reel with musicStorageAudioPath missing entirely (not even an empty string) is REJECTED', () => {
  const reel = baseEligibleMusicVideoReel();
  delete reel.musicStorageAudioPath;
  const result = checkReelVideoEligibility(reel, UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: an unrecognized/future musicSourceType value is REJECTED — an allowlist, not a blocklist', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ musicSourceType: 'catalog' }), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: Step 9C — a render-pending Reel (needsPhotoVideoRender true) with valid device music is now ELIGIBLE — renderPhotoToVideo is provider-aware', () => {
  const result = checkReelVideoEligibility(baseEligibleRenderPendingReel(), UID, PHOTO_CONTENT_TYPE);
  assert.equal(result.ok, true);
});

check('video: Step 9C — a plain photo Reel is now ELIGIBLE, with no music constraint at all', () => {
  const result = checkReelVideoEligibility(baseEligiblePhotoReel(), UID, PHOTO_CONTENT_TYPE);
  assert.equal(result.ok, true);
});

check('video: Step 9C — a plain photo Reel is eligible even with an unrecognized musicSourceType — photo variant never checks music state', () => {
  const result = checkReelVideoEligibility(baseEligiblePhotoReel({ musicSourceType: 'catalog' }), UID, PHOTO_CONTENT_TYPE);
  assert.equal(result.ok, true);
});

check('video: Step 9C — contentType mismatch: a plain video Reel sending an IMAGE content type is REJECTED', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel(), UID, PHOTO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: Step 9C — contentType mismatch: a plain photo Reel sending a VIDEO content type is REJECTED', () => {
  const result = checkReelVideoEligibility(baseEligiblePhotoReel(), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: Step 9C — contentType mismatch: a render-pending Reel sending a VIDEO content type is REJECTED — its storagePath still holds the ORIGINAL PHOTO', () => {
  const result = checkReelVideoEligibility(baseEligibleRenderPendingReel(), UID, VIDEO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: Step 9C — HEIC is accepted for a plain photo Reel — genuinely unnormalized library-picked photos', () => {
  const result = checkReelVideoEligibility(baseEligiblePhotoReel(), UID, 'image/heic');
  assert.equal(result.ok, true);
});

check('video: Step 9C — an arbitrary/unsupported contentType is REJECTED regardless of the Reel\'s own shape', () => {
  const result = checkReelVideoEligibility(baseEligiblePhotoReel(), UID, 'application/pdf');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('video: ownership is checked before status — a wrong-owner nonexistent-status combo still reports permission-denied, not failed-precondition (checks run in a fixed order)', () => {
  const result = checkReelVideoEligibility(baseEligibleVideoReel({ status: 'published' }), OTHER_UID, VIDEO_CONTENT_TYPE);
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

// ---------------------------------------------------------------------------
// checkReelPhotoRenderEligibility — Step 9C, renderPhotoToVideo's own
// ownership/status/music-consistency gate, extracted from that function's
// pre-existing inline checks the same way Step 9B extracted
// checkReelMuxEligibility from muxReelMusic's.
// ---------------------------------------------------------------------------

check('photoRender: nonexistent Reel (null) is not-found', () => {
  assert.equal(checkReelPhotoRenderEligibility(null, UID).code, 'not-found');
});

check('photoRender: wrong owner is permission-denied', () => {
  assert.equal(checkReelPhotoRenderEligibility(baseEligibleRenderPendingReel(), OTHER_UID).code, 'permission-denied');
});

check('photoRender: status published is failed-precondition — render only ever runs pre-publish', () => {
  const result = checkReelPhotoRenderEligibility(baseEligibleRenderPendingReel({ status: 'published' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('photoRender: a plain photo Reel (mediaType "photo") is REJECTED — never render-pending by definition', () => {
  const result = checkReelPhotoRenderEligibility(baseEligiblePhotoReel(), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('photoRender: a plain video Reel (needsPhotoVideoRender false) is REJECTED — nothing to render', () => {
  const result = checkReelPhotoRenderEligibility(baseEligibleMusicVideoReel({ needsPhotoVideoRender: false }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('photoRender: a render-pending Reel with no music at all is REJECTED — this render mode always has device music by construction', () => {
  const result = checkReelPhotoRenderEligibility(baseEligibleRenderPendingReel({ musicSourceType: 'none' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('photoRender: a render-pending Reel missing musicStorageAudioPath (inconsistent state) is REJECTED', () => {
  const result = checkReelPhotoRenderEligibility(baseEligibleRenderPendingReel({ musicStorageAudioPath: '' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('photoRender: a valid, owned, uploading, render-pending Reel with real device music is eligible', () => {
  assert.equal(checkReelPhotoRenderEligibility(baseEligibleRenderPendingReel(), UID).ok, true);
});

check('photoRender: eligibility does NOT depend on storageProvider — an R2-sourced render-pending Reel is exactly as eligible as a Firebase one', () => {
  assert.equal(checkReelPhotoRenderEligibility(baseEligibleRenderPendingReel({ storageProvider: 'r2' }), UID).ok, true);
  assert.equal(checkReelPhotoRenderEligibility(baseEligibleRenderPendingReel({ storageProvider: 'firebase' }), UID).ok, true);
});

// ---------------------------------------------------------------------------
// checkReelMusicUploadEligibility — Step 10B, the music-upload authorization
// gate built ON TOP of checkReelMuxEligibility (same ownership/status/music-
// state preconditions as a mux run — nothing to upload music FOR unless the
// Reel is already in a mux-eligible music state), plus one additional
// contentType cross-check against the wide `audio/*` allowlist storage.rules
// itself already uses (device file-picker output is unbounded, unlike
// camera/library video or photo output — see reelMusicStorage.ts's own doc
// comment).
// ---------------------------------------------------------------------------

check('musicUpload: nonexistent Reel (null) is not-found — inherited from checkReelMuxEligibility', () => {
  assert.equal(checkReelMusicUploadEligibility(null, UID, AUDIO_CONTENT_TYPE).code, 'not-found');
});

check('musicUpload: wrong owner is permission-denied — inherited from checkReelMuxEligibility', () => {
  const result = checkReelMusicUploadEligibility(baseEligibleMusicVideoReel(), OTHER_UID, AUDIO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('musicUpload: status published is failed-precondition — inherited from checkReelMuxEligibility', () => {
  const result = checkReelMusicUploadEligibility(baseEligibleMusicVideoReel({ status: 'published' }), UID, AUDIO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('musicUpload: a Reel with no music at all (musicSourceType "none") is REJECTED — inherited from checkReelMuxEligibility, nothing to upload for', () => {
  const result = checkReelMusicUploadEligibility(baseEligibleVideoReel(), UID, AUDIO_CONTENT_TYPE);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('musicUpload: a valid, owned, uploading, device-music Reel with a real audio contentType is ELIGIBLE', () => {
  assert.equal(checkReelMusicUploadEligibility(baseEligibleMusicVideoReel(), UID, AUDIO_CONTENT_TYPE).ok, true);
});

check('musicUpload: a wide range of real "audio/*" MIME types are all accepted — device file-picker output is unbounded, mirrors storage.rules\' own wildcard', () => {
  for (const contentType of ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/flac']) {
    const result = checkReelMusicUploadEligibility(baseEligibleMusicVideoReel(), UID, contentType);
    assert.equal(result.ok, true, `expected "${contentType}" to be accepted`);
  }
});

check('musicUpload: a non-audio contentType is REJECTED regardless of the Reel\'s own shape', () => {
  for (const contentType of ['video/mp4', 'image/jpeg', 'application/pdf', '']) {
    const result = checkReelMusicUploadEligibility(baseEligibleMusicVideoReel(), UID, contentType);
    assert.equal(result.ok, false, `expected "${contentType}" to be rejected`);
    assert.equal(result.code, 'failed-precondition');
  }
});

check('musicUpload: eligibility does NOT depend on storageProvider — an R2-sourced video Reel is exactly as eligible for a music upload as a Firebase one', () => {
  assert.equal(checkReelMusicUploadEligibility(baseEligibleMusicVideoReel({ storageProvider: 'r2' }), UID, AUDIO_CONTENT_TYPE).ok, true);
  assert.equal(checkReelMusicUploadEligibility(baseEligibleMusicVideoReel({ storageProvider: 'firebase' }), UID, AUDIO_CONTENT_TYPE).ok, true);
});

check('musicUpload: a render-pending Reel is also eligible for a music upload — same base gate as mux', () => {
  assert.equal(checkReelMusicUploadEligibility(baseEligibleRenderPendingReel(), UID, AUDIO_CONTENT_TYPE).ok, true);
});

check('musicUpload: ownership is checked before status — a wrong-owner published-status combo still reports permission-denied, not failed-precondition', () => {
  const result = checkReelMusicUploadEligibility(baseEligibleMusicVideoReel({ status: 'published' }), OTHER_UID, AUDIO_CONTENT_TYPE);
  assert.equal(result.code, 'permission-denied');
});

// ---------------------------------------------------------------------------
// checkReelVideoFinalizationEligibility — Step 11B, finalizeReelVideo's
// own gate, scoped to EXACTLY the plain-video/no-music/not-render-pending
// variant (muxReelMusic/renderPhotoToVideo own the other two).
// ---------------------------------------------------------------------------

check('finalize: nonexistent Reel (null) is not-found', () => {
  assert.equal(checkReelVideoFinalizationEligibility(null, UID).code, 'not-found');
});

check('finalize: wrong owner is permission-denied', () => {
  const result = checkReelVideoFinalizationEligibility(baseEligibleVideoReel(), OTHER_UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'permission-denied');
});

check('finalize: status published is failed-precondition — finalization only ever runs pre-publish', () => {
  const result = checkReelVideoFinalizationEligibility(baseEligibleVideoReel({ status: 'published' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('finalize: a plain photo Reel (mediaType "photo") is REJECTED — Part 9, never transcode a photo', () => {
  const result = checkReelVideoFinalizationEligibility(baseEligiblePhotoReel(), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('finalize: a render-pending Reel is REJECTED — renderPhotoToVideo finalizes that variant itself, in the same pass that renders it', () => {
  const result = checkReelVideoFinalizationEligibility(baseEligibleRenderPendingReel(), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('finalize: a Reel WITH device music is REJECTED — muxReelMusic finalizes that variant itself, in the same pass that merges the music', () => {
  const result = checkReelVideoFinalizationEligibility(baseEligibleMusicVideoReel(), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('finalize: a plain video Reel with no music and no pending render is ELIGIBLE — exactly the pre-11B gap this closes', () => {
  assert.equal(checkReelVideoFinalizationEligibility(baseEligibleVideoReel(), UID).ok, true);
});

check('finalize: eligibility does NOT depend on storageProvider or sourceNormalized — the idempotency short-circuit is the CALLER\'s own job, one level up, not this gate\'s', () => {
  assert.equal(checkReelVideoFinalizationEligibility(baseEligibleVideoReel({ storageProvider: 'r2' }), UID).ok, true);
  assert.equal(checkReelVideoFinalizationEligibility(baseEligibleVideoReel({ sourceNormalized: true }), UID).ok, true);
  assert.equal(checkReelVideoFinalizationEligibility(baseEligibleVideoReel({ sourceNormalized: false }), UID).ok, true);
});

check('finalize: an unrecognized/future musicSourceType value is REJECTED — an allowlist (only "none" passes), not a blocklist', () => {
  const result = checkReelVideoFinalizationEligibility(baseEligibleVideoReel({ musicSourceType: 'catalog' }), UID);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'failed-precondition');
});

check('finalize: ownership is checked before status — a wrong-owner published-status combo still reports permission-denied, not failed-precondition', () => {
  const result = checkReelVideoFinalizationEligibility(baseEligibleVideoReel({ status: 'published' }), OTHER_UID);
  assert.equal(result.code, 'permission-denied');
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
