/**
 * Step 9B — plain-Node tests for the two new provider-aware mux storage
 * helpers in functions/src/media/reelSourceStorage.ts:
 * downloadReelSourceForMux and uploadMuxedReelSourceToProvider. These
 * back muxReelMusic's own video read/replace, on EITHER backend — see
 * that file's own doc comments for why they're deliberately separate
 * from downloadReelSourceToLocalFile/copyReelSourceToFirebaseStoryObject
 * (Step 9A's own public-URL-based helpers): mux needs an AUTHENTICATED
 * R2 read/write (GetObjectCommand/PutObjectCommand), never the public
 * delivery URL.
 *
 * The R2 side is exercised against a fake, in-memory R2 object store
 * (not a real HTTP server — these two functions never call `fetch` at
 * all, only the injected `getObject`/`putObject`) so this test also
 * doubles as the "mux provider matrix" and "R2 music mux path" coverage
 * from the Step 9B spec.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { downloadReelSourceForMux, uploadMuxedReelSourceToProvider } = require('../lib/media/reelSourceStorage.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

/** Mirrors test-reel-source-storage-logic.cjs's own fake bucket, extended with `.upload()` (needed by uploadMuxedReelSourceToProvider's Firebase branch). */
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

function tmpFile(name) {
  return path.join(os.tmpdir(), `reel-mux-storage-test-${process.pid}-${name}`);
}

async function main() {
  // -------------------------------------------------------------------
  // downloadReelSourceForMux
  // -------------------------------------------------------------------

  await check('download-for-mux: Firebase Reel — uses bucket.file(storagePath).download(), never touches the R2 store', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('ORIGINAL_VIDEO_BYTES') });
    const r2 = makeFakeR2Store();
    const dest = tmpFile('fb-download');
    const ok = await downloadReelSourceForMux(bucket, { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' }, 'u1', 'r1', dest, {
      getObject: r2.getObject,
    });
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from('ORIGINAL_VIDEO_BYTES'));
    assert.equal(r2.calls.get.length, 0);
    fs.unlinkSync(dest);
  });

  await check('download-for-mux: Firebase Reel whose object is missing returns false', async () => {
    const bucket = makeFakeBucket({});
    const ok = await downloadReelSourceForMux(bucket, { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' }, 'u1', 'r1', tmpFile('missing'));
    assert.equal(ok, false);
  });

  await check('download-for-mux: R2 Reel — uses the AUTHENTICATED getObject, deriving the key from uid+reelId (never trusting a stored path/URL field)', async () => {
    const bucket = makeFakeBucket({});
    const r2 = makeFakeR2Store({ 'reels/u1/r1/source': 'ORIGINAL_VIDEO_BYTES' });
    const dest = tmpFile('r2-download');
    // Deliberately a reel object with NO storagePath/sourceUrl at all —
    // proving the key comes from the uid/reelId PARAMETERS, not from
    // anything read off the document.
    const ok = await downloadReelSourceForMux(bucket, { storageProvider: 'r2' }, 'u1', 'r1', dest, { getObject: r2.getObject });
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from('ORIGINAL_VIDEO_BYTES'));
    assert.deepEqual(r2.calls.get, ['reels/u1/r1/source']);
    fs.unlinkSync(dest);
  });

  await check('download-for-mux: R2 Reel whose authenticated read fails returns false, never throws', async () => {
    const r2 = makeFakeR2Store({});
    const ok = await downloadReelSourceForMux(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'r1', tmpFile('r2-missing'), { getObject: r2.getObject });
    assert.equal(ok, false);
  });

  await check('download-for-mux: R2 key derivation is uid/reelId-specific — a different reelId never collides', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/reel-a/source': 'A', 'reels/u1/reel-b/source': 'B' });
    const destA = tmpFile('a');
    const destB = tmpFile('b');
    await downloadReelSourceForMux(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'reel-a', destA, { getObject: r2.getObject });
    await downloadReelSourceForMux(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'reel-b', destB, { getObject: r2.getObject });
    assert.equal(fs.readFileSync(destA, 'utf8'), 'A');
    assert.equal(fs.readFileSync(destB, 'utf8'), 'B');
    fs.unlinkSync(destA);
    fs.unlinkSync(destB);
  });

  // -------------------------------------------------------------------
  // uploadMuxedReelSourceToProvider — the "replacement semantics" test:
  // after a simulated mux, a read of the canonical key must return ONLY
  // the muxed bytes, never the original.
  // -------------------------------------------------------------------

  await check('upload-muxed: Firebase Reel — overwrites the SAME storagePath via bucket.upload(), replacing original bytes entirely', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('ORIGINAL_VIDEO_BYTES') });
    const localMuxed = tmpFile('muxed-source-fb');
    fs.writeFileSync(localMuxed, 'MUXED_VIDEO_BYTES');
    await uploadMuxedReelSourceToProvider(bucket, { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' }, 'u1', 'r1', localMuxed, 'video/mp4', undefined);
    assert.deepEqual(bucket.store.get('reels/u1/r1/source'), Buffer.from('MUXED_VIDEO_BYTES'));
    assert.equal(bucket.calls.upload[0].metadata.contentType, 'video/mp4');
    fs.unlinkSync(localMuxed);
  });

  await check('upload-muxed: R2 Reel — REPLACEMENT SEMANTICS: after upload, a GET for the canonical key returns ONLY the muxed bytes, never the original', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/r1/source': 'ORIGINAL_VIDEO_BYTES' });
    const localMuxed = tmpFile('muxed-source-r2');
    fs.writeFileSync(localMuxed, 'MUXED_VIDEO_BYTES');
    await uploadMuxedReelSourceToProvider(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'r1', localMuxed, 'video/mp4', 'public, max-age=31536000, immutable', {
      putObject: r2.putObject,
    });
    const finalBytes = await r2.getObject('reels/u1/r1/source');
    assert.equal(finalBytes.toString('utf8'), 'MUXED_VIDEO_BYTES');
    assert.notEqual(finalBytes.toString('utf8'), 'ORIGINAL_VIDEO_BYTES');
    fs.unlinkSync(localMuxed);
  });

  await check('upload-muxed: R2 Reel — putObject receives the correct contentType and cacheControl', async () => {
    const r2 = makeFakeR2Store();
    const localMuxed = tmpFile('muxed-cc');
    fs.writeFileSync(localMuxed, 'MUXED_VIDEO_BYTES');
    await uploadMuxedReelSourceToProvider(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'r1', localMuxed, 'video/mp4', 'public, max-age=31536000, immutable', {
      putObject: r2.putObject,
    });
    assert.equal(r2.calls.put[0].contentType, 'video/mp4');
    assert.equal(r2.calls.put[0].cacheControl, 'public, max-age=31536000, immutable');
    fs.unlinkSync(localMuxed);
  });

  await check('upload-muxed: R2 Reel — key derivation uses ONLY uid+reelId (never the Reel document\'s own fields, which may not even be present)', async () => {
    const r2 = makeFakeR2Store();
    const localMuxed = tmpFile('muxed-key-derivation');
    fs.writeFileSync(localMuxed, 'MUXED_VIDEO_BYTES');
    // No storagePath/sourceUrl on the reel object at all.
    await uploadMuxedReelSourceToProvider(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'r1', localMuxed, 'video/mp4', undefined, { putObject: r2.putObject });
    assert.deepEqual(r2.calls.put.map((c) => c.key), ['reels/u1/r1/source']);
    fs.unlinkSync(localMuxed);
  });

  // -------------------------------------------------------------------
  // Full mux provider matrix — download original (Firebase or R2) then
  // "mux" (a plain string transform standing in for ffmpeg) then upload
  // back to the SAME provider, proving the whole read+replace round trip
  // for both supported combinations.
  // -------------------------------------------------------------------

  await check('MUX PROVIDER MATRIX 1 — source Firebase + music Firebase: download original from Firebase, replace with muxed bytes on Firebase', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('ORIGINAL_VIDEO_BYTES'), 'reels/u1/r1/music': Buffer.from('MUSIC_BYTES') });
    const videoDest = tmpFile('matrix1-video');
    const musicDest = tmpFile('matrix1-music');
    const videoOk = await downloadReelSourceForMux(bucket, { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' }, 'u1', 'r1', videoDest);
    await bucket.file('reels/u1/r1/music').download({ destination: musicDest });
    assert.equal(videoOk, true);
    assert.equal(fs.readFileSync(videoDest, 'utf8'), 'ORIGINAL_VIDEO_BYTES');
    assert.equal(fs.readFileSync(musicDest, 'utf8'), 'MUSIC_BYTES');
    const muxedOutput = tmpFile('matrix1-output');
    fs.writeFileSync(muxedOutput, 'MUXED_VIDEO_BYTES');
    await uploadMuxedReelSourceToProvider(bucket, { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' }, 'u1', 'r1', muxedOutput, 'video/mp4', undefined);
    assert.equal(bucket.store.get('reels/u1/r1/source').toString('utf8'), 'MUXED_VIDEO_BYTES');
    [videoDest, musicDest, muxedOutput].forEach((p) => fs.unlinkSync(p));
  });

  await check('MUX PROVIDER MATRIX 2 — source R2 + music Firebase: download original from R2 (authenticated), music from Firebase, replace on R2', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/music': Buffer.from('MUSIC_BYTES') });
    const r2 = makeFakeR2Store({ 'reels/u1/r1/source': 'ORIGINAL_VIDEO_BYTES' });
    const videoDest = tmpFile('matrix2-video');
    const musicDest = tmpFile('matrix2-music');
    const videoOk = await downloadReelSourceForMux(bucket, { storageProvider: 'r2' }, 'u1', 'r1', videoDest, { getObject: r2.getObject });
    await bucket.file('reels/u1/r1/music').download({ destination: musicDest });
    assert.equal(videoOk, true);
    assert.equal(fs.readFileSync(videoDest, 'utf8'), 'ORIGINAL_VIDEO_BYTES');
    assert.equal(fs.readFileSync(musicDest, 'utf8'), 'MUSIC_BYTES');
    const muxedOutput = tmpFile('matrix2-output');
    fs.writeFileSync(muxedOutput, 'MUXED_VIDEO_BYTES');
    await uploadMuxedReelSourceToProvider(bucket, { storageProvider: 'r2' }, 'u1', 'r1', muxedOutput, 'video/mp4', 'public, max-age=31536000, immutable', {
      putObject: r2.putObject,
    });
    const finalBytes = await r2.getObject('reels/u1/r1/source');
    assert.equal(finalBytes.toString('utf8'), 'MUXED_VIDEO_BYTES');
    // No unnecessary permanent intermediate R2 object was created — the
    // ONLY key ever written to is the canonical source key itself.
    assert.deepEqual([...r2.objects.keys()], ['reels/u1/r1/source']);
    [videoDest, musicDest, muxedOutput].forEach((p) => fs.unlinkSync(p));
  });

  await check('NO UNSUPPORTED PROVIDER COMBINATION accidentally works: an unrecognized storageProvider value falls back to the Firebase code path (never silently treated as R2)', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('ORIGINAL_VIDEO_BYTES') });
    const r2 = makeFakeR2Store();
    const dest = tmpFile('unsupported-provider');
    const ok = await downloadReelSourceForMux(bucket, { storageProvider: 'some-future-provider', storagePath: 'reels/u1/r1/source' }, 'u1', 'r1', dest, { getObject: r2.getObject });
    assert.equal(ok, true);
    assert.equal(r2.calls.get.length, 0, 'an unrecognized provider value must never reach the R2 code path');
    fs.unlinkSync(dest);
  });

  console.log('\n=== functions/ Reel mux provider-aware storage logic test results ===');
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
