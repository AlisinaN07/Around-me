/**
 * Step 9A — plain-Node tests for the provider-aware Reel-source storage
 * operations in functions/src/media/reelSourceStorage.ts:
 * deleteReelSourceMedia, downloadReelSourceToLocalFile,
 * copyReelSourceToFirebaseStoryObject. These back deleteMyReel/
 * deleteMyAccountData/removeReportedReel (delete), resolveOwnSoundOrigin
 * (download), and addReelToMyStory (copy) — see reelSourceStorage.ts's own
 * doc comment for why they were extracted with an injectable bucket/fetch
 * boundary specifically so this branching is testable here.
 *
 * The R2 "read" side is exercised against a REAL local HTTP server (see
 * lib/fakeHttpMediaServer.cjs) — a real socket, real status codes, real
 * bytes — standing in for R2's own public delivery endpoint, not just a
 * mocked fetch function. The R2 "delete" side is exercised with a plain
 * spy function, matching how deleteR2Object is itself just a thin
 * AWS-SDK wrapper with nothing meaningful to gain from a real network
 * round trip in a unit test (its own success/failure shape is what these
 * functions branch on, not its HTTP internals).
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  deleteReelSourceMedia,
  downloadReelSourceToLocalFile,
  copyReelSourceToFirebaseStoryObject,
  readReelCanonicalSourceState,
} = require('../lib/media/reelSourceStorage.js');
const { REEL_VIDEO_NORMALIZATION_METADATA_KEY, buildReelVideoNormalizationMetadata } = require('../lib/media/reelVideoProfile.js');
const { startFakeDeliveryServer } = require('./testHelpers/fakeHttpMediaServer.cjs');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

/**
 * A minimal fake Bucket satisfying reelSourceStorage.ts's own
 * BucketLike/BucketFileLike shape, with call-recording so tests can
 * assert exactly what was invoked. `fileMetadata` (keyed by path) backs
 * getMetadata() for the Step 11B canonical-state-read tests below —
 * `{size, metadata}` per entry; a path with no entry simulates a
 * metadata-read failure (object missing, or a transient error), same
 * fail-safe shape `readReelCanonicalSourceState` itself expects.
 */
function makeFakeBucket(initialFiles = {}, fileMetadata = {}) {
  const store = new Map(Object.entries(initialFiles));
  const metadataStore = new Map(Object.entries(fileMetadata));
  const calls = { exists: [], delete: [], download: [], copy: [], save: [], getMetadata: [] };
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
        async delete(options) {
          calls.delete.push({ path: filePath, options });
          store.delete(filePath);
        },
        async download({ destination }) {
          calls.download.push({ path: filePath, destination });
          fs.writeFileSync(destination, store.get(filePath) ?? Buffer.alloc(0));
        },
        async copy(destination) {
          calls.copy.push({ from: filePath, to: destination.__path });
          store.set(destination.__path, store.get(filePath));
        },
        async save(data, options) {
          calls.save.push({ path: filePath, options });
          store.set(filePath, data);
        },
        async getMetadata() {
          calls.getMetadata.push(filePath);
          if (!metadataStore.has(filePath)) {
            throw new Error(`404: no object at "${filePath}"`);
          }
          return [metadataStore.get(filePath), {}];
        },
      };
    },
  };
  return bucket;
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `reel-source-storage-test-${process.pid}-${name}`);
}

async function main() {
  // -------------------------------------------------------------------
  // deleteReelSourceMedia
  // -------------------------------------------------------------------

  await check('delete: Firebase Reel — deletes the real bucket file, returns true (existed)', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('video') });
    const spy = { calls: 0 };
    const deleted = await deleteReelSourceMedia(
      bucket,
      'reels/u1/r1/source',
      'firebase',
      async () => {
        spy.calls += 1;
      }
    );
    assert.equal(deleted, true);
    assert.equal(spy.calls, 0, 'R2 delete must never be called for a Firebase-provider Reel');
    assert.equal(bucket.calls.delete.length, 1);
    assert.equal(bucket.store.has('reels/u1/r1/source'), false);
  });

  await check('delete: Firebase Reel whose object never existed — returns false, still calls delete with ignoreNotFound', async () => {
    const bucket = makeFakeBucket({});
    const deleted = await deleteReelSourceMedia(bucket, 'reels/u1/r1/source', 'firebase', async () => {});
    assert.equal(deleted, false);
    assert.equal(bucket.calls.delete[0].options.ignoreNotFound, true);
  });

  await check('delete: R2 Reel — calls the injected deleteObject with the exact storagePath as key, Firebase bucket file() never touched', async () => {
    const bucket = makeFakeBucket({});
    const deleteCalls = [];
    const deleted = await deleteReelSourceMedia(bucket, 'reels/u1/r1/source', 'r2', async (key) => {
      deleteCalls.push(key);
    });
    assert.equal(deleted, true);
    assert.deepEqual(deleteCalls, ['reels/u1/r1/source']);
    assert.equal(bucket.calls.delete.length, 0, 'Firebase delete must never be called for an R2-provider Reel');
    assert.equal(bucket.calls.exists.length, 0);
  });

  await check('delete: R2 delete failure is caught and returns false, never throws', async () => {
    const deleted = await deleteReelSourceMedia(makeFakeBucket({}), 'reels/u1/r1/source', 'r2', async () => {
      throw new Error('network down');
    });
    assert.equal(deleted, false);
  });

  await check('delete: undefined storageProvider (legacy Reel) is treated as Firebase', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': Buffer.from('x') });
    const deleted = await deleteReelSourceMedia(bucket, 'reels/u1/r1/source', undefined, async () => {
      throw new Error('should never be called');
    });
    assert.equal(deleted, true);
  });

  // -------------------------------------------------------------------
  // downloadReelSourceToLocalFile — R2 side against a REAL local HTTP server
  // -------------------------------------------------------------------

  const videoBytes = Buffer.from('fake-mp4-bytes-not-a-real-video');
  const server = await startFakeDeliveryServer({
    '/reels/u1/r1/source': { status: 200, body: videoBytes },
    '/reels/u1/r1/broken': { status: 500, body: 'server error' },
  });

  await check('download: R2 Reel — fetches over real HTTP, writes the exact bytes to the destination file', async () => {
    const dest = tmpFile('download-ok');
    const reel = { storageProvider: 'r2', sourceUrl: server.url('/reels/u1/r1/source') };
    const ok = await downloadReelSourceToLocalFile(makeFakeBucket({}), reel, dest);
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(dest), videoBytes);
    fs.unlinkSync(dest);
  });

  await check('download: R2 Reel with a non-2xx response returns false, writes nothing', async () => {
    const dest = tmpFile('download-500');
    const reel = { storageProvider: 'r2', sourceUrl: server.url('/reels/u1/r1/broken') };
    const ok = await downloadReelSourceToLocalFile(makeFakeBucket({}), reel, dest);
    assert.equal(ok, false);
    assert.equal(fs.existsSync(dest), false);
  });

  await check('download: R2 Reel with no sourceUrl at all returns false without attempting a fetch', async () => {
    const ok = await downloadReelSourceToLocalFile(makeFakeBucket({}), { storageProvider: 'r2', sourceUrl: '' }, tmpFile('never'));
    assert.equal(ok, false);
  });

  await check('download: R2 Reel whose host is unreachable returns false, never throws', async () => {
    const reel = { storageProvider: 'r2', sourceUrl: 'http://127.0.0.1:1/definitely-not-listening' };
    const ok = await downloadReelSourceToLocalFile(makeFakeBucket({}), reel, tmpFile('unreachable'));
    assert.equal(ok, false);
  });

  await check('download: Firebase Reel — uses bucket.file(storagePath).download(), never touches fetch', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': videoBytes });
    const dest = tmpFile('firebase-download');
    const reel = { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' };
    const ok = await downloadReelSourceToLocalFile(bucket, reel, dest);
    assert.equal(ok, true);
    assert.equal(bucket.calls.download.length, 1);
    assert.deepEqual(fs.readFileSync(dest), videoBytes);
    fs.unlinkSync(dest);
  });

  await check('download: Firebase Reel whose object is missing returns false without calling .download()', async () => {
    const bucket = makeFakeBucket({});
    const ok = await downloadReelSourceToLocalFile(bucket, { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' }, tmpFile('missing'));
    assert.equal(ok, false);
    assert.equal(bucket.calls.download.length, 0);
  });

  await check('download: legacy Reel (no storageProvider key at all) is treated as Firebase', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': videoBytes });
    const dest = tmpFile('legacy');
    const ok = await downloadReelSourceToLocalFile(bucket, { storagePath: 'reels/u1/r1/source' }, dest);
    assert.equal(ok, true);
    fs.unlinkSync(dest);
  });

  // -------------------------------------------------------------------
  // copyReelSourceToFirebaseStoryObject — addReelToMyStory's own consumer
  // -------------------------------------------------------------------

  await check('copy: Firebase Reel — uses the native bucket.file(...).copy(...) path, never fetch', async () => {
    const bucket = makeFakeBucket({ 'reels/u1/r1/source': videoBytes });
    await copyReelSourceToFirebaseStoryObject(bucket, { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' }, 'stories/u1/s1/source');
    assert.equal(bucket.calls.copy.length, 1);
    assert.deepEqual(bucket.calls.copy[0], { from: 'reels/u1/r1/source', to: 'stories/u1/s1/source' });
    assert.deepEqual(bucket.store.get('stories/u1/s1/source'), videoBytes);
    assert.equal(bucket.calls.save.length, 0, 'Firebase Reel must never take the fetch+save path');
  });

  await check('copy: R2 Reel — fetches the real bytes over HTTP and saves them into the new Firebase Story object, never .copy()', async () => {
    const bucket = makeFakeBucket({});
    const reel = { storageProvider: 'r2', sourceUrl: server.url('/reels/u1/r1/source'), storageContentType: 'video/mp4' };
    await copyReelSourceToFirebaseStoryObject(bucket, reel, 'stories/u1/s2/source');
    assert.equal(bucket.calls.copy.length, 0, 'an R2 Reel must never rely on bucket.file(reel.storagePath).copy(...) — that object was never in Firebase at all');
    assert.equal(bucket.calls.save.length, 1);
    assert.equal(bucket.calls.save[0].options.contentType, 'video/mp4');
    assert.deepEqual(bucket.store.get('stories/u1/s2/source'), videoBytes);
  });

  await check('copy: R2 Reel with a failing fetch throws (caller wraps as HttpsError internal)', async () => {
    const bucket = makeFakeBucket({});
    const reel = { storageProvider: 'r2', sourceUrl: server.url('/reels/u1/r1/broken') };
    await assert.rejects(() => copyReelSourceToFirebaseStoryObject(bucket, reel, 'stories/u1/s3/source'));
  });

  await check('copy: R2 Reel with no sourceUrl throws rather than silently doing nothing', async () => {
    const bucket = makeFakeBucket({});
    await assert.rejects(() => copyReelSourceToFirebaseStoryObject(bucket, { storageProvider: 'r2', sourceUrl: '' }, 'stories/u1/s4/source'));
  });

  await server.close();

  // -------------------------------------------------------------------
  // Step 11B — readReelCanonicalSourceState: the idempotency fix's own
  // READ side. Metadata-only (never downloads bytes), provider-aware,
  // fail-safe on any read failure.
  // -------------------------------------------------------------------

  const normalizedMetadataValue = buildReelVideoNormalizationMetadata();

  await check('canonical state: Firebase Reel whose object already carries the CURRENT normalization marker — returns the marker and real size, never touches R2', async () => {
    const bucket = makeFakeBucket({}, { 'reels/u1/r1/source': { size: '12345', metadata: normalizedMetadataValue } });
    const reel = { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' };
    const result = await readReelCanonicalSourceState(bucket, reel, 'u1', 'r1');
    assert.deepEqual(result, { sizeBytes: 12345, normalizationMarker: normalizedMetadataValue[REEL_VIDEO_NORMALIZATION_METADATA_KEY] });
    assert.equal(bucket.calls.getMetadata.length, 1);
    assert.equal(bucket.calls.download.length, 0, 'a metadata check must never download the full video');
  });

  await check('canonical state: Firebase Reel with NO marker at all (raw, never-finalized source) — returns normalizationMarker: null, real size still reported', async () => {
    const bucket = makeFakeBucket({}, { 'reels/u1/r1/source': { size: 98765, metadata: {} } });
    const reel = { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' };
    const result = await readReelCanonicalSourceState(bucket, reel, 'u1', 'r1');
    assert.deepEqual(result, { sizeBytes: 98765, normalizationMarker: null });
  });

  await check('canonical state: Firebase Reel whose object does not exist — getMetadata throws — returns null (fail-safe, never assumes normalized)', async () => {
    const bucket = makeFakeBucket({}, {});
    const reel = { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' };
    const result = await readReelCanonicalSourceState(bucket, reel, 'u1', 'r1');
    assert.equal(result, null);
  });

  await check('canonical state: Firebase Reel whose metadata read reports a zero/garbage size — treated as unreadable, returns null rather than a bogus fileSizeBytes', async () => {
    const bucket = makeFakeBucket({}, { 'reels/u1/r1/source': { size: '0', metadata: normalizedMetadataValue } });
    const reel = { storageProvider: 'firebase', storagePath: 'reels/u1/r1/source' };
    const result = await readReelCanonicalSourceState(bucket, reel, 'u1', 'r1');
    assert.equal(result, null);
  });

  await check('canonical state: R2 Reel whose object already carries the CURRENT normalization marker — uses the injected headObject, derives the key from uid/reelId, never touches the Firebase bucket', async () => {
    const bucket = makeFakeBucket({});
    const headCalls = [];
    const headObject = async (key) => {
      headCalls.push(key);
      return { sizeBytes: 54321, metadata: normalizedMetadataValue };
    };
    const result = await readReelCanonicalSourceState(bucket, { storageProvider: 'r2' }, 'u1', 'r1', { headObject });
    assert.deepEqual(result, { sizeBytes: 54321, normalizationMarker: normalizedMetadataValue[REEL_VIDEO_NORMALIZATION_METADATA_KEY] });
    assert.deepEqual(headCalls, ['reels/u1/r1/source']);
    assert.equal(bucket.calls.getMetadata.length, 0);
  });

  await check('canonical state: R2 Reel with no marker at all — returns normalizationMarker: null', async () => {
    const headObject = async () => ({ sizeBytes: 111, metadata: {} });
    const result = await readReelCanonicalSourceState(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'r1', { headObject });
    assert.deepEqual(result, { sizeBytes: 111, normalizationMarker: null });
  });

  await check('canonical state: R2 Reel whose headObject reports the object missing (null) — returns null (fail-safe)', async () => {
    const headObject = async () => null;
    const result = await readReelCanonicalSourceState(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'r1', { headObject });
    assert.equal(result, null);
  });

  await check('canonical state: R2 Reel with an OLDER/different profile-version marker — returned verbatim (the CALLER, isReelSourceAlreadyNormalized, decides it does not match — never pre-filtered here)', async () => {
    const headObject = async () => ({ sizeBytes: 222, metadata: { [REEL_VIDEO_NORMALIZATION_METADATA_KEY]: '0' } });
    const result = await readReelCanonicalSourceState(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 'r1', { headObject });
    assert.deepEqual(result, { sizeBytes: 222, normalizationMarker: '0' });
  });

  await check('canonical state: a legacy Reel missing storageProvider entirely defaults to Firebase', async () => {
    const bucket = makeFakeBucket({}, { 'reels/u1/r1/source': { size: '5000', metadata: {} } });
    const result = await readReelCanonicalSourceState(bucket, { storagePath: 'reels/u1/r1/source' }, 'u1', 'r1');
    assert.deepEqual(result, { sizeBytes: 5000, normalizationMarker: null });
  });

  console.log('\n=== functions/ Reel source storage (delete/download/copy) logic test results ===');
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
