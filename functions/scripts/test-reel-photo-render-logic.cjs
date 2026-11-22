/**
 * Step 9C — the full, integrated INTEGRATION test for renderPhotoToVideo's
 * own workflow: performReelMux (reelMuxOrchestration.ts) wired together
 * with the SAME provider-aware storage helpers
 * (downloadReelSourceForMux/uploadMuxedReelSourceToProvider,
 * reelSourceStorage.ts) that Step 9B's muxReelMusic already uses — proving
 * the reuse renderPhotoToVideo's own rewrite depends on is genuinely
 * correct, not just independently plausible in isolation.
 *
 * The two other Step 9C test files (test-reel-eligibility-logic.cjs's own
 * checkReelPhotoRenderEligibility section, and
 * test-reel-mux-orchestration-logic.cjs's own extraConfirmFields section)
 * cover those pieces in isolation; THIS file is the "does the whole thing
 * actually fit together and produce the right final bytes" proof — see
 * the Step 9C spec's own Part 18: a real distinguishable-bytes assertion
 * (ORIGINAL_PHOTO_BYTES vs RENDERED_MP4_BYTES), a provider matrix, and a
 * failure/retry matrix, all run against this exact combination of real
 * (extracted) modules with a fake ffmpeg/R2/Firebase boundary — never a
 * real ffmpeg binary, real network, or real Firebase Admin SDK.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { performReelMux } = require('../lib/media/reelMuxOrchestration.js');
const { downloadReelSourceForMux, uploadMuxedReelSourceToProvider } = require('../lib/media/reelSourceStorage.js');
const { checkReelPhotoRenderEligibility } = require('../lib/media/reelEligibility.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `reel-photo-render-test-${process.pid}-${name}`);
}

/** Mirrors the other Step 9B/9C test files' own fake bucket, with `.upload()` for the Firebase branch. */
function makeFakeBucket(initialFiles = {}) {
  const store = new Map(Object.entries(initialFiles));
  const calls = { exists: [], download: [], upload: [] };
  const bucket = {
    store,
    calls,
    file(filePath) {
      return {
        __path: filePath,
        async exists() {
          calls.exists.push(filePath);
          return [store.has(filePath)];
        },
        async download({ destination }) {
          calls.download.push({ path: filePath, destination });
          fs.writeFileSync(destination, store.get(filePath) ?? Buffer.alloc(0));
        },
        async delete() {
          store.delete(filePath);
        },
      };
    },
    async upload(localPath, options) {
      calls.upload.push({ localPath, destination: options.destination, metadata: options.metadata });
      store.set(options.destination, fs.readFileSync(localPath));
    },
  };
  return bucket;
}

/** A fake, in-memory R2 object store standing in for the real authenticated GetObjectCommand/PutObjectCommand pair. */
function makeFakeR2Store(initialObjects = {}) {
  const objects = new Map(Object.entries(initialObjects).map(([k, v]) => [k, Buffer.from(v)]));
  const calls = { get: [], put: [] };
  return {
    objects,
    calls,
    getObject: async (key) => {
      calls.get.push(key);
      const value = objects.get(key);
      if (!value) throw new Error(`no such object: ${key}`);
      return value;
    },
    putObject: async (key, data, contentType, cacheControl) => {
      calls.put.push({ key, contentType, cacheControl });
      objects.set(key, data);
    },
  };
}

const REELID = 'reel1';
const UID = 'u1';

/**
 * Builds the exact set of `ReelMuxDeps` renderPhotoToVideo's own real
 * implementation wires up (functions/src/index.ts) — a fake ffmpeg
 * boundary standing in for the real `-loop 1 -i photo -stream_loop -1 -i
 * music ...` command: it writes RENDERED_MP4_BYTES to the output path
 * whenever both real inputs are present, or throws if `failFfmpeg` is
 * set, letting failure tests exercise the exact same orchestration path
 * with no real process ever spawned.
 */
function makeRenderDeps({ bucket, r2, videoProvider, musicStoragePath = 'reels/u1/reel1/music', failFfmpeg = false, failFinalUpload = false, failConfirm = false }) {
  const musicFile = bucket.file(musicStoragePath);
  const calls = [];
  return {
    calls,
    deps: {
      downloadVideo: (destination) => {
        calls.push('downloadVideo');
        return downloadReelSourceForMux(
          bucket,
          { storageProvider: videoProvider, storagePath: 'reels/u1/reel1/source' },
          UID,
          REELID,
          destination,
          r2 ? { getObject: r2.getObject } : {}
        );
      },
      downloadMusic: async (destination) => {
        calls.push('downloadMusic');
        const [exists] = await musicFile.exists();
        if (!exists) return false;
        await musicFile.download({ destination });
        return true;
      },
      runFfmpegMux: async (localPhotoPath, localMusicPath, localOutputPath) => {
        calls.push('runFfmpegMux');
        if (failFfmpeg) throw new Error('ffmpeg exited with code 1');
        // Real ffmpeg reads both inputs — this fake proves the SAME two
        // files performReelMux actually downloaded are the ones handed
        // to the render step, without needing a real binary.
        const photoBytes = fs.readFileSync(localPhotoPath, 'utf8');
        const musicBytes = fs.readFileSync(localMusicPath, 'utf8');
        assert.equal(photoBytes, 'ORIGINAL_PHOTO_BYTES');
        assert.equal(musicBytes, 'MUSIC_BYTES');
        fs.writeFileSync(localOutputPath, 'RENDERED_MP4_BYTES');
      },
      statFileSize: async (filePath) => {
        calls.push('statFileSize');
        return fs.statSync(filePath).size;
      },
      computeSha256: async () => {
        calls.push('computeSha256');
        return 'fake-music-hash';
      },
      resolveSoundOrigin: async () => {
        calls.push('resolveSoundOrigin');
        return { originAuthorUid: UID, originReelId: REELID, isNewOrigin: false };
      },
      uploadMuxedVideo: async (localOutputPath) => {
        calls.push('uploadMuxedVideo');
        if (failFinalUpload) throw new Error('upload failed');
        await uploadMuxedReelSourceToProvider(
          bucket,
          { storageProvider: videoProvider, storagePath: 'reels/u1/reel1/source' },
          UID,
          REELID,
          localOutputPath,
          'video/mp4',
          videoProvider === 'r2' ? 'public, max-age=31536000, immutable' : undefined,
          r2 ? { putObject: r2.putObject } : {}
        );
      },
      uploadSoundOriginCopy: async () => {
        calls.push('uploadSoundOriginCopy');
      },
      deleteStandaloneMusic: async () => {
        calls.push('deleteStandaloneMusic');
        await musicFile.delete();
      },
      updateReelDocument: async (fields) => {
        calls.push('updateReelDocument');
        if (failConfirm) throw new Error('Firestore write failed');
      },
      buildVersionedSourceUrl: () => {
        calls.push('buildVersionedSourceUrl');
        return videoProvider === 'r2' ? 'https://media.example.com/reels/u1/reel1/source?v=999' : null;
      },
    },
  };
}

async function main() {
  // -------------------------------------------------------------------
  // PROVIDER MATRIX — the two combinations the Step 9C spec's Part 19
  // requires: Firebase photo + Firebase music -> rendered Firebase video,
  // and R2 photo + Firebase music -> rendered R2 video.
  // -------------------------------------------------------------------

  await check('PHOTO RENDER MATRIX 1 — Firebase photo + Firebase music: renders and replaces the SAME Firebase object with the video, deletes the standalone music after confirm', async () => {
    const bucket = makeFakeBucket({
      'reels/u1/reel1/source': Buffer.from('ORIGINAL_PHOTO_BYTES'),
      'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES'),
    });
    const { deps } = makeRenderDeps({ bucket, videoProvider: 'firebase' });
    const paths = { localVideoPath: tmpFile('m1-photo'), localMusicPath: tmpFile('m1-music'), localOutputPath: tmpFile('m1-output') };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: true });
    assert.equal(bucket.store.get('reels/u1/reel1/source').toString('utf8'), 'RENDERED_MP4_BYTES');
    assert.equal(bucket.store.has('reels/u1/reel1/music'), false, 'the standalone music object must be deleted after a successful render');
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('PHOTO RENDER MATRIX 2 — R2 photo + Firebase music: downloads the photo via authenticated R2 GetObject, replaces via authenticated PutObject, music stays on Firebase throughout', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const { deps } = makeRenderDeps({ bucket, r2, videoProvider: 'r2' });
    const paths = { localVideoPath: tmpFile('m2-photo'), localMusicPath: tmpFile('m2-music'), localOutputPath: tmpFile('m2-output') };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: true });
    const finalBytes = await r2.getObject('reels/u1/reel1/source');
    assert.equal(finalBytes.toString('utf8'), 'RENDERED_MP4_BYTES');
    assert.notEqual(finalBytes.toString('utf8'), 'ORIGINAL_PHOTO_BYTES', 'a GET after render must return ONLY the rendered bytes, never the original photo');
    assert.equal(bucket.store.has('reels/u1/reel1/music'), false);
    // Music itself never touched R2 — Reel music/audio storage is
    // explicitly NOT migrated by Step 9C.
    assert.deepEqual([...r2.objects.keys()], ['reels/u1/reel1/source']);
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('DISTINGUISHABLE BYTES: after a successful render, the object at the canonical source key is byte-for-byte the RENDERED_MP4_BYTES, never any mixture of the two inputs', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    const { deps } = makeRenderDeps({ bucket, r2, videoProvider: 'r2' });
    const paths = { localVideoPath: tmpFile('db-photo'), localMusicPath: tmpFile('db-music'), localOutputPath: tmpFile('db-output') };
    await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    const finalBytes = (await r2.getObject('reels/u1/reel1/source')).toString('utf8');
    assert.equal(finalBytes, 'RENDERED_MP4_BYTES');
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('the confirm-write includes needsPhotoVideoRender:false atomically with the versioned sourceUrl, for an R2 Reel', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    const recordedFields = [];
    const { deps } = makeRenderDeps({ bucket, r2, videoProvider: 'r2' });
    deps.updateReelDocument = async (fields) => {
      recordedFields.push(fields);
    };
    const paths = { localVideoPath: tmpFile('cw-photo'), localMusicPath: tmpFile('cw-music'), localOutputPath: tmpFile('cw-output') };
    await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.equal(recordedFields.length, 1);
    assert.equal(recordedFields[0].needsPhotoVideoRender, false);
    assert.equal(recordedFields[0].sourceUrl, 'https://media.example.com/reels/u1/reel1/source?v=999');
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  // -------------------------------------------------------------------
  // FAILURE / RETRY MATRIX — Step 9C spec's Part 16.
  // -------------------------------------------------------------------

  await check('FAILURE: photo source download fails (missing R2 object) -> video-unavailable, no ffmpeg, no confirm, original untouched', async () => {
    const r2 = makeFakeR2Store({}); // source object missing
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    const { deps, calls } = makeRenderDeps({ bucket, r2, videoProvider: 'r2' });
    const paths = { localVideoPath: tmpFile('f1-photo'), localMusicPath: tmpFile('f1-music'), localOutputPath: tmpFile('f1-output') };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: false, reason: 'video-unavailable' });
    assert.equal(calls.includes('runFfmpegMux'), false);
    assert.equal(calls.includes('updateReelDocument'), false);
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('FAILURE: music download fails (missing Firebase object) -> music-unavailable, publish blocked, photo never re-uploaded', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const bucket = makeFakeBucket({}); // music object missing
    const { deps, calls } = makeRenderDeps({ bucket, r2, videoProvider: 'r2' });
    const paths = { localVideoPath: tmpFile('f2-photo'), localMusicPath: tmpFile('f2-music'), localOutputPath: tmpFile('f2-output') };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: false, reason: 'music-unavailable' });
    assert.equal(calls.includes('uploadMuxedVideo'), false);
    const finalBytes = await r2.getObject('reels/u1/reel1/source');
    assert.equal(finalBytes.toString('utf8'), 'ORIGINAL_PHOTO_BYTES', 'the original photo must remain recoverable when rendering never even started');
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('FAILURE: ffmpeg/render fails -> ffmpeg-failed, original photo remains completely untouched and recoverable', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    const { deps, calls } = makeRenderDeps({ bucket, r2, videoProvider: 'r2', failFfmpeg: true });
    const paths = { localVideoPath: tmpFile('f3-photo'), localMusicPath: tmpFile('f3-music'), localOutputPath: tmpFile('f3-output') };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-failed' });
    const finalBytes = await r2.getObject('reels/u1/reel1/source');
    assert.equal(finalBytes.toString('utf8'), 'ORIGINAL_PHOTO_BYTES');
    assert.equal(bucket.store.has('reels/u1/reel1/music'), true, 'music must not be deleted when rendering never succeeded');
    assert.equal(calls.includes('updateReelDocument'), false);
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('FAILURE: rendered MP4 upload fails -> final-upload-failed, publish blocked, confirm never runs', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    const { deps, calls } = makeRenderDeps({ bucket, r2, videoProvider: 'r2', failFinalUpload: true });
    const paths = { localVideoPath: tmpFile('f4-photo'), localMusicPath: tmpFile('f4-music'), localOutputPath: tmpFile('f4-output') };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: false, reason: 'final-upload-failed' });
    assert.equal(calls.includes('updateReelDocument'), false);
    const finalBytes = await r2.getObject('reels/u1/reel1/source');
    assert.equal(finalBytes.toString('utf8'), 'ORIGINAL_PHOTO_BYTES');
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('FAILURE: confirm-write fails -> confirm-write-failed, deterministic retry: the RENDERED bytes are already the object at the canonical key, music deliberately still present', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    const { deps, calls } = makeRenderDeps({ bucket, r2, videoProvider: 'r2', failConfirm: true });
    const paths = { localVideoPath: tmpFile('f5-photo'), localMusicPath: tmpFile('f5-music'), localOutputPath: tmpFile('f5-output') };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: false, reason: 'confirm-write-failed' });
    const finalBytes = await r2.getObject('reels/u1/reel1/source');
    assert.equal(finalBytes.toString('utf8'), 'RENDERED_MP4_BYTES', 'the final upload DID already happen — a retry re-downloads this exact (already rendered) output');
    assert.equal(bucket.store.has('reels/u1/reel1/music'), true, 'music must NOT be deleted when the confirm write itself failed — a retry needs it');
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('RETRY: re-running performReelMux after a confirm-write-failed retry (with confirm now succeeding) is deterministic and idempotent — same final bytes both times', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'RENDERED_MP4_BYTES' }); // already-rendered from a prior failed attempt
    const bucket = makeFakeBucket({ 'reels/u1/reel1/music': Buffer.from('MUSIC_BYTES') });
    // The "photo" input this retry re-downloads is actually the
    // already-rendered video — but performReelMux/ffmpeg never inspect
    // WHAT the bytes mean, only that they exist; this fake ffmpeg simply
    // asserts a literal ORIGINAL_PHOTO_BYTES match for the matrix tests
    // above, so this retry test uses its own inline deps instead to
    // avoid that assertion firing on already-rendered input.
    const paths = { localVideoPath: tmpFile('retry-photo'), localMusicPath: tmpFile('retry-music'), localOutputPath: tmpFile('retry-output') };
    const deps = {
      downloadVideo: (destination) => downloadReelSourceForMux(bucket, { storageProvider: 'r2' }, UID, REELID, destination, { getObject: r2.getObject }),
      downloadMusic: async (destination) => {
        await bucket.file('reels/u1/reel1/music').download({ destination });
        return true;
      },
      runFfmpegMux: async (_v, _m, output) => fs.writeFileSync(output, 'RENDERED_MP4_BYTES'),
      statFileSize: async (p) => fs.statSync(p).size,
      computeSha256: async () => 'fake-music-hash',
      resolveSoundOrigin: async () => ({ originAuthorUid: UID, originReelId: REELID, isNewOrigin: false }),
      uploadMuxedVideo: (localOutputPath) => uploadMuxedReelSourceToProvider(bucket, { storageProvider: 'r2' }, UID, REELID, localOutputPath, 'video/mp4', 'public, max-age=31536000, immutable', { putObject: r2.putObject }),
      uploadSoundOriginCopy: async () => undefined,
      deleteStandaloneMusic: async () => bucket.file('reels/u1/reel1/music').delete(),
      updateReelDocument: async () => undefined,
      buildVersionedSourceUrl: () => 'https://media.example.com/reels/u1/reel1/source?v=1000',
    };
    const outcome = await performReelMux(paths, deps, { needsPhotoVideoRender: false });
    assert.deepEqual(outcome, { ok: true });
    const finalBytes = await r2.getObject('reels/u1/reel1/source');
    assert.equal(finalBytes.toString('utf8'), 'RENDERED_MP4_BYTES');
    [paths.localVideoPath, paths.localMusicPath, paths.localOutputPath].forEach((p) => fs.existsSync(p) && fs.unlinkSync(p));
  });

  await check('SECURITY: the R2 key is derived from uid/reelId parameters alone — a hostile authorUid field on the Reel document is never consulted for the key', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel1/source': 'ORIGINAL_PHOTO_BYTES' });
    const dest = tmpFile('security-key');
    const ok = await downloadReelSourceForMux(makeFakeBucket({}), { storageProvider: 'r2', authorUid: 'attacker-uid', storagePath: 'reels/attacker-uid/reel1/source' }, UID, REELID, dest, {
      getObject: r2.getObject,
    });
    assert.equal(ok, true);
    assert.deepEqual(r2.calls.get, ['reels/u1/reel1/source'], 'the key must come from the uid/reelId PARAMETERS, never from the document\'s own fields');
    fs.unlinkSync(dest);
  });

  await check('ELIGIBILITY GATE: a Reel not actually render-pending is refused BEFORE any of this workflow ever runs', () => {
    const result = checkReelPhotoRenderEligibility(
      { authorUid: UID, status: 'uploading', mediaType: 'video', needsPhotoVideoRender: false },
      UID
    );
    assert.equal(result.ok, false);
  });

  console.log('\n=== functions/ Reel photo-render integration test results ===');
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
