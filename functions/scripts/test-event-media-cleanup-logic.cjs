/**
 * Plain-Node tests for cleanupEventOwnedMedia / isTrustedEventCoverStoragePath
 * (functions/src/media/eventMediaCleanup.ts) — the shared cleanup used by
 * all three real Event deletion routes (self-delete via deleteMyContent,
 * account-deletion cascade via deleteOwnContent, moderation removal via
 * removeReportedContent — all funnel through
 * deleteContentDocumentAndSubcollections, functions/src/index.ts).
 *
 * Step 2B — isTrustedEventCoverStoragePath now requires EXACT equality
 * against `eventCovers/{authorUid}/{contentId}/photo`, not just a
 * same-uid namespace prefix. The tests under "EXACT Event ownership"
 * below specifically exercise the real contentId relationship (the gap
 * the first version of this fix missed) — same-author, cross-Event path
 * reuse — not merely namespace/uid matching.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { cleanupEventOwnedMedia, isTrustedEventCoverStoragePath } = require('../lib/media/eventMediaCleanup.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function makeFakeBucket(initialFiles = {}, options = {}) {
  const store = new Map(Object.entries(initialFiles));
  const calls = { exists: [], delete: [] };
  const failExistsFor = options.failExistsFor ?? [];
  const failDeleteFor = options.failDeleteFor ?? [];
  return {
    store,
    calls,
    file(filePath) {
      return {
        async exists() {
          calls.exists.push(filePath);
          if (failExistsFor.includes(filePath)) throw new Error('Firebase Storage network error (exists)');
          return [store.has(filePath)];
        },
        async delete(options) {
          calls.delete.push({ path: filePath, options });
          if (failDeleteFor.includes(filePath)) throw new Error('Firebase Storage network error (delete)');
          store.delete(filePath);
        },
      };
    },
  };
}

function makeFakeR2Delete(options = {}) {
  const calls = [];
  const deleteR2 = async (key) => {
    calls.push(key);
    if (options.failFor && options.failFor.includes(key)) throw new Error('R2 network error');
  };
  return { calls, deleteR2 };
}

async function main() {
  const authorUid = 'u1';
  const otherUid = 'u2';
  const contentIdA = 'event-A';
  const contentIdB = 'event-B';
  const coverKeyA = `eventCovers/${authorUid}/${contentIdA}/photo`;
  const coverKeyB = `eventCovers/${authorUid}/${contentIdB}/photo`;

  // ---- EXACT Event ownership (isTrustedEventCoverStoragePath) ------------

  await check('a key exactly matching THIS Event\'s own authorUid + contentId is trusted', () => {
    assert.equal(isTrustedEventCoverStoragePath(coverKeyA, authorUid, contentIdA), true);
  });

  await check('SECURITY — same author, but the WRONG contentId (cross-Event reuse) is rejected', () => {
    // coverKeyB really exists (belongs to a different real Event, B, by
    // the same author) — asking to trust it while claiming contentId A
    // must fail, even though authorUid matches.
    assert.equal(isTrustedEventCoverStoragePath(coverKeyB, authorUid, contentIdA), false);
  });

  await check('SECURITY — the exact same contentId under a DIFFERENT uid is rejected (cross-user)', () => {
    assert.equal(isTrustedEventCoverStoragePath(coverKeyA, otherUid, contentIdA), false);
  });

  await check('SECURITY — correct uid and contentId strings, but swapped into the wrong slots, are rejected', () => {
    // A hostile value that happens to look plausible if the two
    // identifiers were ever confused with each other.
    assert.equal(isTrustedEventCoverStoragePath(`eventCovers/${contentIdA}/${authorUid}/photo`, authorUid, contentIdA), false);
  });

  await check('an unrelated media kind (a Reel source key) is rejected regardless of uid/contentId', () => {
    assert.equal(isTrustedEventCoverStoragePath(`reels/${authorUid}/reel1/source`, authorUid, contentIdA), false);
  });

  await check('a path missing the trailing /photo segment is rejected', () => {
    assert.equal(isTrustedEventCoverStoragePath(`eventCovers/${authorUid}/${contentIdA}`, authorUid, contentIdA), false);
  });

  await check('a made-up/arbitrary string is rejected, never trusted', () => {
    assert.equal(isTrustedEventCoverStoragePath('anything-i-want', authorUid, contentIdA), false);
  });

  await check('a legacy draftId-scheme path (independent of this Event\'s real contentId) is rejected — essentially never a coincidental match', () => {
    assert.equal(isTrustedEventCoverStoragePath(`eventCovers/${authorUid}/some-unrelated-draft-id/photo`, authorUid, contentIdA), false);
  });

  await check('an empty authorUid or empty contentId never matches anything', () => {
    assert.equal(isTrustedEventCoverStoragePath(coverKeyA, '', contentIdA), false);
    assert.equal(isTrustedEventCoverStoragePath(coverKeyA, authorUid, ''), false);
  });

  // ---- cleanupEventOwnedMedia: core behavior ------------------------------

  await check('Firebase cover: deletes via bucket.file().delete(), reports attempted+deleted true', async () => {
    const bucket = makeFakeBucket({ [coverKeyA]: Buffer.from('COVER') });
    const event = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyA, coverStorageProvider: 'firebase' };
    const result = await cleanupEventOwnedMedia(bucket, event);
    assert.deepEqual(result, { coverAttempted: true, coverDeleted: true });
    assert.equal(bucket.store.has(coverKeyA), false);
  });

  await check('R2 cover: deletes via the authenticated R2 delete, never touches the Firebase bucket', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const event = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyA, coverStorageProvider: 'r2' };
    const result = await cleanupEventOwnedMedia(bucket, event, { deleteR2: r2.deleteR2 });
    assert.deepEqual(result, { coverAttempted: true, coverDeleted: true });
    assert.deepEqual(r2.calls, [coverKeyA]);
    assert.deepEqual(bucket.calls.exists, []);
    assert.deepEqual(bucket.calls.delete, []);
  });

  await check('a legacy Event with no coverStoragePath at all attempts nothing, never throws', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const event = { authorUid, contentId: contentIdA, coverPhotoURL: 'https://example.com/old-cover.jpg' };
    const result = await cleanupEventOwnedMedia(bucket, event, { deleteR2: r2.deleteR2 });
    assert.deepEqual(result, { coverAttempted: false, coverDeleted: false });
    assert.deepEqual(r2.calls, []);
  });

  await check('an Event with no cover at all (no coverPhotoURL, no storage fields) attempts nothing', async () => {
    const bucket = makeFakeBucket();
    const event = { authorUid, contentId: contentIdA, title: 'Just an Event' };
    const result = await cleanupEventOwnedMedia(bucket, event);
    assert.deepEqual(result, { coverAttempted: false, coverDeleted: false });
  });

  await check('a legacy draftId-scheme coverStoragePath (predates contentId binding) is never deleted, even with a matching provider field', async () => {
    const legacyKey = `eventCovers/${authorUid}/old-random-draft-id/photo`;
    const bucket = makeFakeBucket({ [legacyKey]: Buffer.from('OLD SCHEME COVER') });
    const event = { authorUid, contentId: contentIdA, coverStoragePath: legacyKey, coverStorageProvider: 'firebase' };
    const result = await cleanupEventOwnedMedia(bucket, event);
    assert.deepEqual(result, { coverAttempted: false, coverDeleted: false });
    assert.equal(bucket.store.has(legacyKey), true);
  });

  await check('SECURITY — a coverStoragePath reused from a DIFFERENT Event by the SAME author is never deleted when THIS Event is removed', async () => {
    // Event B's real cover must survive Event A being deleted, even if
    // Event A's own document somehow claims coverKeyB (the exact gap
    // Step 2B closes).
    const bucket = makeFakeBucket({ [coverKeyB]: Buffer.from('EVENT B REAL COVER') });
    const r2 = makeFakeR2Delete();
    const maliciousEventA = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyB, coverStorageProvider: 'firebase' };
    const result = await cleanupEventOwnedMedia(bucket, maliciousEventA, { deleteR2: r2.deleteR2 });
    assert.deepEqual(result, { coverAttempted: false, coverDeleted: false });
    assert.equal(bucket.store.has(coverKeyB), true, "Event B's real cover must survive");
    assert.deepEqual(r2.calls, []);
  });

  await check('SECURITY — a coverStoragePath under a DIFFERENT user\'s namespace is never deleted', async () => {
    const otherUsersCover = `eventCovers/${otherUid}/${contentIdA}/photo`;
    const bucket = makeFakeBucket({ [otherUsersCover]: Buffer.from('NOT MINE') });
    const event = { authorUid, contentId: contentIdA, coverStoragePath: otherUsersCover, coverStorageProvider: 'firebase' };
    const result = await cleanupEventOwnedMedia(bucket, event);
    assert.deepEqual(result, { coverAttempted: false, coverDeleted: false });
    assert.equal(bucket.store.has(otherUsersCover), true);
  });

  // ---- Already-deleted / missing media (idempotency) ----------------------

  await check('idempotent: a Firebase cover already gone reports attempted true, deleted false, never an error', async () => {
    const bucket = makeFakeBucket();
    const event = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyA, coverStorageProvider: 'firebase' };
    const result = await cleanupEventOwnedMedia(bucket, event);
    assert.deepEqual(result, { coverAttempted: true, coverDeleted: false });
  });

  await check('idempotent: an R2 delete call for an already-gone object is still reported as attempted/deleted true', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const event = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyA, coverStorageProvider: 'r2' };
    const result = await cleanupEventOwnedMedia(bucket, event, { deleteR2: r2.deleteR2 });
    assert.deepEqual(result, { coverAttempted: true, coverDeleted: true });
  });

  // ---- Storage provider failures ------------------------------------------

  await check('a Firebase .exists() throw is caught — reported attempted true, deleted false, never throws', async () => {
    const bucket = makeFakeBucket({}, { failExistsFor: [coverKeyA] });
    const event = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyA, coverStorageProvider: 'firebase' };
    const result = await cleanupEventOwnedMedia(bucket, event);
    assert.deepEqual(result, { coverAttempted: true, coverDeleted: false });
  });

  await check('a Firebase .delete() throw is caught — reported attempted true, deleted false, never throws', async () => {
    const bucket = makeFakeBucket({ [coverKeyA]: Buffer.from('COVER') }, { failDeleteFor: [coverKeyA] });
    const event = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyA, coverStorageProvider: 'firebase' };
    const result = await cleanupEventOwnedMedia(bucket, event);
    assert.deepEqual(result, { coverAttempted: true, coverDeleted: false });
  });

  await check('an R2 delete throw is caught — reported attempted true, deleted false, never throws', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete({ failFor: [coverKeyA] });
    const event = { authorUid, contentId: contentIdA, coverStoragePath: coverKeyA, coverStorageProvider: 'r2' };
    const result = await cleanupEventOwnedMedia(bucket, event, { deleteR2: r2.deleteR2 });
    assert.deepEqual(result, { coverAttempted: true, coverDeleted: false });
  });

  console.log('\n=== functions/ Event media cleanup logic test results ===');
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
