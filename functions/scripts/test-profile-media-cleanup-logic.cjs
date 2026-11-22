/**
 * Plain-Node tests for cleanupProfileOwnedMedia
 * (functions/src/media/profileMediaCleanup.ts) — the shared cleanup used by
 * account deletion (deleteProfileDocuments, functions/src/index.ts) to fix
 * the confirmed gap where a user's profilePhotos/{uid}/photo and
 * profileCovers/{uid}/photo objects were never deleted on either backend.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { cleanupProfileOwnedMedia } = require('../lib/media/profileMediaCleanup.js');
const { profileCoverKey, profilePhotoKey } = require('../lib/media/objectKey.js');

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
 * `failExistsFor`/`failDeleteFor` simulate a genuine Firebase Storage
 * Admin SDK failure (permission/network/outage) at a specific key — NOT
 * a missing object, which `{ ignoreNotFound: true }` already handles on
 * its own. Used to verify deleteFirebaseKey's own try/catch actually
 * catches a real throw from either call, matching attemptR2Delete's own
 * already-tested behavior for the R2 side.
 */
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
          if (failExistsFor.includes(filePath)) {
            throw new Error('Firebase Storage network error (exists)');
          }
          return [store.has(filePath)];
        },
        async delete(options) {
          calls.delete.push({ path: filePath, options });
          if (failDeleteFor.includes(filePath)) {
            throw new Error('Firebase Storage network error (delete)');
          }
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
    if (options.failFor && options.failFor.includes(key)) {
      throw new Error('R2 network error');
    }
  };
  return { calls, deleteR2 };
}

async function main() {
  const uid = 'u1';
  const photoKey = profilePhotoKey(uid);
  const coverKey = profileCoverKey(uid);

  await check('derives both deterministic keys from uid alone, matching objectKey.ts exactly', () => {
    assert.equal(photoKey, 'profilePhotos/u1/photo');
    assert.equal(coverKey, 'profileCovers/u1/photo');
  });

  await check('a Firebase-resident photo and cover are both deleted, and R2 is still attempted for both (no provider field to branch on)', async () => {
    const bucket = makeFakeBucket({ [photoKey]: Buffer.from('PHOTO'), [coverKey]: Buffer.from('COVER') });
    const r2 = makeFakeR2Delete();
    const result = await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.deepEqual(result, {
      photoFirebaseDeleted: true,
      photoR2Attempted: true,
      coverFirebaseDeleted: true,
      coverR2Attempted: true,
    });
    assert.equal(bucket.store.has(photoKey), false);
    assert.equal(bucket.store.has(coverKey), false);
    assert.deepEqual(r2.calls.sort(), [coverKey, photoKey].sort());
  });

  await check('an R2-only pair (never written to Firebase) still gets a real R2 delete call for both keys', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const result = await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.equal(result.photoFirebaseDeleted, false);
    assert.equal(result.photoR2Attempted, true);
    assert.equal(result.coverFirebaseDeleted, false);
    assert.equal(result.coverR2Attempted, true);
  });

  await check('idempotent: already-missing objects on both backends report false/true (attempted), never an error', async () => {
    const bucket = makeFakeBucket(); // nothing exists
    const r2 = makeFakeR2Delete();
    await assert.doesNotReject(() => cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 }));
  });

  await check('a failed R2 delete for the photo key is caught and reported as not-attempted, and never blocks the cover delete', async () => {
    const bucket = makeFakeBucket({ [coverKey]: Buffer.from('COVER') });
    const r2 = makeFakeR2Delete({ failFor: [photoKey] });
    const result = await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.equal(result.photoR2Attempted, false);
    assert.equal(result.coverFirebaseDeleted, true);
    assert.equal(result.coverR2Attempted, true);
  });

  await check('never touches another uid\'s keys', async () => {
    const bucket = makeFakeBucket({
      [profilePhotoKey('other-user')]: Buffer.from('NOT MINE'),
    });
    const r2 = makeFakeR2Delete();
    await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.equal(bucket.store.has(profilePhotoKey('other-user')), true);
    assert.ok(!r2.calls.includes(profilePhotoKey('other-user')));
  });

  await check('a Firebase .exists() throw for the photo key is caught — reported false, cleanup continues, never throws', async () => {
    const bucket = makeFakeBucket({ [coverKey]: Buffer.from('COVER') }, { failExistsFor: [photoKey] });
    const r2 = makeFakeR2Delete();
    const result = await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.equal(result.photoFirebaseDeleted, false);
    assert.equal(result.coverFirebaseDeleted, true);
  });

  await check('a Firebase .delete() throw for the cover key is caught — reported false, cleanup continues, never throws', async () => {
    const bucket = makeFakeBucket({ [photoKey]: Buffer.from('PHOTO'), [coverKey]: Buffer.from('COVER') }, { failDeleteFor: [coverKey] });
    const r2 = makeFakeR2Delete();
    const result = await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.equal(result.photoFirebaseDeleted, true);
    assert.equal(result.coverFirebaseDeleted, false);
  });

  await check('a Firebase failure deleting the PHOTO never prevents the COVER delete from being attempted', async () => {
    const bucket = makeFakeBucket({ [coverKey]: Buffer.from('COVER') }, { failDeleteFor: [photoKey] });
    const r2 = makeFakeR2Delete();
    await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.ok(bucket.calls.delete.some((call) => call.path === coverKey));
    assert.equal(bucket.store.has(coverKey), false);
  });

  await check('a Firebase failure on the photo key never prevents R2 cleanup from being attempted for either key', async () => {
    const bucket = makeFakeBucket({}, { failExistsFor: [photoKey], failDeleteFor: [photoKey] });
    const r2 = makeFakeR2Delete();
    const result = await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    assert.equal(result.photoR2Attempted, true);
    assert.equal(result.coverR2Attempted, true);
    assert.deepEqual(r2.calls.sort(), [coverKey, photoKey].sort());
  });

  await check('BOTH backends failing for BOTH keys never throws out of cleanupProfileOwnedMedia', async () => {
    const bucket = makeFakeBucket({}, { failExistsFor: [photoKey, coverKey], failDeleteFor: [photoKey, coverKey] });
    const r2 = makeFakeR2Delete({ failFor: [photoKey, coverKey] });
    let result;
    await assert.doesNotReject(async () => {
      result = await cleanupProfileOwnedMedia(bucket, uid, { deleteR2: r2.deleteR2 });
    });
    assert.deepEqual(result, {
      photoFirebaseDeleted: false,
      photoR2Attempted: false,
      coverFirebaseDeleted: false,
      coverR2Attempted: false,
    });
  });

  console.log('\n=== functions/ Profile media cleanup (account deletion) logic test results ===');
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
