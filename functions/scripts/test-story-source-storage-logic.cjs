/**
 * Step 10A — plain-Node tests for copyReelSourceToR2StoryObject
 * (functions/src/media/reelSourceStorage.ts) — the R2-TARGET half of
 * addReelToMyStory's own provider matrix (the Firebase-target half,
 * copyReelSourceToFirebaseStoryObject, is unchanged from Step 9A and
 * already covered by test-reel-source-storage-logic.cjs). This is the
 * authoritative coverage for the Step 10A spec's own 2x2 Add-Reel-to-Story
 * matrix:
 *   1. Firebase Reel -> Firebase Story (unchanged, Step 9A's own tests)
 *   2. R2 Reel -> Firebase Story (unchanged, Step 9A's own tests)
 *   3. Firebase Reel -> R2 Story (NEW — download then PUT)
 *   4. R2 Reel -> R2 Story (NEW — bucket-internal CopyObjectCommand, no
 *      bytes through this Cloud Function at all)
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { copyReelSourceToR2StoryObject } = require('../lib/media/reelSourceStorage.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

/** Mirrors every other Step 9A-10A test file's own fake bucket. */
function makeFakeBucket(initialFiles = {}) {
  const store = new Map(Object.entries(initialFiles));
  const calls = { download: [] };
  return {
    store,
    calls,
    file(filePath) {
      return {
        __path: filePath,
        async download({ destination }) {
          calls.download.push({ path: filePath, destination });
          if (!store.has(filePath)) throw new Error(`no such Firebase object: ${filePath}`);
          fs.writeFileSync(destination, store.get(filePath));
        },
      };
    },
  };
}

function makeFakeR2Copy(initialKeys = {}) {
  const objects = new Map(Object.entries(initialKeys).map(([k, v]) => [k, Buffer.from(v)]));
  const calls = [];
  const copyObject = async (sourceKey, destinationKey) => {
    calls.push({ sourceKey, destinationKey });
    if (!objects.has(sourceKey)) throw new Error(`no such R2 object: ${sourceKey}`);
    objects.set(destinationKey, objects.get(sourceKey));
  };
  return { objects, calls, copyObject };
}

function makeFakePut() {
  const objects = new Map();
  const calls = [];
  const putObject = async (key, data, contentType) => {
    calls.push({ key, contentType });
    objects.set(key, data);
  };
  return { objects, calls, putObject };
}

function tmpFile(name) {
  return path.join(os.tmpdir(), `story-source-storage-test-${process.pid}-${name}`);
}

const UID = 'storyAuthorUid';
const STORY_ID = 'story1';

async function main() {
  await check('MATRIX 4 — R2 Reel -> R2 Story: a single bucket-internal CopyObjectCommand, NO bytes read through this function at all', async () => {
    const r2 = makeFakeR2Copy({ 'reels/reelAuthorUid/reel1/source': 'REEL_VIDEO_BYTES' });
    const put = makeFakePut();
    const bucket = makeFakeBucket(); // Firebase bucket never touched in this combo
    const reel = { storageProvider: 'r2', authorUid: 'reelAuthorUid', reelId: 'reel1', storageContentType: 'video/mp4' };
    const localTempPath = tmpFile('r2-to-r2-unused');
    await copyReelSourceToR2StoryObject(bucket, reel, UID, STORY_ID, localTempPath, { copyObject: r2.copyObject, putObject: put.putObject });
    assert.deepEqual(r2.calls, [{ sourceKey: 'reels/reelAuthorUid/reel1/source', destinationKey: `stories/${UID}/${STORY_ID}/source` }]);
    assert.equal(put.calls.length, 0, 'the R2->R2 path must never also call putObject');
    assert.equal(bucket.calls.download.length, 0, 'the R2->R2 path must never touch the Firebase bucket at all');
    const finalBytes = r2.objects.get(`stories/${UID}/${STORY_ID}/source`);
    assert.equal(finalBytes.toString('utf8'), 'REEL_VIDEO_BYTES');
  });

  await check('MATRIX 3 — Firebase Reel -> R2 Story: downloads to a local temp file, then PUTs to the Story\'s own deterministic R2 key', async () => {
    const bucket = makeFakeBucket({ 'reels/reelAuthorUid/reel1/source': Buffer.from('REEL_PHOTO_BYTES') });
    const put = makeFakePut();
    const reel = { storageProvider: 'firebase', storagePath: 'reels/reelAuthorUid/reel1/source', storageContentType: 'image/jpeg' };
    const localTempPath = tmpFile('fb-to-r2');
    await copyReelSourceToR2StoryObject(bucket, reel, UID, STORY_ID, localTempPath, { putObject: put.putObject });
    assert.deepEqual(bucket.calls.download, [{ path: 'reels/reelAuthorUid/reel1/source', destination: localTempPath }]);
    assert.equal(put.calls.length, 1);
    assert.equal(put.calls[0].key, `stories/${UID}/${STORY_ID}/source`);
    assert.equal(put.calls[0].contentType, 'image/jpeg');
    const finalBytes = put.objects.get(`stories/${UID}/${STORY_ID}/source`);
    assert.equal(finalBytes.toString('utf8'), 'REEL_PHOTO_BYTES');
    fs.unlinkSync(localTempPath);
  });

  await check('DISTINGUISHABLE BYTES — R2 Reel -> R2 Story copy never mixes bytes with any other object already at the destination key', async () => {
    const r2 = makeFakeR2Copy({
      'reels/reelAuthorUid/reel1/source': 'ORIGINAL_REEL_BYTES',
      [`stories/${UID}/${STORY_ID}/source`]: 'STALE_PLACEHOLDER_BYTES',
    });
    const reel = { storageProvider: 'r2', authorUid: 'reelAuthorUid', reelId: 'reel1', storageContentType: 'video/mp4' };
    await copyReelSourceToR2StoryObject(makeFakeBucket(), reel, UID, STORY_ID, tmpFile('overwrite-check'), { copyObject: r2.copyObject });
    const finalBytes = r2.objects.get(`stories/${UID}/${STORY_ID}/source`);
    assert.equal(finalBytes.toString('utf8'), 'ORIGINAL_REEL_BYTES');
  });

  await check('SECURITY — the R2 source key is derived from the Reel document\'s own authorUid/reelId, the destination from the CALLER\'s own trusted uid/storyId — never cross-contaminated', async () => {
    const r2 = makeFakeR2Copy({ 'reels/real-reel-author/reel42/source': 'BYTES' });
    const reel = { storageProvider: 'r2', authorUid: 'real-reel-author', reelId: 'reel42', storageContentType: 'video/mp4' };
    await copyReelSourceToR2StoryObject(makeFakeBucket(), reel, 'the-caller-uid', 'new-story-id', tmpFile('security'), { copyObject: r2.copyObject });
    assert.deepEqual(r2.calls, [{ sourceKey: 'reels/real-reel-author/reel42/source', destinationKey: 'stories/the-caller-uid/new-story-id/source' }]);
  });

  await check('FAILURE — R2 Reel -> R2 Story: a nonexistent source Reel object throws, never silently creates an empty/broken Story object', async () => {
    const r2 = makeFakeR2Copy({}); // source missing
    const reel = { storageProvider: 'r2', authorUid: 'reelAuthorUid', reelId: 'reel1', storageContentType: 'video/mp4' };
    await assert.rejects(() => copyReelSourceToR2StoryObject(makeFakeBucket(), reel, UID, STORY_ID, tmpFile('missing-source'), { copyObject: r2.copyObject }));
  });

  await check('FAILURE — Firebase Reel -> R2 Story: a nonexistent Firebase source object throws before any putObject call', async () => {
    const bucket = makeFakeBucket({}); // source missing
    const put = makeFakePut();
    const reel = { storageProvider: 'firebase', storagePath: 'reels/reelAuthorUid/reel1/source', storageContentType: 'image/jpeg' };
    await assert.rejects(() => copyReelSourceToR2StoryObject(bucket, reel, UID, STORY_ID, tmpFile('missing-fb-source'), { putObject: put.putObject }));
    assert.equal(put.calls.length, 0);
  });

  console.log('\n=== functions/ Story source-storage (Add-Reel-to-Story R2 target) logic test results ===');
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
