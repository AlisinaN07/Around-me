/**
 * Step 10A.1 — plain-Node tests for the pure expired-Story cleanup
 * orchestration in functions/src/media/storyExpiryCleanup.ts:
 * cleanupExpiredStory (one Story) and cleanupExpiredStoriesBatch (an
 * already-fetched, already-bounded batch). This is the authoritative
 * coverage for the Step 10A.1 spec's own full test list — batch
 * orchestration, successful cleanup, missing media, genuine provider
 * failure (document retained for retry), concurrent document
 * disappearance, retry-to-completion, the batch-size boundary, security
 * (deterministic key derivation, no URL parsing), and idempotency against
 * a concurrent manual delete.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { cleanupExpiredStory, cleanupExpiredStoriesBatch } = require('../lib/media/storyExpiryCleanup.js');

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

function makeFakeR2Delete(behavior = {}) {
  const calls = [];
  const deleteR2 = async (key) => {
    calls.push(key);
    if (behavior.throwFor && behavior.throwFor(key)) {
      throw new Error('R2 network error');
    }
  };
  return { calls, deleteR2 };
}

function makeFakeDocStore(initialIds = []) {
  const ids = new Set(initialIds);
  const calls = [];
  const deleteStoryDocument = async (id) => {
    calls.push(id);
    ids.delete(id); // Firestore's own delete is idempotent — deleting an already-gone doc is not an error.
  };
  return { ids, calls, deleteStoryDocument };
}

const UID = 'author-uid-1';
const STORY_ID = 'story1';

async function main() {
  // -------------------------------------------------------------------
  // cleanupExpiredStory — per-Story outcomes.
  // -------------------------------------------------------------------

  await check('Firebase Story: media deleted, document deleted', async () => {
    const bucket = makeFakeBucket({ [`stories/${UID}/${STORY_ID}/source`]: Buffer.from('STORY_BYTES') });
    const docs = makeFakeDocStore([STORY_ID]);
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'firebase' }, { deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(outcome, { storyId: STORY_ID, mediaStatus: 'deleted', documentDeleted: true });
    assert.equal(bucket.store.has(`stories/${UID}/${STORY_ID}/source`), false);
    assert.deepEqual(docs.calls, [STORY_ID]);
  });

  await check('R2 Story: media deleted via authenticated R2 delete, document deleted', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const docs = makeFakeDocStore([STORY_ID]);
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'r2' }, { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(outcome, { storyId: STORY_ID, mediaStatus: 'deleted', documentDeleted: true });
    assert.deepEqual(r2.calls, [`stories/${UID}/${STORY_ID}/source`]);
  });

  await check('legacy Story missing storageProvider entirely defaults to Firebase', async () => {
    const bucket = makeFakeBucket({ [`stories/${UID}/${STORY_ID}/source`]: Buffer.from('X') });
    const docs = makeFakeDocStore([STORY_ID]);
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID }, { deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(outcome.mediaStatus, 'deleted');
  });

  await check('MISSING MEDIA: Firebase object already gone — document is STILL deleted (mediaStatus "already-missing")', async () => {
    const bucket = makeFakeBucket(); // nothing there
    const docs = makeFakeDocStore([STORY_ID]);
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'firebase' }, { deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(outcome, { storyId: STORY_ID, mediaStatus: 'already-missing', documentDeleted: true });
  });

  await check('GENUINE PROVIDER FAILURE (R2): the document is RETAINED, never deleted, when the media delete itself throws', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete({ throwFor: () => true });
    const docs = makeFakeDocStore([STORY_ID]);
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'r2' }, { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(outcome, { storyId: STORY_ID, mediaStatus: 'failed', documentDeleted: false });
    assert.equal(docs.calls.length, 0, 'the Firestore document must never be deleted after a genuine media-provider failure');
    assert.equal(docs.ids.has(STORY_ID), true, 'the document must still exist, so a future run can retry');
  });

  await check('GENUINE PROVIDER FAILURE (Firebase): a real (non-not-found) Firebase delete error also retains the document', async () => {
    const bucket = {
      file: () => ({
        exists: async () => [true],
        delete: async () => {
          throw new Error('permission denied');
        },
      }),
    };
    const docs = makeFakeDocStore([STORY_ID]);
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'firebase' }, { deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(outcome.mediaStatus, 'failed');
    assert.equal(outcome.documentDeleted, false);
    assert.equal(docs.calls.length, 0);
  });

  await check('DOCUMENT DISAPPEARED CONCURRENTLY: media cleanup succeeds, the Firestore delete call itself fails (doc already gone) — never crashes, reports documentDeleted:false honestly', async () => {
    const bucket = makeFakeBucket({ [`stories/${UID}/${STORY_ID}/source`]: Buffer.from('X') });
    const flakyDeleteStoryDocument = async () => {
      throw new Error('NOT_FOUND');
    };
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'firebase' }, { deleteStoryDocument: flakyDeleteStoryDocument });
    assert.equal(outcome.mediaStatus, 'deleted');
    assert.equal(outcome.documentDeleted, false);
  });

  await check('RETRY: a Story whose previous run failed on media now succeeds on a second attempt — the document is finally deleted', async () => {
    const bucket = makeFakeBucket();
    let attempt = 0;
    const flakyThenOkDeleteR2 = async (key) => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient R2 error');
    };
    const docs = makeFakeDocStore([STORY_ID]);
    const story = { id: STORY_ID, authorUid: UID, storageProvider: 'r2' };
    const first = await cleanupExpiredStory(bucket, story, { deleteR2: flakyThenOkDeleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(first.mediaStatus, 'failed');
    assert.equal(first.documentDeleted, false);
    const second = await cleanupExpiredStory(bucket, story, { deleteR2: flakyThenOkDeleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(second.mediaStatus, 'deleted');
    assert.equal(second.documentDeleted, true);
  });

  // -------------------------------------------------------------------
  // SECURITY — deterministic key derivation, never a URL/arbitrary path.
  // -------------------------------------------------------------------

  await check('SECURITY: the R2 key is derived from authorUid+id alone — never from any URL-shaped field, which this function never even reads', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const docs = makeFakeDocStore([STORY_ID]);
    // A hostile/irrelevant mediaUrl-shaped field, if it somehow existed on
    // the record, would still never be consulted — this function's own
    // input type doesn't even carry one.
    await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'r2' }, { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(r2.calls, [`stories/${UID}/${STORY_ID}/source`]);
  });

  await check('SECURITY: different authorUid/id pairs never collide — one author\'s expired Story can never target another\'s namespace', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const docs = makeFakeDocStore(['story-a', 'story-b']);
    await cleanupExpiredStory(bucket, { id: 'story-a', authorUid: 'uid-a', storageProvider: 'r2' }, { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    await cleanupExpiredStory(bucket, { id: 'story-b', authorUid: 'uid-b', storageProvider: 'r2' }, { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(r2.calls.sort(), ['stories/uid-a/story-a/source', 'stories/uid-b/story-b/source'].sort());
  });

  // -------------------------------------------------------------------
  // cleanupExpiredStoriesBatch — orchestration over an array.
  // -------------------------------------------------------------------

  await check('BATCH: no expired Stories — an empty array produces all-zero counts, never throws', async () => {
    const bucket = makeFakeBucket();
    const docs = makeFakeDocStore([]);
    const result = await cleanupExpiredStoriesBatch(bucket, [], { deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(result, { processed: 0, mediaDeleted: 0, mediaAlreadyMissing: 0, mediaFailed: 0, documentsDeleted: 0 });
  });

  await check('BATCH: one expired Firebase Story — counted correctly', async () => {
    const bucket = makeFakeBucket({ [`stories/${UID}/s1/source`]: Buffer.from('X') });
    const docs = makeFakeDocStore(['s1']);
    const result = await cleanupExpiredStoriesBatch(bucket, [{ id: 's1', authorUid: UID, storageProvider: 'firebase' }], { deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(result, { processed: 1, mediaDeleted: 1, mediaAlreadyMissing: 0, mediaFailed: 0, documentsDeleted: 1 });
  });

  await check('BATCH: one expired R2 Story — counted correctly', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const docs = makeFakeDocStore(['s1']);
    const result = await cleanupExpiredStoriesBatch(bucket, [{ id: 's1', authorUid: UID, storageProvider: 'r2' }], { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.deepEqual(result, { processed: 1, mediaDeleted: 1, mediaAlreadyMissing: 0, mediaFailed: 0, documentsDeleted: 1 });
  });

  await check('BATCH: MIXED — Firebase deleted, R2 already-missing, R2 failed (retained), legacy-default Firebase deleted — one bad Story never blocks the rest', async () => {
    const bucket = makeFakeBucket({ [`stories/${UID}/s-fb/source`]: Buffer.from('X'), [`stories/${UID}/s-legacy/source`]: Buffer.from('Y') });
    const r2 = makeFakeR2Delete({ throwFor: (key) => key.includes('s-r2-fail') });
    const docs = makeFakeDocStore(['s-fb', 's-r2-missing', 's-r2-fail', 's-legacy']);
    const stories = [
      { id: 's-fb', authorUid: UID, storageProvider: 'firebase' },
      { id: 's-r2-missing', authorUid: UID, storageProvider: 'r2' }, // nothing in the fake R2 store, but delete is idempotent -> 'deleted'
      { id: 's-r2-fail', authorUid: UID, storageProvider: 'r2' },
      { id: 's-legacy', authorUid: UID }, // no storageProvider field at all
    ];
    const result = await cleanupExpiredStoriesBatch(bucket, stories, { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(result.processed, 4);
    assert.equal(result.mediaFailed, 1);
    assert.equal(result.documentsDeleted, 3);
    assert.equal(docs.ids.has('s-r2-fail'), true, 'only the genuinely-failed Story\'s document survives');
    assert.equal(docs.ids.has('s-fb'), false);
    assert.equal(docs.ids.has('s-legacy'), false);
  });

  await check('BATCH LIMIT: the batch function processes EXACTLY the array it\'s given, never more — the actual bound comes from the caller\'s own Firestore .limit() query', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const ids = Array.from({ length: 5 }, (_, i) => `s${i}`);
    const docs = makeFakeDocStore(ids);
    const stories = ids.map((id) => ({ id, authorUid: UID, storageProvider: 'r2' }));
    const result = await cleanupExpiredStoriesBatch(bucket, stories, { deleteR2: r2.deleteR2, deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(result.processed, 5);
    assert.equal(r2.calls.length, 5);
  });

  await check('IDEMPOTENCY: scheduled cleanup running TWICE on the same already-cleaned Story is safe — second run sees already-missing media and an already-gone document, no error', async () => {
    const bucket = makeFakeBucket({ [`stories/${UID}/s1/source`]: Buffer.from('X') });
    const docs = makeFakeDocStore(['s1']);
    const story = { id: 's1', authorUid: UID, storageProvider: 'firebase' };
    const first = await cleanupExpiredStoriesBatch(bucket, [story], { deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(first.documentsDeleted, 1);
    // Second run — same batch, as if the query had somehow returned this
    // Story again before its own index caught up — media is already
    // gone, and deleteStoryDocument is itself idempotent (Firestore's own
    // real behavior: deleting an already-gone doc is not an error).
    const second = await cleanupExpiredStoriesBatch(bucket, [story], { deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(second.mediaAlreadyMissing, 1);
    assert.equal(second.documentsDeleted, 1);
  });

  await check('MIXED DELETION PATHS: a concurrent manual delete already removed both the media and the document — scheduled cleanup still completes cleanly, no crash', async () => {
    const bucket = makeFakeBucket(); // manual delete already removed the Firebase object
    const docs = makeFakeDocStore([]); // manual delete already removed the Firestore doc
    const outcome = await cleanupExpiredStory(bucket, { id: STORY_ID, authorUid: UID, storageProvider: 'firebase' }, { deleteStoryDocument: docs.deleteStoryDocument });
    assert.equal(outcome.mediaStatus, 'already-missing');
    assert.equal(outcome.documentDeleted, true); // Firestore's own delete-of-nonexistent-doc succeeds without error
  });

  console.log('\n=== functions/ Story expiry cleanup orchestration test results ===');
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
