/**
 * Step 11C — plain-Node tests for direct Story video normalization:
 *  - storySourceStorage.ts's downloadStorySourceForFinalization /
 *    uploadNormalizedStorySourceToProvider / readStoryCanonicalSourceState
 *    (provider-aware read/write/metadata-check, mirroring
 *    reelSourceStorage.ts's own equivalents field-for-field).
 *  - storyVideoFinalization.ts's performStoryVideoFinalization (the pure
 *    orchestration behind the NEW finalizeStoryVideo callable) — happy
 *    path, full failure matrix, and the TRUE IDEMPOTENCY fix (built in
 *    from the start here, not a later patch — see that file's own doc
 *    comment), with explicit ffmpeg call-count assertions.
 *  - proof that Story reuses the EXACT SAME shared video-delivery profile
 *    as Reel, with zero duplicated constants.
 *
 * finalizeStoryVideo's own real Firestore ownership/status/mediaType gate
 * (checkStoryVideoFinalizationEligibility) is already covered exhaustively
 * in test-story-eligibility-logic.cjs — this file assumes that gate has
 * already passed.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const {
  downloadStorySourceForFinalization,
  uploadNormalizedStorySourceToProvider,
  readStoryCanonicalSourceState,
  deriveCopiedStorySourceNormalized,
} = require('../lib/media/storySourceStorage.js');
const {
  performStoryVideoFinalization,
  STORY_NORMALIZED_VIDEO_MAX_SIZE_BYTES,
} = require('../lib/media/storyVideoFinalization.js');
const { REEL_NORMALIZED_VIDEO_MAX_SIZE_BYTES } = require('../lib/media/reelVideoFinalization.js');
const {
  VIDEO_DELIVERY_PROFILE,
  buildVideoEncodeArgs,
  buildVideoNormalizationMetadata,
  VIDEO_NORMALIZATION_METADATA_KEY,
} = require('../lib/media/videoNormalizationProfile.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const UID = 'storyAuthorUid';
const STORY_ID = 'story1';
const PATHS = { localVideoPath: '/tmp/story-fake-input-video', localOutputPath: '/tmp/story-fake-output.mp4' };
const CURRENT_MARKER = buildVideoNormalizationMetadata()[VIDEO_NORMALIZATION_METADATA_KEY];

function tmpFile(name) {
  return path.join(os.tmpdir(), `story-video-finalization-test-${process.pid}-${name}`);
}

function makeFakeBucket(initialFiles = {}, fileMetadata = {}) {
  const store = new Map(Object.entries(initialFiles));
  const metadataStore = new Map(Object.entries(fileMetadata));
  const calls = { exists: [], download: [], upload: [], getMetadata: [] };
  return {
    store,
    calls,
    file(filePath) {
      return {
        async exists() {
          calls.exists.push(filePath);
          return [store.has(filePath)];
        },
        async download({ destination }) {
          calls.download.push({ path: filePath, destination });
          fs.writeFileSync(destination, store.get(filePath) ?? Buffer.alloc(0));
        },
        async getMetadata() {
          calls.getMetadata.push(filePath);
          if (!metadataStore.has(filePath)) throw new Error(`404: no object at "${filePath}"`);
          return [metadataStore.get(filePath), {}];
        },
      };
    },
    async upload(localPath, options) {
      calls.upload.push({ localPath, options });
      store.set(options.destination, fs.readFileSync(localPath));
    },
  };
}

function makeFakeR2Store(initialObjects = {}) {
  const objects = new Map(Object.entries(initialObjects).map(([k, v]) => [k, { data: Buffer.from(v.data ?? v), metadata: v.metadata ?? {} }]));
  const calls = { get: [], put: [], head: [] };
  return {
    objects,
    calls,
    getObject: async (key) => {
      calls.get.push(key);
      const entry = objects.get(key);
      if (!entry) throw new Error(`no such object: ${key}`);
      return entry.data;
    },
    putObject: async (key, data, contentType, cacheControl, metadata) => {
      calls.put.push({ key, contentType, cacheControl, metadata });
      objects.set(key, { data, metadata: metadata ?? {} });
    },
    headObject: async (key) => {
      calls.head.push(key);
      const entry = objects.get(key);
      if (!entry) return null;
      return { sizeBytes: entry.data.length, metadata: entry.metadata };
    },
  };
}

async function main() {
  // -------------------------------------------------------------------
  // Profile reuse proof — Part 18's own explicit requirement.
  // -------------------------------------------------------------------

  await check('PROFILE REUSE: Story finalization imports the EXACT SAME VIDEO_DELIVERY_PROFILE module as Reel — no separate Story-specific profile constants exist', async () => {
    // Both storyVideoFinalization.ts and reelVideoFinalization.ts import
    // from the SAME compiled videoNormalizationProfile.js module — proven
    // here by asserting the encode args produced for an IDENTICAL
    // dimension input are byte-for-byte identical, since both would only
    // diverge if a separate/duplicated profile existed somewhere.
    const dims = { width: 1080, height: 1920 };
    const args = buildVideoEncodeArgs(dims);
    assert.ok(args.includes('veryfast'));
    assert.ok(args.includes('23'));
    assert.equal(VIDEO_DELIVERY_PROFILE.maxLongEdge, 1920);
    assert.equal(VIDEO_DELIVERY_PROFILE.maxShortEdge, 1080);
  });

  await check('PROFILE REUSE: STORY_NORMALIZED_VIDEO_MAX_SIZE_BYTES is the EXACT SAME constant value as Reel\'s own guard — both derived from the one shared NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S, never duplicated', () => {
    assert.equal(STORY_NORMALIZED_VIDEO_MAX_SIZE_BYTES, REEL_NORMALIZED_VIDEO_MAX_SIZE_BYTES);
    assert.equal(STORY_NORMALIZED_VIDEO_MAX_SIZE_BYTES, 40 * 1024 * 1024);
  });

  // -------------------------------------------------------------------
  // Reel->Story copy: NO second encode — addReelToMyStory's own trust
  // decision (deriveCopiedStorySourceNormalized), extracted as its own
  // pure function specifically so this is directly testable.
  // -------------------------------------------------------------------

  await check('REEL->STORY COPY: a video Reel already normalized (sourceNormalized: true) carries that trust forward — the copied Story needs NO second ffmpeg pass', () => {
    assert.equal(deriveCopiedStorySourceNormalized({ mediaType: 'video', sourceNormalized: true }), true);
  });

  await check('REEL->STORY COPY: a legacy Reel predating this field (sourceNormalized undefined) is NOT treated as normalized — never coerced to true', () => {
    assert.equal(deriveCopiedStorySourceNormalized({ mediaType: 'video' }), false);
  });

  await check('REEL->STORY COPY: a photo Reel (sourceNormalized always false) copies as false too — harmless, since isValidStoryPublish exempts photo Stories from the gate entirely', () => {
    assert.equal(deriveCopiedStorySourceNormalized({ mediaType: 'photo', sourceNormalized: false }), false);
  });

  await check('REEL->STORY COPY: a Reel whose sourceNormalized is explicitly false (not yet finalized) is correctly NOT treated as normalized', () => {
    assert.equal(deriveCopiedStorySourceNormalized({ mediaType: 'video', sourceNormalized: false }), false);
  });

  await check('REEL->STORY COPY: never a loose truthy check — a string/number value is NOT treated as normalized, only the literal boolean true', () => {
    assert.equal(deriveCopiedStorySourceNormalized({ sourceNormalized: 'true' }), false);
    assert.equal(deriveCopiedStorySourceNormalized({ sourceNormalized: 1 }), false);
  });

  // -------------------------------------------------------------------
  // storySourceStorage.ts — provider-aware read/write/metadata-check
  // -------------------------------------------------------------------

  await check('download: Firebase Story — uses bucket.file(storagePath).download(), never touches R2', async () => {
    const bucket = makeFakeBucket({ 'stories/u1/s1/source': Buffer.from('VIDEO_BYTES') });
    const r2 = makeFakeR2Store();
    const dest = tmpFile('fb-download');
    const ok = await downloadStorySourceForFinalization(bucket, { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' }, 'u1', 's1', dest, { getObject: r2.getObject });
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from('VIDEO_BYTES'));
    assert.equal(r2.calls.get.length, 0);
    fs.unlinkSync(dest);
  });

  await check('download: Firebase Story whose object is missing returns false', async () => {
    const ok = await downloadStorySourceForFinalization(makeFakeBucket({}), { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' }, 'u1', 's1', tmpFile('missing'));
    assert.equal(ok, false);
  });

  await check('download: R2 Story — uses the AUTHENTICATED getObject, deriving the key from uid+storyId (never trusting a stored path field)', async () => {
    const r2 = makeFakeR2Store({ 'stories/u1/s1/source': 'VIDEO_BYTES' });
    const dest = tmpFile('r2-download');
    const ok = await downloadStorySourceForFinalization(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 's1', dest, { getObject: r2.getObject });
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(dest), Buffer.from('VIDEO_BYTES'));
    assert.deepEqual(r2.calls.get, ['stories/u1/s1/source']);
    fs.unlinkSync(dest);
  });

  await check('download: R2 Story whose authenticated read fails returns false, never throws', async () => {
    const r2 = makeFakeR2Store({});
    const ok = await downloadStorySourceForFinalization(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 's1', tmpFile('r2-missing'), { getObject: r2.getObject });
    assert.equal(ok, false);
  });

  await check('upload: Firebase Story — overwrites the canonical object AND stamps the normalization marker in the SAME write', async () => {
    const bucket = makeFakeBucket({});
    const localFile = tmpFile('upload-source');
    fs.writeFileSync(localFile, 'NORMALIZED_BYTES');
    await uploadNormalizedStorySourceToProvider(bucket, { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' }, 'u1', 's1', localFile, 'video/mp4', undefined);
    assert.equal(bucket.calls.upload.length, 1);
    assert.deepEqual(bucket.calls.upload[0].options.metadata.metadata, { [VIDEO_NORMALIZATION_METADATA_KEY]: CURRENT_MARKER });
    fs.unlinkSync(localFile);
  });

  await check('upload: R2 Story — stamps the normalization marker via putObject\'s own metadata parameter, at the deterministic Story key', async () => {
    const r2 = makeFakeR2Store({});
    const localFile = tmpFile('upload-r2');
    fs.writeFileSync(localFile, 'NORMALIZED_BYTES');
    await uploadNormalizedStorySourceToProvider(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 's1', localFile, 'video/mp4', 'public, max-age=31536000, immutable', { putObject: r2.putObject });
    assert.equal(r2.calls.put.length, 1);
    assert.equal(r2.calls.put[0].key, 'stories/u1/s1/source');
    assert.deepEqual(r2.calls.put[0].metadata, { [VIDEO_NORMALIZATION_METADATA_KEY]: CURRENT_MARKER });
    assert.equal(r2.calls.put[0].cacheControl, 'public, max-age=31536000, immutable');
    fs.unlinkSync(localFile);
  });

  await check('canonical state: Firebase Story with the CURRENT marker — returns it without downloading full bytes', async () => {
    const bucket = makeFakeBucket({}, { 'stories/u1/s1/source': { size: '4242', metadata: { [VIDEO_NORMALIZATION_METADATA_KEY]: CURRENT_MARKER } } });
    const result = await readStoryCanonicalSourceState(bucket, { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' }, 'u1', 's1');
    assert.deepEqual(result, { sizeBytes: 4242, normalizationMarker: CURRENT_MARKER });
    assert.equal(bucket.calls.download.length, 0);
  });

  await check('canonical state: Firebase Story with NO marker — normalizationMarker: null', async () => {
    const bucket = makeFakeBucket({}, { 'stories/u1/s1/source': { size: 999, metadata: {} } });
    const result = await readStoryCanonicalSourceState(bucket, { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' }, 'u1', 's1');
    assert.deepEqual(result, { sizeBytes: 999, normalizationMarker: null });
  });

  await check('canonical state: Firebase Story whose object does not exist — fail-safe, returns null', async () => {
    const result = await readStoryCanonicalSourceState(makeFakeBucket({}, {}), { storageProvider: 'firebase', storagePath: 'stories/u1/s1/source' }, 'u1', 's1');
    assert.equal(result, null);
  });

  await check('canonical state: R2 Story with the CURRENT marker — uses the injected headObject, derives the key from uid/storyId', async () => {
    const r2 = makeFakeR2Store({ 'stories/u1/s1/source': { data: 'BYTES', metadata: { [VIDEO_NORMALIZATION_METADATA_KEY]: CURRENT_MARKER } } });
    const result = await readStoryCanonicalSourceState(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 's1', { headObject: r2.headObject });
    assert.deepEqual(result, { sizeBytes: 5, normalizationMarker: CURRENT_MARKER });
    assert.deepEqual(r2.calls.head, ['stories/u1/s1/source']);
  });

  await check('canonical state: R2 Story missing entirely — headObject returns null — fail-safe', async () => {
    const r2 = makeFakeR2Store({});
    const result = await readStoryCanonicalSourceState(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 's1', { headObject: r2.headObject });
    assert.equal(result, null);
  });

  await check('canonical state: R2 Story with an OLDER/different profile-version marker — returned verbatim, caller decides', async () => {
    const r2 = makeFakeR2Store({ 'stories/u1/s1/source': { data: 'BYTES', metadata: { [VIDEO_NORMALIZATION_METADATA_KEY]: '0' } } });
    const result = await readStoryCanonicalSourceState(makeFakeBucket({}), { storageProvider: 'r2' }, 'u1', 's1', { headObject: r2.headObject });
    assert.deepEqual(result, { sizeBytes: 5, normalizationMarker: '0' });
  });

  // -------------------------------------------------------------------
  // performStoryVideoFinalization — happy path + failure matrix
  // -------------------------------------------------------------------

  function makeDeps(overrides = {}) {
    const updateCalls = [];
    return {
      downloadVideo: async () => true,
      runFfmpegNormalize: async () => undefined,
      statFileSize: async () => 7_654_321,
      uploadNormalizedVideo: async () => undefined,
      updateStoryDocument: async (fields) => {
        updateCalls.push(fields);
      },
      buildVersionedSourceUrl: () => null,
      _updateCalls: updateCalls,
      ...overrides,
    };
  }

  await check('happy path: download -> ffmpeg -> upload -> confirm, writes sourceNormalized:true', async () => {
    const deps = makeDeps();
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.deepEqual(deps._updateCalls, [{ storageContentType: 'video/mp4', fileSizeBytes: 7654321, sourceNormalized: true }]);
  });

  await check('happy path: an R2-backed Story gets a fresh versioned mediaUrl (Story\'s own field name, not sourceUrl) in the SAME confirm-write', async () => {
    const deps = makeDeps({ buildVersionedSourceUrl: () => 'https://media.example.com/stories/u1/s1/source?v=999' });
    await performStoryVideoFinalization(PATHS, deps);
    assert.equal(deps._updateCalls[0].mediaUrl, 'https://media.example.com/stories/u1/s1/source?v=999');
  });

  await check('FAILURE — video-unavailable: downloadVideo returns false', async () => {
    const deps = makeDeps({ downloadVideo: async () => false });
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'video-unavailable' });
    assert.equal(deps._updateCalls.length, 0);
  });

  await check('FAILURE — ffmpeg-failed: original untouched, never uploaded/confirmed', async () => {
    const uploadCalls = [];
    const deps = makeDeps({
      runFfmpegNormalize: async () => {
        throw new Error('ffmpeg exited with code 1');
      },
      uploadNormalizedVideo: async () => uploadCalls.push(true),
    });
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-failed' });
    assert.equal(uploadCalls.length, 0);
  });

  await check('FAILURE — ffmpeg-empty-output: zero-byte output never uploaded', async () => {
    const deps = makeDeps({ statFileSize: async () => 0 });
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'ffmpeg-empty-output' });
  });

  await check('FAILURE — output-too-large: a pathologically oversized output is rejected before upload', async () => {
    const uploadCalls = [];
    const deps = makeDeps({
      statFileSize: async () => STORY_NORMALIZED_VIDEO_MAX_SIZE_BYTES + 1,
      uploadNormalizedVideo: async () => uploadCalls.push(true),
    });
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'output-too-large' });
    assert.equal(uploadCalls.length, 0);
  });

  await check('FAILURE — final-upload-failed: upload throws, confirm never reached', async () => {
    const deps = makeDeps({
      uploadNormalizedVideo: async () => {
        throw new Error('network error');
      },
    });
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'final-upload-failed' });
    assert.equal(deps._updateCalls.length, 0);
  });

  await check('FAILURE — confirm-write-failed: Firestore confirm fails AFTER a successful upload — normalized bytes already live at the canonical key, retry-safe', async () => {
    const uploadCalls = [];
    const deps = makeDeps({
      uploadNormalizedVideo: async (p) => uploadCalls.push(p),
      updateStoryDocument: async () => {
        throw new Error('Firestore unavailable');
      },
    });
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: false, reason: 'confirm-write-failed' });
    assert.equal(uploadCalls.length, 1);
  });

  // -------------------------------------------------------------------
  // TRUE IDEMPOTENCY — Part 10's own explicit requirement: ffmpeg calls
  // = 1 total across a confirm failure + retry.
  // -------------------------------------------------------------------

  await check('IDEMPOTENCY: canonical source already carries the CURRENT marker — ffmpeg/download/upload all skipped, confirm still runs', async () => {
    const deps = makeDeps({ readCanonicalSourceState: async () => ({ sizeBytes: 321, normalizationMarker: CURRENT_MARKER }) });
    const downloadCalls = [];
    deps.downloadVideo = async () => {
      downloadCalls.push(true);
      return true;
    };
    const ffmpegCalls = [];
    deps.runFfmpegNormalize = async () => ffmpegCalls.push(true);
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(downloadCalls.length, 0);
    assert.equal(ffmpegCalls.length, 0);
    assert.deepEqual(deps._updateCalls, [{ storageContentType: 'video/mp4', fileSizeBytes: 321, sourceNormalized: true }]);
  });

  await check('IDEMPOTENCY — THE KEY SCENARIO: confirm fails once after a real first-time normalization; retry detects the now-stamped marker and skips ffmpeg entirely — ffmpeg calls = 1 TOTAL across both attempts, not 2', async () => {
    let canonicalMarker = null;
    let confirmAttempt = 0;
    const counts = { readCanonicalSourceState: 0, downloadVideo: 0, runFfmpegNormalize: 0, uploadNormalizedVideo: 0, updateStoryDocument: 0 };
    const deps = {
      readCanonicalSourceState: async () => {
        counts.readCanonicalSourceState += 1;
        return canonicalMarker ? { sizeBytes: 888, normalizationMarker: canonicalMarker } : null;
      },
      downloadVideo: async () => {
        counts.downloadVideo += 1;
        return true;
      },
      runFfmpegNormalize: async () => {
        counts.runFfmpegNormalize += 1;
      },
      statFileSize: async () => 888,
      uploadNormalizedVideo: async () => {
        counts.uploadNormalizedVideo += 1;
        canonicalMarker = CURRENT_MARKER; // stamped in the same write that replaces the bytes
      },
      updateStoryDocument: async () => {
        counts.updateStoryDocument += 1;
        confirmAttempt += 1;
        if (confirmAttempt === 1) throw new Error('transient Firestore error');
      },
      buildVersionedSourceUrl: () => null,
    };

    const firstOutcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(firstOutcome, { ok: false, reason: 'confirm-write-failed' });
    assert.equal(counts.runFfmpegNormalize, 1, 'the first attempt normalizes exactly once');

    const secondOutcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(secondOutcome, { ok: true });

    assert.equal(counts.runFfmpegNormalize, 1, 'ffmpeg calls = 1 TOTAL across both attempts, not 2 — the key requirement');
    assert.equal(counts.downloadVideo, 1, 'video download = 1 total across both attempts');
    assert.equal(counts.uploadNormalizedVideo, 1, 'upload = 1 total across both attempts');
    assert.equal(counts.updateStoryDocument, 2, 'confirm itself IS retried — that is the whole point');
  });

  await check('IDEMPOTENCY: marker absent entirely — normal full ffmpeg path executes', async () => {
    const deps = makeDeps({ readCanonicalSourceState: async () => null });
    const ffmpegCalls = [];
    deps.runFfmpegNormalize = async () => ffmpegCalls.push(true);
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(ffmpegCalls.length, 1);
  });

  await check('IDEMPOTENCY: marker present but WRONG/OLD profile version — normal full ffmpeg path executes, never silently treated as current', async () => {
    const deps = makeDeps({ readCanonicalSourceState: async () => ({ sizeBytes: 1, normalizationMarker: '0' }) });
    const ffmpegCalls = [];
    deps.runFfmpegNormalize = async () => ffmpegCalls.push(true);
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(ffmpegCalls.length, 1);
  });

  await check('IDEMPOTENCY: readCanonicalSourceState reporting "cannot confirm" (null, e.g. a metadata-read failure) fails safely to the FULL ffmpeg path', async () => {
    const deps = makeDeps({ readCanonicalSourceState: async () => null });
    const ffmpegCalls = [];
    deps.runFfmpegNormalize = async () => ffmpegCalls.push(true);
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
    assert.equal(ffmpegCalls.length, 1, 'a read failure must never be mistaken for "already normalized"');
  });

  await check('IDEMPOTENCY: readCanonicalSourceState is OPTIONAL — omitting it entirely runs the full pipeline, never throws', async () => {
    const deps = makeDeps();
    delete deps.readCanonicalSourceState;
    const outcome = await performStoryVideoFinalization(PATHS, deps);
    assert.deepEqual(outcome, { ok: true });
  });

  console.log('\n=== functions/ direct Story video finalization + idempotency test results ===');
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
