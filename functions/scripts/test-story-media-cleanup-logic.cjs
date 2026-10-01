/**
 * Step 10A — plain-Node tests for cleanupStoryOwnedMedia
 * (functions/src/media/storyMediaCleanup.ts) — the shared, provider-aware
 * cleanup used by account deletion (deleteOwnStories, functions/src/index.ts)
 * to remove a Story's own physical media object. This is the authoritative
 * coverage for the Step 10A spec's own "Account deletion — mixed Firebase/
 * R2 Stories" test requirement.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { cleanupStoryOwnedMedia } = require('../lib/media/storyMediaCleanup.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function makeFakeBucket(initialFiles = {}) {
  const store = new Map(Object.entries(initialFiles));
  const calls = { exists: [], delete: [] };
  return {
    store,
    calls,
    file(filePath) {
      return {
        async exists() {
          calls.exists.push(filePath);
          return [store.has(filePath)];
        },
        async delete(options) {
          calls.delete.push({ path: filePath, options });
          store.delete(filePath);
        },
      };
    },
  };
}

function makeFakeR2Delete() {
  const calls = [];
  const deleteR2 = async (key) => {
    calls.push(key);
  };
  return { calls, deleteR2 };
}

async function main() {
  await check('Firebase Story: deletes via bucket.file().delete(), reports mediaAttempted+mediaDeleted true', async () => {
    const bucket = makeFakeBucket({ 'stories/u1/s1/source': Buffer.from('STORY_BYTES') });
    const story = { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' };
    const result = await cleanupStoryOwnedMedia(bucket, story);
    assert.deepEqual(result, { mediaAttempted: true, mediaDeleted: true });
    assert.equal(bucket.store.has('stories/u1/s1/source'), false);
  });

  await check('R2 Story: deletes via the authenticated R2 delete at the Story\'s own storagePath field', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const story = { storageProvider: 'r2', storagePath: 'stories/u1/s1/source' };
    const result = await cleanupStoryOwnedMedia(bucket, story, { deleteR2: r2.deleteR2 });
    assert.equal(result.mediaAttempted, true);
    assert.equal(result.mediaDeleted, true);
    assert.deepEqual(r2.calls, ['stories/u1/s1/source']);
  });

  await check('legacy Story missing storageProvider entirely defaults to Firebase', async () => {
    const bucket = makeFakeBucket({ 'stories/u1/s1/source': Buffer.from('STORY_BYTES') });
    const story = { storagePath: 'stories/u1/s1/source' }; // no storageProvider field at all
    const result = await cleanupStoryOwnedMedia(bucket, story);
    assert.equal(result.mediaDeleted, true);
  });

  await check('a Story with no storagePath at all (incomplete/corrupt document) attempts nothing, never throws', async () => {
    const bucket = makeFakeBucket();
    const result = await cleanupStoryOwnedMedia(bucket, {});
    assert.deepEqual(result, { mediaAttempted: false, mediaDeleted: false });
  });

  await check('idempotent: an already-missing Firebase object reports mediaAttempted true, mediaDeleted false, never an error', async () => {
    const bucket = makeFakeBucket(); // object already gone
    const story = { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' };
    const result = await cleanupStoryOwnedMedia(bucket, story);
    assert.equal(result.mediaAttempted, true);
    assert.equal(result.mediaDeleted, false);
  });

  await check('a failed R2 delete is caught — never throws out of this function', async () => {
    const bucket = makeFakeBucket();
    const flakyDeleteR2 = async () => {
      throw new Error('R2 network error');
    };
    const story = { storageProvider: 'r2', storagePath: 'stories/u1/s1/source' };
    await assert.doesNotReject(() => cleanupStoryOwnedMedia(bucket, story, { deleteR2: flakyDeleteR2 }));
  });

  await check('MIXED ACCOUNT-DELETION BATCH: one Firebase Story and one R2 Story, cleaned up independently and correctly', async () => {
    const bucket = makeFakeBucket({ 'stories/u1/s-fb/source': Buffer.from('FB_BYTES') });
    const r2 = makeFakeR2Delete();
    const firebaseStory = { storageProvider: 'firebase', storagePath: 'stories/u1/s-fb/source' };
    const r2Story = { storageProvider: 'r2', storagePath: 'stories/u1/s-r2/source' };
    const resultA = await cleanupStoryOwnedMedia(bucket, firebaseStory, { deleteR2: r2.deleteR2 });
    const resultB = await cleanupStoryOwnedMedia(bucket, r2Story, { deleteR2: r2.deleteR2 });
    assert.equal(resultA.mediaDeleted, true);
    assert.equal(resultB.mediaDeleted, true);
    assert.deepEqual(r2.calls, ['stories/u1/s-r2/source']);
    assert.equal(bucket.store.has('stories/u1/s-fb/source'), false);
  });

  console.log('\n=== functions/ Story media cleanup (account deletion) logic test results ===');
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
