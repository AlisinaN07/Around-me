/**
 * Step 9B — plain-Node tests for performReelMux
 * (functions/src/media/reelMuxOrchestration.ts) — the full, pure
 * orchestration behind muxReelMusic: download video -> download music ->
 * run ffmpeg -> upload the muxed result back -> sound attribution ->
 * confirm Firestore -> best-effort delete the standalone music object.
 *
 * The ffmpeg boundary is a FAKE (`runFfmpegMux`) — this file never shells
 * out to a real binary, per this session's own "fake ffmpeg/process
 * boundary where needed" instruction. Every other dependency is a plain
 * spy/fake too, so this exercises the REAL workflow logic — including the
 * critical Step 9B ordering fix (Firestore confirm BEFORE the standalone
 * music delete, not after) — deterministically, with no I/O at all.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { performReelMux } = require('../lib/media/reelMuxOrchestration.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const PATHS = { localVideoPath: '/tmp/video', localMusicPath: '/tmp/music', localOutputPath: '/tmp/output.mp4' };

/** A fully-wired, all-succeeding fake dependency set — individual tests override just the piece they want to fail. Every call is recorded in `calls` so tests can assert exact ordering. */
function makeDeps(overrides = {}) {
  const calls = [];
  const base = {
    downloadVideo: async (path) => {
      calls.push(['downloadVideo', path]);
      return true;
    },
    downloadMusic: async (path) => {
      calls.push(['downloadMusic', path]);
      return true;
    },
    runFfmpegMux: async (video, music, output) => {
      calls.push(['runFfmpegMux', video, music, output]);
    },
    statFileSize: async (path) => {
      calls.push(['statFileSize', path]);
      return 12345;
    },
    computeSha256: async (path) => {
      calls.push(['computeSha256', path]);
      return 'fake-music-hash';
    },
    resolveSoundOrigin: async (musicHash) => {
      calls.push(['resolveSoundOrigin', musicHash]);
      return { originAuthorUid: 'uid1', originReelId: 'reel1', isNewOrigin: false };
    },
    uploadMuxedVideo: async (path) => {
      calls.push(['uploadMuxedVideo', path]);
    },
    uploadSoundOriginCopy: async (path, hash) => {
      calls.push(['uploadSoundOriginCopy', path, hash]);
    },
    deleteStandaloneMusic: async () => {
      calls.push(['deleteStandaloneMusic']);
    },
    updateReelDocument: async (fields) => {
      calls.push(['updateReelDocument', fields]);
    },
    buildVersionedSourceUrl: () => {
      calls.push(['buildVersionedSourceUrl']);
      return null;
    },
    ...overrides,
  };
  return { deps: base, calls };
}

async function main() {
  await check('happy path (Firebase-equivalent, no versioned URL): succeeds, writes the correct fields, never adds sourceUrl when buildVersionedSourceUrl returns null', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    const updateCall = calls.find((c) => c[0] === 'updateReelDocument');
    assert.ok(updateCall, 'updateReelDocument must have been called');
    assert.deepEqual(updateCall[1], {
      storageContentType: 'video/mp4',
      fileSizeBytes: 12345,
      musicHash: 'fake-music-hash',
      soundOriginAuthorUid: 'uid1',
      soundOriginReelId: 'reel1',
    });
    assert.equal('sourceUrl' in updateCall[1], false, 'a Firebase (or unconfigured) Reel must never gain a sourceUrl field from mux');
  });

  await check('happy path (R2, versioned URL present): the confirm-write includes the freshly-built sourceUrl', async () => {
    const { deps, calls } = makeDeps({ buildVersionedSourceUrl: () => 'https://media.example.com/reels/uid1/reel1/source?v=999' });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    const updateCall = calls.find((c) => c[0] === 'updateReelDocument');
    assert.equal(updateCall[1].sourceUrl, 'https://media.example.com/reels/uid1/reel1/source?v=999');
  });

  await check('CRITICAL ORDERING: updateReelDocument runs BEFORE deleteStandaloneMusic, never after', async () => {
    const { deps, calls } = makeDeps();
    await performReelMux(PATHS, deps);
    const updateIndex = calls.findIndex((c) => c[0] === 'updateReelDocument');
    const deleteIndex = calls.findIndex((c) => c[0] === 'deleteStandaloneMusic');
    assert.ok(updateIndex >= 0 && deleteIndex >= 0, 'both calls must have happened');
    assert.ok(updateIndex < deleteIndex, `expected updateReelDocument (index ${updateIndex}) before deleteStandaloneMusic (index ${deleteIndex})`);
  });

  await check('video-unavailable: downloadVideo returns false — nothing else is ever attempted', async () => {
    const { deps, calls } = makeDeps({
      downloadVideo: async (path) => {
        calls.push(['downloadVideo', path]);
        return false;
      },
    });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'video-unavailable' });
    assert.deepEqual(calls.map((c) => c[0]), ['downloadVideo']);
  });

  await check('music-unavailable (Firebase music download fails): no ffmpeg, no upload, no confirm', async () => {
    const { deps, calls } = makeDeps({
      downloadMusic: async (path) => {
        calls.push(['downloadMusic', path]);
        return false;
      },
    });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'music-unavailable' });
    assert.deepEqual(calls.map((c) => c[0]), ['downloadVideo', 'downloadMusic']);
  });

  await check('ffmpeg-failed: runFfmpegMux throws — no upload, no confirm, the ORIGINAL source is never touched', async () => {
    const { deps, calls } = makeDeps({
      runFfmpegMux: async () => {
        throw new Error('ffmpeg exited with code 1');
      },
    });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-failed' });
    assert.equal(calls.some((c) => c[0] === 'uploadMuxedVideo'), false, 'the original source must never be overwritten when ffmpeg itself failed');
    assert.equal(calls.some((c) => c[0] === 'updateReelDocument'), false);
  });

  await check('ffmpeg-empty-output: ffmpeg "succeeds" but produces a zero-byte file — treated as failure, never uploaded', async () => {
    const { deps, calls } = makeDeps({ statFileSize: async () => 0 });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-empty-output' });
    assert.equal(calls.some((c) => c[0] === 'uploadMuxedVideo'), false);
  });

  await check('final-upload-failed: uploadMuxedVideo throws — publish must be blocked, confirm never runs', async () => {
    const { deps, calls } = makeDeps({
      uploadMuxedVideo: async () => {
        throw new Error('R2 PutObject failed');
      },
    });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'final-upload-failed' });
    assert.equal(calls.some((c) => c[0] === 'updateReelDocument'), false);
  });

  await check('sound-origin-copy-failed: a genuinely NEW sound whose permanent-copy upload fails is a hard failure, not swallowed', async () => {
    const { deps, calls } = makeDeps({
      resolveSoundOrigin: async () => ({ originAuthorUid: 'uid1', originReelId: 'reel1', isNewOrigin: true }),
      uploadSoundOriginCopy: async () => {
        throw new Error('Firebase upload failed');
      },
    });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'sound-origin-copy-failed' });
    assert.equal(calls.some((c) => c[0] === 'updateReelDocument'), false);
  });

  await check('uploadSoundOriginCopy is skipped entirely when isNewOrigin is false (the common "sound already seen before" case)', async () => {
    const { deps, calls } = makeDeps({ resolveSoundOrigin: async () => ({ originAuthorUid: 'uid1', originReelId: 'reel1', isNewOrigin: false }) });
    await performReelMux(PATHS, deps);
    assert.equal(calls.some((c) => c[0] === 'uploadSoundOriginCopy'), false);
  });

  await check('uploadSoundOriginCopy IS called, with the exact musicHash, when isNewOrigin is true', async () => {
    const { deps, calls } = makeDeps({ resolveSoundOrigin: async () => ({ originAuthorUid: 'uid1', originReelId: 'reel1', isNewOrigin: true }) });
    await performReelMux(PATHS, deps);
    const call = calls.find((c) => c[0] === 'uploadSoundOriginCopy');
    assert.ok(call);
    assert.equal(call[2], 'fake-music-hash');
  });

  await check('confirm-write-failed: updateReelDocument throws — Part 15\'s "deterministic retry" scenario: the muxed video is already the object at the canonical key, but Firestore hasn\'t caught up yet, and the standalone music is deliberately still there (delete never ran)', async () => {
    const { deps, calls } = makeDeps({
      updateReelDocument: async () => {
        throw new Error('Firestore write failed');
      },
    });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'confirm-write-failed' });
    assert.equal(calls.some((c) => c[0] === 'uploadMuxedVideo'), true, 'the final upload DID already happen');
    assert.equal(calls.some((c) => c[0] === 'deleteStandaloneMusic'), false, 'music must NOT be deleted when the confirm write itself failed — a retry needs it');
  });

  await check('a failed deleteStandaloneMusic (best-effort) never fails the overall mux — the confirm already succeeded', async () => {
    const { deps } = makeDeps({
      deleteStandaloneMusic: async () => {
        throw new Error('Firebase delete failed');
      },
    });
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
  });

  await check('idempotent retry: calling performReelMux twice with the SAME all-succeeding deps produces the same successful outcome both times (no dependency on prior-call state)', async () => {
    const { deps } = makeDeps();
    const first = await performReelMux(PATHS, deps);
    const second = await performReelMux(PATHS, deps);
    assert.deepEqual(first, { ok: true });
    assert.deepEqual(second, { ok: true });
  });

  // ---------------------------------------------------------------------------
  // Step 9C — the `extraConfirmFields` parameter, added specifically so
  // renderPhotoToVideo (functions/src/index.ts) can reuse this ENTIRE
  // orchestration unchanged otherwise, merging its own
  // `{ needsPhotoVideoRender: false }` into the exact same atomic
  // confirm-write.
  // ---------------------------------------------------------------------------

  await check('extraConfirmFields defaults to {} — omitting the third argument entirely (muxReelMusic\'s own call shape) changes nothing about the confirm-write', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await performReelMux(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    const updateCall = calls.find((c) => c[0] === 'updateReelDocument');
    assert.deepEqual(updateCall[1], {
      storageContentType: 'video/mp4',
      fileSizeBytes: 12345,
      musicHash: 'fake-music-hash',
      soundOriginAuthorUid: 'uid1',
      soundOriginReelId: 'reel1',
    });
  });

  await check('extraConfirmFields (Step 9C — renderPhotoToVideo\'s own usage): needsPhotoVideoRender:false is merged into the SAME atomic confirm-write, alongside every field this function already writes', async () => {
    const { deps, calls } = makeDeps();
    const outcome = await performReelMux(PATHS, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: true });
    const updateCall = calls.find((c) => c[0] === 'updateReelDocument');
    assert.deepEqual(updateCall[1], {
      needsPhotoVideoRender: false,
      storageContentType: 'video/mp4',
      fileSizeBytes: 12345,
      musicHash: 'fake-music-hash',
      soundOriginAuthorUid: 'uid1',
      soundOriginReelId: 'reel1',
    });
  });

  await check('extraConfirmFields + a versioned sourceUrl (R2 photo-render case) both land in the same write', async () => {
    const { deps, calls } = makeDeps({ buildVersionedSourceUrl: () => 'https://media.example.com/reels/uid1/reel1/source?v=999' });
    const outcome = await performReelMux(PATHS, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: true });
    const updateCall = calls.find((c) => c[0] === 'updateReelDocument');
    assert.equal(updateCall[1].needsPhotoVideoRender, false);
    assert.equal(updateCall[1].sourceUrl, 'https://media.example.com/reels/uid1/reel1/source?v=999');
  });

  await check('extraConfirmFields is NEVER written when the confirm-write itself never runs (e.g. ffmpeg-failed) — no partial/stray state', async () => {
    const { deps, calls } = makeDeps({
      runFfmpegMux: async () => {
        throw new Error('ffmpeg exited with code 1');
      },
    });
    const outcome = await performReelMux(PATHS, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-failed' });
    assert.equal(calls.some((c) => c[0] === 'updateReelDocument'), false);
  });

  console.log('\n=== functions/ Reel mux orchestration logic test results ===');
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
}

main();
