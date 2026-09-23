/**
 * Step 9A — plain-Node tests for performReelSourceDiscardCleanup
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
 * their keys."
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
  await check('both providers "firebase" — no R2 delete attempted for either object', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'firebase', thumbnailStorageProvider: 'firebase' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: false, thumbnailAttempted: false });
    assert.equal(deleteObject.calls.length, 0);
  });

  await check('video "r2", thumbnail "firebase" — deletes ONLY the video object, at the deterministic source key', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'firebase' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: false });
    assert.deepEqual(deleteObject.calls, ['reels/uid1/reel1/source']);
  });

  await check('video "firebase", thumbnail "r2" — deletes ONLY the thumbnail object, at the deterministic thumbnail key', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'firebase', thumbnailStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: false, thumbnailAttempted: true });
    assert.deepEqual(deleteObject.calls, ['reels/uid1/reel1/thumbnail']);
  });

  await check('both providers "r2" — deletes BOTH objects, at their own independent deterministic keys', async () => {
    const deleteObject = spy();
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: true });
    assert.deepEqual(deleteObject.calls.sort(), ['reels/uid1/reel1/source', 'reels/uid1/reel1/thumbnail'].sort());
  });

  await check('key derivation uses ONLY the authenticated uid + reelId parameters — never anything read off the reel object itself', async () => {
    const deleteObject = spy();
    // A reel object carrying a hostile/foreign authorUid field — the
    // function must still derive the key from the `uid`/`reelId`
    // PARAMETERS (which the real caller only ever populates from
    // request.auth.uid and the already-validated reelId), never from
    // anything inside the Reel document itself.
    await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2', authorUid: 'attacker-controlled-value' },
      'uid1',
      'reel1',
      deleteObject
    );
    for (const key of deleteObject.calls) {
      assert.ok(!key.includes('attacker-controlled-value'), `key "${key}" must never be derived from Reel document contents`);
      assert.ok(key.startsWith('reels/uid1/reel1/'), `key "${key}" must be derived from the caller's own uid + validated reelId`);
    }
  });

  await check('a failed R2 delete for the video object is caught — cleanup still proceeds to attempt the thumbnail', async () => {
    const calls = [];
    const deleteObject = async (key) => {
      calls.push(key);
      if (key.endsWith('/source')) throw new Error('R2 network error');
    };
    const result = await performReelSourceDiscardCleanup(
      { storageProvider: 'r2', thumbnailStorageProvider: 'r2' },
      'uid1',
      'reel1',
      deleteObject
    );
    // "Attempted" reflects that a delete call was MADE, not that it
    // succeeded — see performReelSourceDiscardCleanup's own doc comment.
    assert.deepEqual(result, { videoAttempted: true, thumbnailAttempted: true });
    assert.deepEqual(calls.sort(), ['reels/uid1/reel1/source', 'reels/uid1/reel1/thumbnail'].sort());
  });

  await check('a failed R2 delete for the thumbnail never throws out of the function — resolves normally', async () => {
    const deleteObject = async () => {
      throw new Error('R2 network error');
    };
    await assert.doesNotReject(() =>
      performReelSourceDiscardCleanup({ storageProvider: 'r2', thumbnailStorageProvider: 'r2' }, 'uid1', 'reel1', deleteObject)
    );
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
