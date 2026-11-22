/**
 * Step 10B — plain-Node tests for the two new provider-aware Reel-MUSIC
 * storage helpers in functions/src/media/reelMusicStorage.ts:
 * downloadReelMusicToLocalFile and deleteReelMusic. These back
 * muxReelMusic's/renderPhotoToVideo's own music read (functions/src/index.ts)
 * and their shared `deleteStandaloneMusic` step — see that file's own doc
 * comment for why they're deliberately separate from
 * downloadReelSourceForMux/uploadMuxedReelSourceToProvider (a Reel's
 * video source, Step 9B): music is read-and-deleted only, never
 * rewritten/replaced server-side.
 *
 * This file is ALSO the authoritative coverage for the Step 10B spec's
 * own "Mux matrix" and "Photo-render matrix" requirements — both
 * muxReelMusic and renderPhotoToVideo wire downloadReelSourceForMux
 * (video/photo) together with downloadReelMusicToLocalFile (music) via
 * the exact same performReelMux orchestration, so proving all 4
 * source x music provider combinations work correctly against the REAL
 * (extracted) storage functions here covers both call sites at once —
 * performReelMux itself (reelMuxOrchestration.ts) is provider-agnostic
 * and already covered in isolation by test-reel-mux-orchestration-logic.cjs.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { downloadReelMusicToLocalFile, deleteReelMusic } = require('../lib/media/reelMusicStorage.js');
const { downloadReelSourceForMux } = require('../lib/media/reelSourceStorage.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

/** Mirrors every other Step 9A-10B test file's own fake bucket. */
function makeFakeBucket(initialFiles = {}) {
  const store = new Map(Object.entries(initialFiles));
  const calls = { exists: [], download: [], delete: [] };
  return {
    store,
    calls,
    file(filePath) {
      return {
        async exists() {
          calls.exists.push(filePath);
          return [store.has(filePath)];
        },
        async download({ destination }) {
          calls.download.push({ path: filePath, destination });
          fs.writeFileSync(destination, store.get(filePath) ?? Buffer.alloc(0));
        },
        async delete(options) {
          calls.delete.push({ path: filePath, options });
          store.delete(filePath);
        },
      };
    },
  };
}

function makeFakeR2Store(initialObjects = {}) {
  const objects = new Map(Object.entries(initialObjects).map(([k, v]) => [k, Buffer.from(v)]));
  const calls = { get: [], delete: [] };
  return {
    objects,
    calls,
    getObject: async (key) => {
      calls.get.push(key);
      const value = objects.get(key);
      if (!value) throw new Error(`no such object: ${key}`);
      return value;
    },
    deleteObject: async (key) => {
      calls.delete.push(key);
      objects.delete(key);
    },
  };
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `reel-music-storage-test-${process.pid}-${name}`);
}

const UID = 'u1';
const REEL_ID = 'r1';

async function main() {
  // -------------------------------------------------------------------
  // downloadReelMusicToLocalFile
  // -------------------------------------------------------------------

  await check('download-music: Firebase Reel — uses bucket.file(musicStorageAudioPath).download(), never touches the R2 store', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/music': Buffer.from('MUSIC_BYTES') });
    const r2 = makeFakeR2Store();
    const dest = tmpFile('fb-download');
    const ok = await downloadReelMusicToLocalFile(
      bucket,
      { musicStorageProvider: 'firebase', musicStorageAudioPath: 'reels/u1/r1/music' },
      UID,
      REEL_ID,
      dest,
      { getObject: r2.getObject }
    );
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from('MUSIC_BYTES'));
    assert.equal(r2.calls.get.length, 0);
    fs.unlinkSync(dest);
  });

  await check('download-music: Firebase Reel whose music object is missing returns false', async () => {
    const ok = await downloadReelMusicToLocalFile(
      makeFakeBucket({}),
      { musicStorageProvider: 'firebase', musicStorageAudioPath: 'reels/u1/r1/music' },
      UID,
      REEL_ID,
      tmpFile('missing')
    );
    assert.equal(ok, false);
  });

  await check('download-music: R2 Reel — uses the AUTHENTICATED getObject, deriving the key from uid+reelId (never trusting a stored path field)', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/r1/music': 'MUSIC_BYTES' });
    const dest = tmpFile('r2-download');
    // Deliberately no musicStorageAudioPath field at all — proving the
    // key comes from the uid/reelId PARAMETERS.
    const ok = await downloadReelMusicToLocalFile(makeFakeBucket({}), { musicStorageProvider: 'r2' }, UID, REEL_ID, dest, { getObject: r2.getObject });
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from('MUSIC_BYTES'));
    assert.deepEqual(r2.calls.get, ['reels/u1/r1/music']);
    fs.unlinkSync(dest);
  });

  await check('download-music: R2 Reel whose authenticated read fails returns false, never throws', async () => {
    const r2 = makeFakeR2Store({});
    const ok = await downloadReelMusicToLocalFile(makeFakeBucket({}), { musicStorageProvider: 'r2' }, UID, REEL_ID, tmpFile('r2-missing'), { getObject: r2.getObject });
    assert.equal(ok, false);
  });

  await check('download-music: legacy Reel missing musicStorageProvider entirely defaults to Firebase', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/music': Buffer.from('MUSIC_BYTES') });
    const dest = tmpFile('legacy');
    const ok = await downloadReelMusicToLocalFile(bucket, { musicStorageAudioPath: 'reels/u1/r1/music' }, UID, REEL_ID, dest);
    assert.equal(ok, true);
    fs.unlinkSync(dest);
  });

  // -------------------------------------------------------------------
  // deleteReelMusic
  // -------------------------------------------------------------------

  await check('delete-music: Firebase Reel — deletes via bucket.file().delete({ignoreNotFound:true})', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/music': Buffer.from('MUSIC_BYTES') });
    await deleteReelMusic(bucket, { musicStorageProvider: 'firebase', musicStorageAudioPath: 'reels/u1/r1/music' }, UID, REEL_ID);
    assert.equal(bucket.store.has('reels/u1/r1/music'), false);
  });

  await check('delete-music: R2 Reel — deletes via the authenticated deleteObject, at the deterministic reelMusicKey', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/r1/music': 'MUSIC_BYTES' });
    await deleteReelMusic(makeFakeBucket({}), { musicStorageProvider: 'r2' }, UID, REEL_ID, { deleteObject: r2.deleteObject });
    assert.deepEqual(r2.calls.delete, ['reels/u1/r1/music']);
    assert.equal(r2.objects.has('reels/u1/r1/music'), false);
  });

  await check('delete-music: a failed R2 delete is caught — never throws out of the function', async () => {
    const flakyDeleteObject = async () => {
      throw new Error('R2 network error');
    };
    await assert.doesNotReject(() => deleteReelMusic(makeFakeBucket({}), { musicStorageProvider: 'r2' }, UID, REEL_ID, { deleteObject: flakyDeleteObject }));
  });

  await check('delete-music: a failed Firebase delete is caught — never throws out of the function', async () => {
    const bucket = {
      file: () => ({
        delete: async () => {
          throw new Error('permission denied');
        },
      }),
    };
    await assert.doesNotReject(() => deleteReelMusic(bucket, { musicStorageProvider: 'firebase', musicStorageAudioPath: 'reels/u1/r1/music' }, UID, REEL_ID));
  });

  // -------------------------------------------------------------------
  // MUX/PHOTO-RENDER PROVIDER MATRIX — all 4 source x music combinations,
  // against the REAL (extracted) storage functions muxReelMusic and
  // renderPhotoToVideo both actually use.
  // -------------------------------------------------------------------

  await check('MATRIX 1 — Firebase source + Firebase music: both download correctly from Firebase', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('SOURCE_BYTES'), 'reels/u1/r1/music': Buffer.from('MUSIC_BYTES') });
    const reel = { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source', musicStorageProvider: 'firebase', musicStorageAudioPath: 'reels/u1/r1/music' };
    const sourceDest = tmpFile('m1-source');
    const musicDest = tmpFile('m1-music');
    const sourceOk = await downloadReelSourceForMux(bucket, reel, UID, REEL_ID, sourceDest);
    const musicOk = await downloadReelMusicToLocalFile(bucket, reel, UID, REEL_ID, musicDest);
    assert.equal(sourceOk, true);
    assert.equal(musicOk, true);
    assert.equal(fs.readFileSync(sourceDest, 'utf8'), 'SOURCE_BYTES');
    assert.equal(fs.readFileSync(musicDest, 'utf8'), 'MUSIC_BYTES');
    [sourceDest, musicDest].forEach((p) => fs.unlinkSync(p));
  });

  await check('MATRIX 2 — R2 source + Firebase music: source via authenticated R2 read, music via Firebase', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/music': Buffer.from('MUSIC_BYTES') });
    const r2 = makeFakeR2Store({ 'reels/u1/r1/source': 'SOURCE_BYTES' });
    const reel = { storageProvider: 'r2', musicStorageProvider: 'firebase', musicStorageAudioPath: 'reels/u1/r1/music' };
    const sourceDest = tmpFile('m2-source');
    const musicDest = tmpFile('m2-music');
    const sourceOk = await downloadReelSourceForMux(bucket, reel, UID, REEL_ID, sourceDest, { getObject: r2.getObject });
    const musicOk = await downloadReelMusicToLocalFile(bucket, reel, UID, REEL_ID, musicDest);
    assert.equal(sourceOk, true);
    assert.equal(musicOk, true);
    assert.equal(fs.readFileSync(sourceDest, 'utf8'), 'SOURCE_BYTES');
    assert.equal(fs.readFileSync(musicDest, 'utf8'), 'MUSIC_BYTES');
    [sourceDest, musicDest].forEach((p) => fs.unlinkSync(p));
  });

  await check('MATRIX 3 — Firebase source + R2 music: source via Firebase, music via authenticated R2 read', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('SOURCE_BYTES') });
    const r2 = makeFakeR2Store({ 'reels/u1/r1/music': 'MUSIC_BYTES' });
    const reel = { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source', musicStorageProvider: 'r2' };
    const sourceDest = tmpFile('m3-source');
    const musicDest = tmpFile('m3-music');
    const sourceOk = await downloadReelSourceForMux(bucket, reel, UID, REEL_ID, sourceDest);
    const musicOk = await downloadReelMusicToLocalFile(bucket, reel, UID, REEL_ID, musicDest, { getObject: r2.getObject });
    assert.equal(sourceOk, true);
    assert.equal(musicOk, true);
    assert.equal(fs.readFileSync(sourceDest, 'utf8'), 'SOURCE_BYTES');
    assert.equal(fs.readFileSync(musicDest, 'utf8'), 'MUSIC_BYTES');
    [sourceDest, musicDest].forEach((p) => fs.unlinkSync(p));
  });

  await check('MATRIX 4 — R2 source + R2 music: BOTH via authenticated R2 reads, at their own independent deterministic keys', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/r1/source': 'SOURCE_BYTES', 'reels/u1/r1/music': 'MUSIC_BYTES' });
    const reel = { storageProvider: 'r2', musicStorageProvider: 'r2' };
    const sourceDest = tmpFile('m4-source');
    const musicDest = tmpFile('m4-music');
    const sourceOk = await downloadReelSourceForMux(makeFakeBucket({}), reel, UID, REEL_ID, sourceDest, { getObject: r2.getObject });
    const musicOk = await downloadReelMusicToLocalFile(makeFakeBucket({}), reel, UID, REEL_ID, musicDest, { getObject: r2.getObject });
    assert.equal(sourceOk, true);
    assert.equal(musicOk, true);
    assert.equal(fs.readFileSync(sourceDest, 'utf8'), 'SOURCE_BYTES');
    assert.equal(fs.readFileSync(musicDest, 'utf8'), 'MUSIC_BYTES');
    assert.deepEqual(r2.calls.get.sort(), ['reels/u1/r1/source', 'reels/u1/r1/music'].sort());
    [sourceDest, musicDest].forEach((p) => fs.unlinkSync(p));
  });

  await check('MATRIX — PHOTO-RENDER equivalent: R2 photo + R2 music reads correctly too (renderPhotoToVideo reuses the exact same functions)', async () => {
    const r2 = makeFakeR2Store({ 'reels/u1/r1/source': 'ORIGINAL_PHOTO_BYTES', 'reels/u1/r1/music': 'MUSIC_BYTES' });
    const reel = { storageProvider: 'r2', musicStorageProvider: 'r2' };
    const photoDest = tmpFile('photo-m4-source');
    const musicDest = tmpFile('photo-m4-music');
    const photoOk = await downloadReelSourceForMux(makeFakeBucket({}), reel, UID, REEL_ID, photoDest, { getObject: r2.getObject });
    const musicOk = await downloadReelMusicToLocalFile(makeFakeBucket({}), reel, UID, REEL_ID, musicDest, { getObject: r2.getObject });
    assert.equal(photoOk, true);
    assert.equal(musicOk, true);
    assert.equal(fs.readFileSync(photoDest, 'utf8'), 'ORIGINAL_PHOTO_BYTES');
    [photoDest, musicDest].forEach((p) => fs.unlinkSync(p));
  });

  await check('SECURITY: different uid/reelId pairs never collide for music', async () => {
    const r2 = makeFakeR2Store({ 'reels/uid-a/reel-x/music': 'A', 'reels/uid-b/reel-x/music': 'B' });
    const destA = tmpFile('sec-a');
    const destB = tmpFile('sec-b');
    await downloadReelMusicToLocalFile(makeFakeBucket({}), { musicStorageProvider: 'r2' }, 'uid-a', 'reel-x', destA, { getObject: r2.getObject });
    await downloadReelMusicToLocalFile(makeFakeBucket({}), { musicStorageProvider: 'r2' }, 'uid-b', 'reel-x', destB, { getObject: r2.getObject });
    assert.equal(fs.readFileSync(destA, 'utf8'), 'A');
    assert.equal(fs.readFileSync(destB, 'utf8'), 'B');
    [destA, destB].forEach((p) => fs.unlinkSync(p));
  });

  console.log('\n=== functions/ Reel music storage (mux/render input) logic test results ===');
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
