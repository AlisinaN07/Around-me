/**
 * Step 9A/10B — plain-Node tests for performReelSourceDiscardCleanup
 * (functions/src/media/reelDiscardCleanup.ts) — the actual cleanup
 * ORCHESTRATION behind the discardReelSource callable, extracted into its
 * own dependency-free file (no firebase-functions/firebase-admin import —
 * see that file's own doc comment for why, same reason as
 * mediaUploadValidation.ts) specifically so it's directly testable with a
 * plain spy instead of a real R2 client or a live Firestore/Auth context.
 * The callable's own ownership/status GATE is checkReelDiscardEligibility,
 * already covered exhaustively in test-reel-eligibility-logic.cjs — this
 * file assumes that gate has already passed (matching
 * handleDiscardReelSourceRequest's own real control flow, in
 * discardReelSource.ts) and focuses purely on "given an eligible Reel,
 * which R2 objects does cleanup actually touch, and how does it derive
 * their keys." Step 10B extended this to the Reel's own standalone music
 * object too — see every test's own `musicAttempted` field below.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const { performReelSourceDiscardCleanup } = require('../lib/media/reelDiscardCleanup.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function spy() {
  const calls = [];
  const fn = async (key) => {
    calls.push(key);
  };
  fn.calls = calls;
  return fn;
}

async function main() {
  await check('all three providers "firebase" (or music absent) — no R2 delete attempted for any object', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'firebase', thumbnailStorageProvider: 'firebase' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: false, thumbnailAttempted: false, musicAttempted: false });
    assert.equal(deleteObject.calls.length, 0);
  });

  await check('video "r2", thumbnail "firebase", no music — deletes ONLY the video object, at the deterministic source key', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'firebase' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: false, musicAttempted: false });
    assert.deepEqual(deleteObject.calls, ['reels/uid1/reel1/source']);
  });

  await check('video "firebase", thumbnail "r2", no music — deletes ONLY the thumbnail object, at the deterministic thumbnail key', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'firebase', thumbnailStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: false, thumbnailAttempted: true, musicAttempted: false });
    assert.deepEqual(deleteObject.calls, ['reels/uid1/reel1/thumbnail']);
  });

  await check('video + thumbnail both "r2", no music — deletes BOTH objects, at their own independent deterministic keys', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: true, musicAttempted: false });
    assert.deepEqual(deleteObject.calls.sort(), ['reels/uid1/reel1/source', 'reels/uid1/reel1/thumbnail'].sort());
  });

  // -------------------------------------------------------------------
  // Step 10B — the Reel's own standalone music object.
  // -------------------------------------------------------------------

  await check('Step 10B — musicStorageProvider "r2" — deletes the music object too, at its own deterministic key', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'firebase', thumbnailStorageProvider: 'firebase', musicStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: false, thumbnailAttempted: false, musicAttempted: true });
    assert.deepEqual(deleteObject.calls, ['reels/uid1/reel1/music']);
  });

  await check('Step 10B — musicStorageProvider "firebase" (or missing) never attempts an R2 music delete', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup({ storageProvider: 'firebase', thumbnailStorageProvider: 'firebase' }, 'uid1', 'reel1', deleteObject);
    assert.equal(result.musicAttempted, false);
    assert.equal(deleteObject.calls.length, 0);
  });

  await check('Step 10B — ALL THREE objects on R2 — deletes video, thumbnail, AND music, each at its own independent deterministic key', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2', musicStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: true, musicAttempted: true });
    assert.deepEqual(
      deleteObject.calls.sort(),
      ['reels/uid1/reel1/source', 'reels/uid1/reel1/thumbnail', 'reels/uid1/reel1/music'].sort()
    );
  });

  await check('Step 10B — MIXED providers: source on R2, thumbnail on Firebase, music on R2 — attempts exactly source+music on R2, nothing for thumbnail', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'firebase', musicStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: false, musicAttempted: true });
    assert.deepEqual(deleteObject.calls.sort(), ['reels/uid1/reel1/music', 'reels/uid1/reel1/source'].sort());
  });

  await check('Step 10B — a failed R2 music delete is caught — never throws out of the function, and never blocks video/thumbnail cleanup', async () => {
    const calls = [];
    const deleteObject = async (key) => {
      calls.push(key);
      if (key.endsWith('/music')) throw new Error('R2 network error');
    };
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2', musicStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: true, musicAttempted: true });
    assert.deepEqual(
      calls.sort(),
      ['reels/uid1/reel1/source', 'reels/uid1/reel1/thumbnail', 'reels/uid1/reel1/music'].sort()
    );
  });

  await check('Step 10B — SECURITY: the music key is derived from uid/reelId parameters alone — never from any field on the Reel document', async () => {
    const deleteObject = spy();
    await performReelSourceDiscardCleanup(
      { musicStorageProvider: 'r2', musicStorageAudioPath: 'reels/attacker-uid/reel1/music', authorUid: 'attacker-controlled-value' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(deleteObject.calls, ['reels/uid1/reel1/music']);
  });

  await check('key derivation uses ONLY the authenticated uid + reelId parameters — never anything read off the reel object itself', async () => {
    const deleteObject = spy();
    // A reel object carrying a hostile/foreign authorUid field — the
    // function must still derive the key from the `uid`/`reelId`
    // PARAMETERS (which the real caller only ever populates from
    // request.auth.uid and the already-validated reelId), never from
    // anything inside the Reel document itself.
    await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2', musicStorageProvider: 'r2', authorUid: 'attacker-controlled-value' },
      'uid1',
      'reel1',
      deleteObject
    );
    for (const key of deleteObject.calls) {
      assert.ok(!key.includes('attacker-controlled-value'), `key "${key}" must never be derived from Reel document contents`);
      assert.ok(key.startsWith('reels/uid1/reel1/'), `key "${key}" must be derived from the caller's own uid + validated reelId`);
    }
  });

  await check('a failed R2 delete for the video object is caught — cleanup still proceeds to attempt the thumbnail and music', async () => {
    const calls = [];
    const deleteObject = async (key) => {
      calls.push(key);
      if (key.endsWith('/source')) throw new Error('R2 network error');
    };
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2', musicStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    // "Attempted" reflects that a delete call was MADE, not that it
    // succeeded — see performReelSourceDiscardCleanup's own doc comment.
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: true, musicAttempted: true });
    assert.deepEqual(
      calls.sort(),
      ['reels/uid1/reel1/source', 'reels/uid1/reel1/thumbnail', 'reels/uid1/reel1/music'].sort()
    );
  });

  await check('a failed R2 delete for the thumbnail never throws out of the function — resolves normally', async () => {
    const deleteObject = async () => {
      throw new Error('R2 network error');
    };
    await assert.doesNotReject(() =>
      performReelSourceDiscardCleanup({ storageProvider: 'r2', thumbnailStorageProvider: 'r2' }, 'uid1', 'reel1', deleteObject)
    );
  });

  await check('Step 9C — a plain photo Reel post-lockstep-confirm (both providers "r2") attempts BOTH deletes, even though only the source object was ever real — the thumbnail delete is a harmless no-op, never an orphan', async () => {
    const deleteObject = spy();
    // Exactly the state a photo Reel is in after
    // src/services/reels.ts's own confirmReelPhotoSourceProvider —
    // storageProvider and thumbnailStorageProvider both 'r2', same as
    // the pre-existing "both r2" test above; this test's own point is
    // documenting WHY that's still correct for a photo Reel specifically
    // (see reelDiscardCleanup.ts's own doc comment). A plain photo Reel
    // never has music (musicStorageProvider stays at its 'firebase'
    // sentinel default), so musicAttempted stays false here.
    const result = await performReelSourceDiscardCleanup(
      { mediaType: 'photo', storageProvider: 'r2', thumbnailStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: true, musicAttempted: false });
    assert.deepEqual(deleteObject.calls.sort(), ['reels/uid1/reel1/source', 'reels/uid1/reel1/thumbnail'].sort());
  });

  await check('different uid/reelId produce different, non-colliding keys — one user\'s discard can never target another\'s namespace', async () => {
    const callsA = [];
    const callsB = [];
    await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'firebase' },
      'uid-a',
      'reel1',
      async (k) => callsA.push(k)
    );
    await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'firebase' },
      'uid-b',
      'reel1',
      async (k) => callsB.push(k)
    );
    assert.notDeepEqual(callsA, callsB);
  });

  console.log('\n=== functions/ discardReelSource cleanup orchestration test results ===');
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
