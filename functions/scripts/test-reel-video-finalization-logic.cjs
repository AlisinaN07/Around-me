/**
 * Step 11B — plain-Node tests for performReelVideoFinalization
 * (functions/src/media/reelVideoFinalization.ts) — the pure orchestration
 * behind the NEW finalizeReelVideo callable, extracted into its own
 * dependency-free file (no firebase-functions/firebase-admin import) the
 * same way reelMuxOrchestration.ts's own performReelMux already is — see
 * that file's own doc comment for why this is a SEPARATE orchestration
 * rather than a reuse of performReelMux itself.
 *
 * finalizeReelVideo's own real Firestore ownership/status/mediaType/
 * music-state gate (checkReelVideoFinalizationEligibility) is already
 * covered exhaustively in test-reel-eligibility-logic.cjs — this file
 * assumes that gate has already passed and focuses purely on "given an
 * eligible plain-video Reel, what does finalization actually do, in what
 * order, and how does every failure mode behave."
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const {
  performReelVideoFinalization,
  REEL_NORMALIZED_VIDEO_MAX_SIZE_BYTES,
} = require('../lib/media/reelVideoFinalization.js');
const { buildReelVideoNormalizationMetadata, REEL_VIDEO_NORMALIZATION_METADATA_KEY } = require('../lib/media/reelVideoProfile.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const PATHS = { localVideoPath: '/tmp/fake-input-video', localOutputPath: '/tmp/fake-output.mp4' };

/** A fully successful, minimal dep set — individual tests override just the one function they care about. */
function makeDeps(overrides = {}) {
  const updateCalls = [];
  return {
    downloadVideo: async () => true,
    runFfmpegNormalize: async () => undefined,
    statFileSize: async () => 12_345_678,
    uploadNormalizedVideo: async () => undefined,
    updateReelDocument: async (fields) => {
      updateCalls.push(fields);
    },
    buildVersionedSourceUrl: () => null,
    _updateCalls: updateCalls,
    ...overrides,
  };
}

/**
 * Step 11B — a fully call-COUNTING dep set, for the idempotency/retry
 * tests below: every expensive step (ffmpeg, upload) is instrumented so a
 * test can assert EXACTLY how many times it ran across one or more
 * performReelVideoFinalization invocations — Part 10 of the spec's own
 * explicit "ffmpeg calls = 1 total across both attempts, not 2" proof.
 * `canonicalState` seeds what `readCanonicalSourceState` reports;
 * `confirmShouldFail` lets a test simulate exactly one failed confirm
 * before a later retry succeeds.
 */
function makeCountingDeps({ canonicalState = null, confirmShouldFail = false } = {}) {
  const counts = { readCanonicalSourceState: 0, downloadVideo: 0, runFfmpegNormalize: 0, uploadNormalizedVideo: 0, updateReelDocument: 0 };
  const updateCalls = [];
  let confirmShouldFailNow = confirmShouldFail;
  return {
    counts,
    updateCalls,
    readCanonicalSourceState: async () => {
      counts.readCanonicalSourceState += 1;
      return canonicalState;
    },
    downloadVideo: async () => {
      counts.downloadVideo += 1;
      return true;
    },
    runFfmpegNormalize: async () => {
      counts.runFfmpegNormalize += 1;
    },
    statFileSize: async () => 12_345_678,
    uploadNormalizedVideo: async () => {
      counts.uploadNormalizedVideo += 1;
    },
    updateReelDocument: async (fields) => {
      counts.updateReelDocument += 1;
      if (confirmShouldFailNow) {
        confirmShouldFailNow = false;
        throw new Error('transient Firestore error');
      }
      updateCalls.push(fields);
    },
    buildVersionedSourceUrl: () => null,
  };
}

async function main() {
  // -------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------

  await check('happy path: download -> ffmpeg -> upload -> confirm, in that order, all succeed', async () => {
    const calls = [];
    const deps = makeDeps({
      downloadVideo: async (p) => {
        calls.push(`download:${p}`);
        return true;
      },
      runFfmpegNormalize: async (i, o) => {
        calls.push(`ffmpeg:${i}->${o}`);
      },
      uploadNormalizedVideo: async (p) => {
        calls.push(`upload:${p}`);
      },
      updateReelDocument: async (fields) => {
        calls.push(`confirm:${JSON.stringify(fields)}`);
      },
    });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(calls, [
      `download:${PATHS.localVideoPath}`,
      `ffmpeg:${PATHS.localVideoPath}->${PATHS.localOutputPath}`,
      `upload:${PATHS.localOutputPath}`,
      `confirm:${JSON.stringify({ storageContentType: 'video/mp4', fileSizeBytes: 12345678, sourceNormalized: true })}`,
    ]);
  });

  await check('happy path: an R2-backed Reel also gets a fresh versioned sourceUrl in the SAME confirm-write', async () => {
    const deps = makeDeps({ buildVersionedSourceUrl: () => 'https://media.example.com/reels/u1/r1/source?v=999' });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(deps._updateCalls, [
      {
        storageContentType: 'video/mp4',
        fileSizeBytes: 12345678,
        sourceNormalized: true,
        sourceUrl: 'https://media.example.com/reels/u1/r1/source?v=999',
      },
    ]);
  });

  await check('a Firebase-backed Reel never gets a sourceUrl field written at all (buildVersionedSourceUrl returning null)', async () => {
    const deps = makeDeps();
    await performReelVideoFinalization(PATHS, deps);
    assert.equal('sourceUrl' in deps._updateCalls[0], false);
  });

  // -------------------------------------------------------------------
  // Failure matrix — Part 16 of the spec.
  // -------------------------------------------------------------------

  await check('FAILURE — input download/read failure: downloadVideo returns false -> video-unavailable, no publish-eligible state ever written', async () => {
    const deps = makeDeps({ downloadVideo: async () => false });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'video-unavailable' });
    assert.equal(deps._updateCalls.length, 0);
  });

  await check('FAILURE — ffmpeg itself throws -> ffmpeg-failed, original untouched (upload/confirm never reached)', async () => {
    const uploadCalls = [];
    const deps = makeDeps({
      runFfmpegNormalize: async () => {
        throw new Error('ffmpeg exited with code 1');
      },
      uploadNormalizedVideo: async () => {
        uploadCalls.push(true);
      },
    });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-failed' });
    assert.equal(uploadCalls.length, 0);
    assert.equal(deps._updateCalls.length, 0);
  });

  await check('FAILURE — ffmpeg produces a zero-byte/empty output -> ffmpeg-empty-output, never uploaded', async () => {
    const uploadCalls = [];
    const deps = makeDeps({
      statFileSize: async () => 0,
      uploadNormalizedVideo: async () => {
        uploadCalls.push(true);
      },
    });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-empty-output' });
    assert.equal(uploadCalls.length, 0);
  });

  await check('FAILURE — a pathologically oversized output is rejected BEFORE upload — output-too-large', async () => {
    const uploadCalls = [];
    const deps = makeDeps({
      statFileSize: async () => REEL_NORMALIZED_VIDEO_MAX_SIZE_BYTES + 1,
      uploadNormalizedVideo: async () => {
        uploadCalls.push(true);
      },
    });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'output-too-large' });
    assert.equal(uploadCalls.length, 0);
  });

  await check('an output exactly AT the size guard is accepted (boundary is exclusive on the reject side)', async () => {
    const deps = makeDeps({ statFileSize: async () => REEL_NORMALIZED_VIDEO_MAX_SIZE_BYTES });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
  });

  await check('FAILURE — normalized upload/write failure -> final-upload-failed, confirm never reached, original source key never touched (uploadNormalizedVideo itself is what would overwrite it, and it threw)', async () => {
    const deps = makeDeps({
      uploadNormalizedVideo: async () => {
        throw new Error('network error');
      },
    });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'final-upload-failed' });
    assert.equal(deps._updateCalls.length, 0);
  });

  await check('FAILURE — Firestore confirm failure AFTER a successful output write -> confirm-write-failed, but the normalized bytes are ALREADY the object at the source key (retry-safe, not corrupted)', async () => {
    const uploadCalls = [];
    const deps = makeDeps({
      uploadNormalizedVideo: async (p) => {
        uploadCalls.push(p);
      },
      updateReelDocument: async () => {
        throw new Error('Firestore unavailable');
      },
    });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'confirm-write-failed' });
    // The upload DID happen — this is the documented, accepted trade-off:
    // a retry re-downloads this SAME already-normalized video and
    // re-runs ffmpeg idempotently, then retries the confirm-write.
    assert.deepEqual(uploadCalls, [PATHS.localOutputPath]);
  });

  // -------------------------------------------------------------------
  // Idempotency (retry safety) — Part 13/16: re-running this orchestration
  // against already-normalized bytes must behave deterministically, never
  // corrupt the asset, and never leave the Reel stuck. (The "skip
  // re-encoding entirely" short-circuit itself lives ONE LEVEL UP, in
  // index.ts's own finalizeReelVideo callable, checking
  // reelData.sourceNormalized === true BEFORE ever calling this function
  // at all — see that callable's own doc comment. This file only proves
  // the orchestration itself is safe to re-run if it ever is.)
  // -------------------------------------------------------------------

  await check('RETRY: re-running finalization after a confirm-write-failed retry (confirm now succeeding) is deterministic — same final fields written both times', async () => {
    let shouldFailConfirm = true;
    const confirmedFields = [];
    const deps = makeDeps({
      updateReelDocument: async (fields) => {
        if (shouldFailConfirm) throw new Error('transient Firestore error');
        confirmedFields.push(fields);
      },
    });
    const firstOutcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(firstOutcome, { ok: false, reason: 'confirm-write-failed' });
    shouldFailConfirm = false;
    const secondOutcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(secondOutcome, { ok: true });
    assert.deepEqual(confirmedFields, [{ storageContentType: 'video/mp4', fileSizeBytes: 12345678, sourceNormalized: true }]);
  });

  // -------------------------------------------------------------------
  // Step 11B — TRUE IDEMPOTENCY fix: a confirm-write failure AFTER the
  // normalized bytes already landed in storage must NOT cause a second
  // ffmpeg encode on retry. Part 10 of the spec's own explicit
  // requirement: "ffmpeg calls = 1 total across both attempts, not 2."
  // -------------------------------------------------------------------

  const CURRENT_MARKER = buildReelVideoNormalizationMetadata()[REEL_VIDEO_NORMALIZATION_METADATA_KEY];

  await check('IDEMPOTENCY: canonical source already carries the CURRENT normalization marker — ffmpeg/download/upload are skipped entirely, confirm still runs', async () => {
    const deps = makeCountingDeps({ canonicalState: { sizeBytes: 777, normalizationMarker: CURRENT_MARKER } });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(deps.counts.readCanonicalSourceState, 1);
    assert.equal(deps.counts.downloadVideo, 0, 'must never download when already normalized');
    assert.equal(deps.counts.runFfmpegNormalize, 0, 'must never re-encode an already-normalized asset');
    assert.equal(deps.counts.uploadNormalizedVideo, 0, 'must never re-upload — the canonical object is already correct');
    assert.equal(deps.counts.updateReelDocument, 1);
    assert.deepEqual(deps.updateCalls, [{ storageContentType: 'video/mp4', fileSizeBytes: 777, sourceNormalized: true }]);
  });

  await check('IDEMPOTENCY — THE KEY SCENARIO: confirm fails once AFTER a real first-time normalization, then retry detects the now-stamped marker and skips ffmpeg — exactly 1 ffmpeg call total across both attempts, not 2', async () => {
    // Simulates: attempt 1 does real work (ffmpeg runs once, upload
    // stamps the marker), confirm fails. Attempt 2 (a fresh
    // performReelVideoFinalization call, modeling a real callable retry)
    // now finds that marker via readCanonicalSourceState and must NOT
    // run ffmpeg again.
    const sharedCounts = { readCanonicalSourceState: 0, downloadVideo: 0, runFfmpegNormalize: 0, uploadNormalizedVideo: 0, updateReelDocument: 0 };
    let canonicalMarker = null;
    let confirmAttempt = 0;
    const deps = {
      readCanonicalSourceState: async () => {
        sharedCounts.readCanonicalSourceState += 1;
        return canonicalMarker ? { sizeBytes: 555, normalizationMarker: canonicalMarker } : null;
      },
      downloadVideo: async () => {
        sharedCounts.downloadVideo += 1;
        return true;
      },
      runFfmpegNormalize: async () => {
        sharedCounts.runFfmpegNormalize += 1;
      },
      statFileSize: async () => 555,
      uploadNormalizedVideo: async () => {
        sharedCounts.uploadNormalizedVideo += 1;
        // The real uploadMuxedReelSourceToProvider stamps the marker in
        // the SAME write that replaces the bytes — modeled here by
        // setting it the instant "upload" succeeds, before confirm ever
        // runs, exactly matching production ordering.
        canonicalMarker = CURRENT_MARKER;
      },
      updateReelDocument: async () => {
        sharedCounts.updateReelDocument += 1;
        confirmAttempt += 1;
        if (confirmAttempt === 1) throw new Error('transient Firestore error');
      },
      buildVersionedSourceUrl: () => null,
    };

    const firstOutcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(firstOutcome, { ok: false, reason: 'confirm-write-failed' });
    assert.equal(sharedCounts.runFfmpegNormalize, 1, 'the FIRST attempt does the real work exactly once');

    const secondOutcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(secondOutcome, { ok: true });

    assert.equal(sharedCounts.runFfmpegNormalize, 1, 'ffmpeg calls = 1 total across BOTH attempts, not 2');
    assert.equal(sharedCounts.downloadVideo, 1, 'video download = 1 total across both attempts');
    assert.equal(sharedCounts.uploadNormalizedVideo, 1, 'upload = 1 total across both attempts');
    assert.equal(sharedCounts.updateReelDocument, 2, 'confirm itself IS retried — that is the whole point');
  });

  await check('IDEMPOTENCY: marker absent entirely — normal full ffmpeg path executes, exactly as if this were the very first attempt', async () => {
    const deps = makeCountingDeps({ canonicalState: null });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(deps.counts.downloadVideo, 1);
    assert.equal(deps.counts.runFfmpegNormalize, 1);
    assert.equal(deps.counts.uploadNormalizedVideo, 1);
  });

  await check('IDEMPOTENCY: marker present but WRONG/OLD profile version — normal full ffmpeg path executes, never silently treated as current', async () => {
    const deps = makeCountingDeps({ canonicalState: { sizeBytes: 999, normalizationMarker: '0' } });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(deps.counts.runFfmpegNormalize, 1, 'an old/wrong profile version must trigger a real re-encode');
  });

  await check('IDEMPOTENCY: readCanonicalSourceState itself reports "cannot confirm" (null, e.g. a metadata-read failure) — fails safely to the FULL ffmpeg path, never incorrectly assumes normalization', async () => {
    const deps = makeCountingDeps({ canonicalState: null });
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(deps.counts.runFfmpegNormalize, 1, 'a read failure must never be mistaken for "already normalized"');
  });

  await check('IDEMPOTENCY: readCanonicalSourceState is OPTIONAL — omitting it entirely (e.g. an older test/caller) runs the full pipeline exactly as before this fix, never throws', async () => {
    const deps = makeDeps();
    delete deps.readCanonicalSourceState;
    const outcome = await performReelVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
  });

  console.log('\n=== functions/ Reel video finalization orchestration test results ===');
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
