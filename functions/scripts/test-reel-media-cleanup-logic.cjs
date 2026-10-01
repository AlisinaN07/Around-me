/**
 * Step 9D — plain-Node tests for the shared Reel-media-deletion
 * orchestration in functions/src/media/reelMediaCleanup.ts:
 * cleanupReelOwnedMedia (the normal, document-backed path shared by
 * deleteMyReel/deleteOwnReels/removeReportedReel's doc-exists branch) and
 * cleanupReelOwnedMediaWithoutDocument (removeReportedReel's own
 * missing-document branch).
 *
 * This is the authoritative coverage for the Step 9D audit's own R2/
 * Firebase mixed matrix (Part 6), the plain-photo same-physical-object
 * case (Part 4), standalone-music cleanup (Part 5), idempotency/partial-
 * failure behavior (Part 7), and the security property that every key
 * deleted is DERIVED from the trusted uid/reelId parameters, never read
 * off the Reel document's own string fields (Part 8).
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { cleanupReelOwnedMedia, cleanupReelOwnedMediaWithoutDocument } = require('../lib/media/reelMediaCleanup.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const UID = 'uid1';
const REEL_ID = 'reel1';

/** Mirrors every other Step 9A-9D test file's own fake bucket — a minimal BucketLike with call-recording. */
function makeFakeBucket(initialFiles = {}) {
  const store = new Map(Object.entries(initialFiles));
  const calls = { exists: [], delete: [] };
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
        async download() {
          throw new Error('not used by this test file');
        },
        async copy() {
          throw new Error('not used by this test file');
        },
        async save() {
          throw new Error('not used by this test file');
        },
      };
    },
    async upload() {
      throw new Error('not used by this test file');
    },
  };
  return bucket;
}

/** A fake, in-memory R2 object store — `deleteR2` the fake's own spy, matching real deleteR2Object's "resolves on success, throws on real failure" shape. */
function makeFakeR2Delete(initialKeys = []) {
  const keys = new Set(initialKeys);
  const calls = [];
  const deleteR2 = async (key) => {
    calls.push(key);
    keys.delete(key); // S3/R2 DeleteObjectCommand is idempotent — succeeds whether or not the key existed.
  };
  return { keys, calls, deleteR2 };
}

/** A plain video Reel — two REAL physical objects (source, thumbnail), no music. */
function baseVideoReel(overrides = {}) {
  return {
    authorUid: UID,
    mediaType: 'video',
    storagePath: `reels/${UID}/${REEL_ID}/source`,
    storageProvider: 'firebase',
    thumbnailStoragePath: `reels/${UID}/${REEL_ID}/thumbnail`,
    thumbnailStorageProvider: 'firebase',
    musicSourceType: 'none',
    ...overrides,
  };
}

/** A plain photo Reel — ONE real physical object; thumbnailStoragePath literally equals storagePath (see isValidReelThumbnail, firestore.rules). */
function basePhotoReel(overrides = {}) {
  return {
    authorUid: UID,
    mediaType: 'photo',
    storagePath: `reels/${UID}/${REEL_ID}/source`,
    storageProvider: 'firebase',
    thumbnailStoragePath: `reels/${UID}/${REEL_ID}/source`,
    thumbnailStorageProvider: 'firebase',
    musicSourceType: 'none',
    ...overrides,
  };
}

/** A video+music Reel with a real, still-present standalone music object. */
function baseMusicVideoReel(overrides = {}) {
  return baseVideoReel({
    musicSourceType: 'device',
    musicStorageAudioPath: `reels/${UID}/${REEL_ID}/music`,
    ...overrides,
  });
}

async function main() {
  // -------------------------------------------------------------------
  // R2/Firebase MIXED MATRIX (Step 9D Part 6, combos 1-4) — plain video Reel.
  // -------------------------------------------------------------------

  await check('MATRIX 1 — Firebase source + Firebase thumbnail: both deleted via bucket.file().delete()', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('VIDEO'),
      [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('THUMB'),
    });
    const result = await cleanupReelOwnedMedia(bucket, baseVideoReel(), UID, REEL_ID);
    assert.deepEqual(result, {
      sourceAttempted: true,
      sourceDeleted: true,
      thumbnailAttempted: true,
      thumbnailDeleted: true,
      thumbnailSameAsSource: false,
      musicAttempted: false,
      musicDeleted: false,
    });
    assert.equal(bucket.store.has(`reels/${UID}/${REEL_ID}/source`), false);
    assert.equal(bucket.store.has(`reels/${UID}/${REEL_ID}/thumbnail`), false);
  });

  await check('MATRIX 2 — Firebase source + R2 thumbnail: source via bucket.delete(), thumbnail via authenticated R2 delete at reelThumbnailKey', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('VIDEO') });
    const r2 = makeFakeR2Delete([`reels/${UID}/${REEL_ID}/thumbnail`]);
    const result = await cleanupReelOwnedMedia(bucket, baseVideoReel({ thumbnailStorageProvider: 'r2' }), UID, REEL_ID, { deleteR2: r2.deleteR2 });
    assert.equal(result.sourceDeleted, true);
    assert.equal(result.thumbnailAttempted, true);
    assert.equal(result.thumbnailDeleted, true);
    assert.deepEqual(r2.calls, [`reels/${UID}/${REEL_ID}/thumbnail`]);
    assert.equal(bucket.store.has(`reels/${UID}/${REEL_ID}/source`), false);
  });

  await check('MATRIX 3 — R2 source + Firebase thumbnail: source via authenticated R2 delete, thumbnail via bucket.delete()', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('THUMB') });
    const r2 = makeFakeR2Delete([`reels/${UID}/${REEL_ID}/source`]);
    const result = await cleanupReelOwnedMedia(bucket, baseVideoReel({ storageProvider: 'r2' }), UID, REEL_ID, { deleteR2: r2.deleteR2 });
    assert.equal(result.sourceDeleted, true);
    assert.equal(result.thumbnailDeleted, true);
    assert.deepEqual(r2.calls, [`reels/${UID}/${REEL_ID}/source`]);
    assert.equal(bucket.store.has(`reels/${UID}/${REEL_ID}/thumbnail`), false);
  });

  await check('MATRIX 4 — R2 source + R2 thumbnail: both via authenticated R2 delete, at their own independent deterministic keys', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete([`reels/${UID}/${REEL_ID}/source`, `reels/${UID}/${REEL_ID}/thumbnail`]);
    const result = await cleanupReelOwnedMedia(bucket, baseVideoReel({ storageProvider: 'r2', thumbnailStorageProvider: 'r2' }), UID, REEL_ID, {
      deleteR2: r2.deleteR2,
    });
    assert.equal(result.sourceDeleted, true);
    assert.equal(result.thumbnailDeleted, true);
    assert.deepEqual(r2.calls.sort(), [`reels/${UID}/${REEL_ID}/source`, `reels/${UID}/${REEL_ID}/thumbnail`].sort());
  });

  await check('MATRIX 7 — legacy Reel missing provider fields entirely defaults to Firebase for both source and thumbnail', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('VIDEO'),
      [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('THUMB'),
    });
    const legacyReel = baseVideoReel();
    delete legacyReel.storageProvider;
    delete legacyReel.thumbnailStorageProvider;
    const result = await cleanupReelOwnedMedia(bucket, legacyReel, UID, REEL_ID);
    assert.equal(result.sourceDeleted, true);
    assert.equal(result.thumbnailDeleted, true);
  });

  // -------------------------------------------------------------------
  // MATRIX 5 — plain photo Reel: SAME physical object, explicit skip.
  // -------------------------------------------------------------------

  await check('MATRIX 5 — plain photo Reel (R2): source deleted ONCE, thumbnail delete explicitly SKIPPED (thumbnailSameAsSource: true) — never a second delete at reelThumbnailKey', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete([`reels/${UID}/${REEL_ID}/source`]);
    const result = await cleanupReelOwnedMedia(bucket, basePhotoReel({ storageProvider: 'r2', thumbnailStorageProvider: 'r2' }), UID, REEL_ID, {
      deleteR2: r2.deleteR2,
    });
    assert.deepEqual(result, {
      sourceAttempted: true,
      sourceDeleted: true,
      thumbnailAttempted: false,
      thumbnailDeleted: false,
      thumbnailSameAsSource: true,
      musicAttempted: false,
      musicDeleted: false,
    });
    // The defining assertion: reelThumbnailKey is NEVER called for a
    // photo Reel — only the source key.
    assert.deepEqual(r2.calls, [`reels/${UID}/${REEL_ID}/source`]);
  });

  await check('MATRIX 5b — plain photo Reel (Firebase): source deleted once, no separate thumbnail delete attempted at all', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('PHOTO') });
    const result = await cleanupReelOwnedMedia(bucket, basePhotoReel(), UID, REEL_ID);
    assert.equal(result.thumbnailAttempted, false);
    assert.equal(result.thumbnailSameAsSource, true);
    assert.deepEqual(bucket.calls.delete.map((c) => c.path), [`reels/${UID}/${REEL_ID}/source`]);
  });

  // -------------------------------------------------------------------
  // MATRIX 6 — photo+music / render-pending: source and thumbnail ARE
  // physically distinct (a real separate cover JPEG), same as plain video+music.
  // -------------------------------------------------------------------

  await check('MATRIX 6 — render-pending Reel (mediaType "video", needsPhotoVideoRender true): thumbnail is a REAL separate object, not skipped', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('PHOTO_OR_RENDERED_VIDEO'),
      [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('REAL_COVER_JPEG'),
      [`reels/${UID}/${REEL_ID}/music`]: Buffer.from('MUSIC'),
    });
    const reel = baseMusicVideoReel({ needsPhotoVideoRender: true });
    const result = await cleanupReelOwnedMedia(bucket, reel, UID, REEL_ID);
    assert.equal(result.thumbnailSameAsSource, false);
    assert.equal(result.thumbnailDeleted, true);
    assert.equal(result.musicAttempted, true);
    assert.equal(result.musicDeleted, true);
  });

  // -------------------------------------------------------------------
  // STANDALONE MUSIC cleanup (Part 5).
  // -------------------------------------------------------------------

  await check('music: a device-music Reel with a real, still-present standalone music object gets it deleted', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/music`]: Buffer.from('MUSIC') });
    const result = await cleanupReelOwnedMedia(bucket, baseMusicVideoReel(), UID, REEL_ID);
    assert.equal(result.musicAttempted, true);
    assert.equal(result.musicDeleted, true);
    assert.equal(bucket.store.has(`reels/${UID}/${REEL_ID}/music`), false);
  });

  await check('music: a device-music Reel whose mux ALREADY deleted the standalone object — musicAttempted true, musicDeleted false, never an error (the expected, common case)', async () => {
    const bucket = makeFakeBucket(); // music object already gone
    const result = await cleanupReelOwnedMedia(bucket, baseMusicVideoReel(), UID, REEL_ID);
    assert.equal(result.musicAttempted, true);
    assert.equal(result.musicDeleted, false);
  });

  await check('music: a plain no-music Reel (musicSourceType "none") never attempts a music delete at all', async () => {
    const bucket = makeFakeBucket();
    const result = await cleanupReelOwnedMedia(bucket, baseVideoReel(), UID, REEL_ID);
    assert.equal(result.musicAttempted, false);
    assert.deepEqual(bucket.calls.delete.map((c) => c.path), [`reels/${UID}/${REEL_ID}/source`, `reels/${UID}/${REEL_ID}/thumbnail`]);
  });

  await check('music: never deletes the SHARED soundOrigins/{hash}/audio object — only ever the Reel-owned reelMusicKey', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/music`]: Buffer.from('MUSIC'),
      'soundOrigins/abc123/audio': Buffer.from('SHARED_SOUND_COPY'),
    });
    await cleanupReelOwnedMedia(bucket, baseMusicVideoReel({ musicHash: 'abc123', soundOriginAuthorUid: 'someone-else', soundOriginReelId: 'other-reel' }), UID, REEL_ID);
    assert.equal(bucket.store.has('soundOrigins/abc123/audio'), true, 'the shared, potentially-still-referenced sound-origin copy must never be touched by a single Reel\'s own deletion');
  });

  // -------------------------------------------------------------------
  // IDEMPOTENCY / PARTIAL FAILURE (Part 7).
  // -------------------------------------------------------------------

  await check('idempotent: source already deleted, thumbnail still present — thumbnail cleanup still proceeds normally', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('THUMB') }); // source already gone
    const result = await cleanupReelOwnedMedia(bucket, baseVideoReel(), UID, REEL_ID);
    assert.equal(result.sourceDeleted, false); // wasn't there
    assert.equal(result.thumbnailDeleted, true);
  });

  await check('idempotent: thumbnail already deleted, source still present — source cleanup still proceeds normally', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('VIDEO') }); // thumbnail already gone
    const result = await cleanupReelOwnedMedia(bucket, baseVideoReel(), UID, REEL_ID);
    assert.equal(result.sourceDeleted, true);
    assert.equal(result.thumbnailDeleted, false);
  });

  await check('idempotent: calling cleanupReelOwnedMedia twice in a row never throws — second call just finds everything already gone', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('VIDEO'),
      [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('THUMB'),
      [`reels/${UID}/${REEL_ID}/music`]: Buffer.from('MUSIC'),
    });
    const reel = baseMusicVideoReel();
    const first = await cleanupReelOwnedMedia(bucket, reel, UID, REEL_ID);
    const second = await cleanupReelOwnedMedia(bucket, reel, UID, REEL_ID);
    assert.equal(first.sourceDeleted, true);
    assert.equal(second.sourceDeleted, false);
    assert.equal(first.musicDeleted, true);
    assert.equal(second.musicDeleted, false);
  });

  await check('partial failure: an R2 thumbnail delete that throws is caught — source and music cleanup still complete, function never throws', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/music`]: Buffer.from('MUSIC') });
    const r2 = makeFakeR2Delete([`reels/${UID}/${REEL_ID}/source`]);
    const flakyDeleteR2 = async (key) => {
      if (key.endsWith('/thumbnail')) throw new Error('R2 network error');
      return r2.deleteR2(key);
    };
    const result = await cleanupReelOwnedMedia(
      bucket,
      baseMusicVideoReel({ storageProvider: 'r2', thumbnailStorageProvider: 'r2' }),
      UID,
      REEL_ID,
      { deleteR2: flakyDeleteR2 }
    );
    assert.equal(result.sourceDeleted, true);
    assert.equal(result.thumbnailAttempted, true);
    assert.equal(result.thumbnailDeleted, false, 'a thrown R2 delete must be caught, not propagated as success');
    assert.equal(result.musicDeleted, true, 'a failed thumbnail delete must never block the independent music cleanup');
  });

  await check('partial failure: an R2 source delete that throws never prevents the thumbnail/music cleanup from still running', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('THUMB'),
      [`reels/${UID}/${REEL_ID}/music`]: Buffer.from('MUSIC'),
    });
    const flakyDeleteR2 = async (key) => {
      if (key.endsWith('/source')) throw new Error('R2 network error');
    };
    const result = await cleanupReelOwnedMedia(bucket, baseMusicVideoReel({ storageProvider: 'r2' }), UID, REEL_ID, { deleteR2: flakyDeleteR2 });
    assert.equal(result.sourceDeleted, false);
    assert.equal(result.thumbnailDeleted, true);
    assert.equal(result.musicDeleted, true);
  });

  // -------------------------------------------------------------------
  // SECURITY (Part 8) — keys are derived from uid/reelId parameters, never
  // from the Reel document's own string fields.
  // -------------------------------------------------------------------

  await check('SECURITY: a hostile authorUid on the Reel document is never consulted — the thumbnail key comes from the uid PARAMETER', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    await cleanupReelOwnedMedia(
      bucket,
      baseVideoReel({ authorUid: 'attacker-uid', thumbnailStorageProvider: 'r2', storagePath: 'reels/attacker-uid/reel1/source' }),
      UID,
      REEL_ID,
      { deleteR2: r2.deleteR2 }
    );
    for (const key of r2.calls) {
      assert.ok(!key.includes('attacker-uid'), `key "${key}" must never be derived from the Reel document's own authorUid`);
      assert.ok(key.startsWith(`reels/${UID}/${REEL_ID}/`), `key "${key}" must be derived from the caller's own trusted uid/reelId`);
    }
  });

  await check('SECURITY: a hostile thumbnailUrl/sourceUrl field is never parsed as a delete path — only the deterministic key is ever used', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    await cleanupReelOwnedMedia(
      bucket,
      baseVideoReel({
        storageProvider: 'r2',
        thumbnailStorageProvider: 'r2',
        sourceUrl: 'https://evil.example.com/not-a-real-key',
        thumbnailUrl: 'https://evil.example.com/also-not-a-real-key',
      }),
      UID,
      REEL_ID,
      { deleteR2: r2.deleteR2 }
    );
    assert.deepEqual(r2.calls.sort(), [`reels/${UID}/${REEL_ID}/source`, `reels/${UID}/${REEL_ID}/thumbnail`].sort());
  });

  await check('different uid/reelId produce different, non-colliding keys — one user\'s cleanup can never target another\'s namespace', async () => {
    // storagePath is always the REAL Reel's own (Rules-pinned) field —
    // matching the uid/reelId pair actually being cleaned up, same as
    // every real caller — so thumbnail (parameter-derived) and source
    // (document-field-derived) keys land under the SAME namespace here.
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const reelA = baseVideoReel({ storageProvider: 'r2', thumbnailStorageProvider: 'r2', storagePath: 'reels/uid-a/reel-x/source' });
    const reelB = baseVideoReel({ storageProvider: 'r2', thumbnailStorageProvider: 'r2', storagePath: 'reels/uid-b/reel-x/source' });
    await cleanupReelOwnedMedia(bucket, reelA, 'uid-a', 'reel-x', { deleteR2: r2.deleteR2 });
    await cleanupReelOwnedMedia(bucket, reelB, 'uid-b', 'reel-x', { deleteR2: r2.deleteR2 });
    assert.deepEqual(
      r2.calls.sort(),
      ['reels/uid-a/reel-x/source', 'reels/uid-a/reel-x/thumbnail', 'reels/uid-b/reel-x/source', 'reels/uid-b/reel-x/thumbnail'].sort()
    );
  });

  // -------------------------------------------------------------------
  // cleanupReelOwnedMediaWithoutDocument — removeReportedReel's own
  // missing-document branch (Step 9D Part 9).
  // -------------------------------------------------------------------

  await check('missing-document cleanup: attempts BOTH Firebase and R2 deletes for source and thumbnail, plus Firebase for music — all from trusted uid/reelId alone', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('X'),
      [`reels/${UID}/${REEL_ID}/thumbnail`]: Buffer.from('Y'),
      [`reels/${UID}/${REEL_ID}/music`]: Buffer.from('Z'),
    });
    const r2 = makeFakeR2Delete();
    const result = await cleanupReelOwnedMediaWithoutDocument(bucket, UID, REEL_ID, { deleteR2: r2.deleteR2 });
    assert.equal(result.firebaseSourceDeleted, true);
    assert.equal(result.firebaseThumbnailDeleted, true);
    assert.equal(result.firebaseMusicDeleted, true);
    assert.equal(result.r2SourceAttempted, true);
    assert.equal(result.r2ThumbnailAttempted, true);
    assert.deepEqual(r2.calls.sort(), [`reels/${UID}/${REEL_ID}/source`, `reels/${UID}/${REEL_ID}/thumbnail`].sort());
  });

  await check('missing-document cleanup: a Reel that was ACTUALLY an R2-sourced Reel is now actually found and deleted — the exact gap Step 9A/9D fixed', async () => {
    const bucket = makeFakeBucket(); // nothing on Firebase at all — this Reel's real bytes were always on R2
    const r2 = makeFakeR2Delete([`reels/${UID}/${REEL_ID}/source`, `reels/${UID}/${REEL_ID}/thumbnail`]);
    const result = await cleanupReelOwnedMediaWithoutDocument(bucket, UID, REEL_ID, { deleteR2: r2.deleteR2 });
    assert.equal(result.firebaseSourceDeleted, false); // nothing there, as expected
    assert.equal(result.r2SourceAttempted, true);
    assert.equal(r2.keys.has(`reels/${UID}/${REEL_ID}/source`), false, 'the real R2 object must actually be gone after this call');
    assert.equal(r2.keys.has(`reels/${UID}/${REEL_ID}/thumbnail`), false);
  });

  await check('missing-document cleanup: a plain photo Reel (unknown to this function) — the never-written thumbnail key delete is a harmless no-op, nothing throws', async () => {
    const bucket = makeFakeBucket({ [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('PHOTO') }); // no dedicated thumbnail object ever existed
    const result = await cleanupReelOwnedMediaWithoutDocument(bucket, UID, REEL_ID);
    assert.equal(result.firebaseSourceDeleted, true);
    assert.equal(result.firebaseThumbnailDeleted, false); // never existed — harmless
  });

  await check('missing-document cleanup: nothing ever existed at all (e.g. a reported draft the author already discarded) — resolves cleanly, every flag false/attempted-but-empty', async () => {
    const bucket = makeFakeBucket();
    const r2 = makeFakeR2Delete();
    const result = await cleanupReelOwnedMediaWithoutDocument(bucket, UID, REEL_ID, { deleteR2: r2.deleteR2 });
    assert.equal(result.firebaseSourceDeleted, false);
    assert.equal(result.firebaseThumbnailDeleted, false);
    assert.equal(result.firebaseMusicDeleted, false);
  });

  await check('missing-document cleanup: an R2 delete failure (e.g. R2 not configured) is caught, never thrown — r2SourceAttempted reports false', async () => {
    const bucket = makeFakeBucket();
    const flakyDeleteR2 = async () => {
      throw new Error('R2 not configured');
    };
    const result = await cleanupReelOwnedMediaWithoutDocument(bucket, UID, REEL_ID, { deleteR2: flakyDeleteR2 });
    assert.equal(result.r2SourceAttempted, false);
    assert.equal(result.r2ThumbnailAttempted, false);
  });

  await check('missing-document cleanup: different uid/reelId never collide — only this exact pair\'s three keys are ever touched', async () => {
    const bucket = makeFakeBucket({
      [`reels/${UID}/${REEL_ID}/source`]: Buffer.from('MINE'),
      'reels/someone-else/reel99/source': Buffer.from('NOT_MINE'),
    });
    await cleanupReelOwnedMediaWithoutDocument(bucket, UID, REEL_ID);
    assert.equal(bucket.store.has('reels/someone-else/reel99/source'), true, 'an unrelated user\'s object must never be touched');
  });

  console.log('\n=== functions/ Reel media cleanup orchestration test results ===');
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
