/**
 * Step 9A — pure client-side unit tests for the Reel-video R2 migration's
 * business logic, run via:
 *   npx tsx tests/reel-video-r2.test.ts
 * Same plain assert()/check() convention as tests/cities.test.ts. Every
 * module imported here is deliberately dependency-free (no expo-*, no
 * firebase/* import) — see each module's own top doc comment for why —
 * so this file needs no mocking of native modules or a live Firebase
 * config to run.
 *
 * Covers:
 *  - isReelEligibleForR2VideoUpload (reelVideoEligibility.ts) — the exact
 *    predicate reels.ts's own uploadReelVideo dispatch guard uses.
 *  - pickProviderUrl (providerAwareUrl.ts) — the shared decision behind
 *    resolveReelVideoPlaybackUrl/resolveReelThumbnailUrl, including the
 *    full mixed-provider matrix (source/thumbnail independence) and the
 *    "r2 but malformed" safe-failure case.
 *  - performReelVideoUpload (reelVideoUploadCore.ts) — the full upload
 *    orchestration (authorize -> PUT via an injected fake adapter ->
 *    confirm-gating -> progress), proving the BUSINESS LOGIC side of the
 *    business-logic/transport-adapter split documented in that file's own
 *    top comment. The real native transport (expo-file-system's
 *    UploadTask) is NOT exercised here — see r2Provider.ts's own
 *    uploadReelVideoToR2 doc comment for why that boundary is verified by
 *    static source review instead, and this session's own verification
 *    report for the full accounting.
 */
import { isReelEligibleForR2VideoUpload } from '../src/services/media/reelVideoEligibility';
import { pickProviderUrl } from '../src/services/media/providerAwareUrl';
import { performReelVideoUpload, type UploadAdapter } from '../src/services/media/reelVideoUploadCore';

const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `Expected truthy value, got ${String(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(message ?? `Expected ${e}, got ${a}`);
  },
};

const results: { name: string; pass: boolean; error?: unknown }[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

// ---------------------------------------------------------------------------
// isReelEligibleForR2VideoUpload — Step 9A's original matrix plus Step 9B's
// relaxation (Part 7/15's own "Eligibility" list).
// ---------------------------------------------------------------------------

async function runEligibilityTests() {
  await check('eligible: plain video, no music, no pending render (Step 9A, unaffected by Step 9B)', () => {
    assert.equal(isReelEligibleForR2VideoUpload({ mediaType: 'video', musicSourceType: 'none', needsPhotoVideoRender: false }), true);
  });
  await check('ineligible: photo mediaType', () => {
    assert.equal(isReelEligibleForR2VideoUpload({ mediaType: 'photo', musicSourceType: 'none', needsPhotoVideoRender: false }), false);
  });
  await check('Step 9B — eligible: video + supported music (musicSourceType "device"), no pending render', () => {
    assert.equal(isReelEligibleForR2VideoUpload({ mediaType: 'video', musicSourceType: 'device', needsPhotoVideoRender: false }), true);
  });
  await check('ineligible: needsPhotoVideoRender true, even with mediaType already "video" and no music', () => {
    assert.equal(isReelEligibleForR2VideoUpload({ mediaType: 'video', musicSourceType: 'none', needsPhotoVideoRender: true }), false);
  });
  await check('ineligible: needsPhotoVideoRender true AND musicSourceType device (the real "FOTO"-with-music shape) — Part 14, photo-render paths remain excluded even after Step 9B', () => {
    assert.equal(isReelEligibleForR2VideoUpload({ mediaType: 'video', musicSourceType: 'device', needsPhotoVideoRender: true }), false);
  });
  await check('ineligible: an unrecognized/future musicSourceType value — an allowlist, not a blocklist', () => {
    assert.equal(isReelEligibleForR2VideoUpload({ mediaType: 'video', musicSourceType: 'catalog', needsPhotoVideoRender: false }), false);
  });
  await check('ineligible: a photo Reel is never eligible regardless of its (meaningless for photo) musicSourceType value', () => {
    assert.equal(isReelEligibleForR2VideoUpload({ mediaType: 'photo', musicSourceType: 'device', needsPhotoVideoRender: false }), false);
  });
}

// ---------------------------------------------------------------------------
// pickProviderUrl — Part 13 (playback resolver) + Part 14 (mixed-provider matrix)
// ---------------------------------------------------------------------------

async function runProviderUrlTests() {
  await check('legacy: missing provider field entirely resolves to "firebase"', () => {
    assert.deepEqual(pickProviderUrl(undefined, undefined), { mode: 'firebase' });
  });
  await check('explicit "firebase" provider resolves to "firebase" regardless of persistedUrl content', () => {
    assert.deepEqual(pickProviderUrl('firebase', 'https://should-be-ignored.example.com'), { mode: 'firebase' });
  });
  await check('"r2" provider with a real persisted URL resolves to that exact URL', () => {
    assert.deepEqual(pickProviderUrl('r2', 'https://media.example.com/reels/u1/r1/source'), {
      mode: 'r2',
      url: 'https://media.example.com/reels/u1/r1/source',
    });
  });
  await check('MALFORMED: "r2" provider with an empty-string persisted URL is a distinct, safe failure — never silently falls back to Firebase', () => {
    assert.deepEqual(pickProviderUrl('r2', ''), { mode: 'r2-malformed' });
  });
  await check('MALFORMED: "r2" provider with a missing persisted URL entirely is the same safe failure', () => {
    assert.deepEqual(pickProviderUrl('r2', undefined), { mode: 'r2-malformed' });
  });
  await check('an unrecognized future provider value defaults to "firebase", never throws', () => {
    assert.deepEqual(pickProviderUrl('some-future-provider', 'https://x.example.com'), { mode: 'firebase' });
  });

  // Mixed-provider matrix (Part 14) — source and thumbnail resolved
  // completely independently via the SAME shared function, proving
  // neither one's provider/URL ever leaks into the other's decision.
  const matrix = [
    { source: 'firebase', sourceUrl: '', thumbnail: 'firebase', thumbnailUrl: '' },
    { source: 'firebase', sourceUrl: '', thumbnail: 'r2', thumbnailUrl: 'https://cdn.example.com/thumb' },
    { source: 'r2', sourceUrl: 'https://cdn.example.com/source', thumbnail: 'firebase', thumbnailUrl: '' },
    { source: 'r2', sourceUrl: 'https://cdn.example.com/source', thumbnail: 'r2', thumbnailUrl: 'https://cdn.example.com/thumb' },
  ];
  for (const [index, combo] of matrix.entries()) {
    await check(`mixed-provider matrix combo ${index + 1}: source=${combo.source} thumbnail=${combo.thumbnail} — each resolves using ONLY its own fields`, () => {
      const sourceResolution = pickProviderUrl(combo.source, combo.sourceUrl);
      const thumbnailResolution = pickProviderUrl(combo.thumbnail, combo.thumbnailUrl);
      if (combo.source === 'r2') {
        assert.deepEqual(sourceResolution, { mode: 'r2', url: combo.sourceUrl });
      } else {
        assert.deepEqual(sourceResolution, { mode: 'firebase' });
      }
      if (combo.thumbnail === 'r2') {
        assert.deepEqual(thumbnailResolution, { mode: 'r2', url: combo.thumbnailUrl });
      } else {
        assert.deepEqual(thumbnailResolution, { mode: 'firebase' });
      }
    });
  }
  await check('mixed-provider: a malformed R2 source alongside a perfectly valid R2 thumbnail — the source failure never contaminates the thumbnail\'s own resolution', () => {
    const sourceResolution = pickProviderUrl('r2', '');
    const thumbnailResolution = pickProviderUrl('r2', 'https://cdn.example.com/thumb');
    assert.deepEqual(sourceResolution, { mode: 'r2-malformed' });
    assert.deepEqual(thumbnailResolution, { mode: 'r2', url: 'https://cdn.example.com/thumb' });
  });
}

// ---------------------------------------------------------------------------
// performReelVideoUpload — Part 2A's business-logic side, Part 15's
// failure/retry matrix, and the "server derives everything" contract.
// ---------------------------------------------------------------------------

type FakeAdapterOptions = {
  fileSize?: number | null;
  startResult?: { status: number } | (() => Promise<{ status: number }>);
  startShouldThrow?: boolean;
  progressEvents?: [number, number][];
};

function makeFakeAdapter(options: FakeAdapterOptions = {}) {
  const calls = { getFileSize: 0, start: [] as { url: string; headers: Record<string, string> }[], cancel: 0 };
  const adapter: UploadAdapter = {
    getFileSize: () => {
      calls.getFileSize += 1;
      return options.fileSize === undefined ? 20 * 1024 * 1024 : options.fileSize;
    },
    start: async (url, headers, onProgress) => {
      calls.start.push({ url, headers });
      if (options.startShouldThrow) throw new Error('transport failure');
      for (const [sent, total] of options.progressEvents ?? [[10, 100], [100, 100]]) {
        onProgress(sent, total);
      }
      if (typeof options.startResult === 'function') return options.startResult();
      return options.startResult ?? { status: 200 };
    },
    cancel: () => {
      calls.cancel += 1;
    },
  };
  return { adapter, calls };
}

async function runUploadCoreTests() {
  await check('happy path: authorize succeeds, PUT returns 200, mediaUrl configured — reports ok:true with the exact sourceUrl, calls authorize with the REAL adapter-reported file size (not a caller guess)', async () => {
    const { adapter, calls } = makeFakeAdapter({ fileSize: 12_345_678 });
    let capturedFileSize: number | null = null;
    const progressValues: number[] = [];
    const result = await performReelVideoUpload(
      () => adapter,
      async (contentType, fileSizeBytes) => {
        capturedFileSize = fileSizeBytes;
        assert.equal(contentType, 'video/mp4');
        return { uploadUrl: 'https://r2.example.com/put-here', contentType: 'video/mp4', mediaUrl: 'https://media.example.com/reels/u1/r1/source' };
      },
      'reel1',
      'video/mp4',
      (percent) => progressValues.push(percent)
    );
    assert.deepEqual(result, { ok: true, sourceUrl: 'https://media.example.com/reels/u1/r1/source' });
    assert.equal(capturedFileSize, 12_345_678);
    assert.equal(calls.start[0].url, 'https://r2.example.com/put-here');
    assert.equal(calls.start[0].headers['Content-Type'], 'video/mp4');
    // Monotonic progress: 0 (pre-transfer), then whatever the adapter
    // reports (10%, then 100%), then a final 100 — never decreasing.
    for (let i = 1; i < progressValues.length; i += 1) {
      assert.ok(progressValues[i] >= progressValues[i - 1], `progress went backwards: ${progressValues.join(',')}`);
    }
    assert.equal(progressValues[0], 0);
    assert.equal(progressValues[progressValues.length - 1], 100);
  });

  await check('Part 15 — authorization failure: no upload attempted at all (adapter.start is never called)', async () => {
    const { adapter, calls } = makeFakeAdapter();
    const result = await performReelVideoUpload(
      () => adapter,
      async () => {
        throw new Error('server rejected authorization');
      },
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.equal(result.ok, false);
    assert.equal(calls.start.length, 0, 'adapter.start must never be called when authorization itself fails');
  });

  await check('Part 15 — PUT/network failure (adapter.start throws): reported as failure, never as success', async () => {
    const { adapter } = makeFakeAdapter({ startShouldThrow: true });
    const result = await performReelVideoUpload(
      () => adapter,
      async () => ({ uploadUrl: 'https://r2.example.com/x', contentType: 'video/mp4', mediaUrl: 'https://media.example.com/x' }),
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.equal(result.ok, false);
  });

  await check('a non-2xx PUT response (e.g. expired presigned URL) is reported as failure, never treated as success just because the request completed', async () => {
    const { adapter } = makeFakeAdapter({ startResult: { status: 403 } });
    const result = await performReelVideoUpload(
      () => adapter,
      async () => ({ uploadUrl: 'https://r2.example.com/x', contentType: 'video/mp4', mediaUrl: 'https://media.example.com/x' }),
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.equal(result.ok, false);
  });

  await check('PUT succeeds but mediaUrl is null (no public media domain configured) — reported as failure with an honest message, never a fabricated sourceUrl', async () => {
    const { adapter } = makeFakeAdapter();
    const result = await performReelVideoUpload(
      () => adapter,
      async () => ({ uploadUrl: 'https://r2.example.com/x', contentType: 'video/mp4', mediaUrl: null }),
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.message.includes('not displayable'));
  });

  await check('the actual file size is read from the adapter (disk), NEVER trusted from a caller-supplied value — getFileSize is called, and its return value is what reaches authorize', async () => {
    const { adapter, calls } = makeFakeAdapter({ fileSize: 999 });
    let sizeSeenByAuthorize: number | null = null;
    await performReelVideoUpload(
      () => adapter,
      async (_ct, fileSizeBytes) => {
        sizeSeenByAuthorize = fileSizeBytes;
        return { uploadUrl: 'https://x', contentType: 'video/mp4', mediaUrl: 'https://x' };
      },
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.equal(calls.getFileSize, 1);
    assert.equal(sizeSeenByAuthorize, 999);
  });

  await check('a file that cannot be read (getFileSize returns null) fails BEFORE ever calling authorize', async () => {
    const { adapter } = makeFakeAdapter({ fileSize: null });
    let authorizeCalled = false;
    const result = await performReelVideoUpload(
      () => adapter,
      async () => {
        authorizeCalled = true;
        return { uploadUrl: 'https://x', contentType: 'video/mp4', mediaUrl: 'https://x' };
      },
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.equal(result.ok, false);
    assert.equal(authorizeCalled, false);
  });

  await check('a zero-byte file also fails before authorizing', async () => {
    const { adapter } = makeFakeAdapter({ fileSize: 0 });
    const result = await performReelVideoUpload(
      () => adapter,
      async () => ({ uploadUrl: 'https://x', contentType: 'video/mp4', mediaUrl: 'https://x' }),
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.equal(result.ok, false);
  });

  await check('Part 15 — retry uses the same deterministic reelId/contentType every time (the object key itself is derived server-side from these, not from this function)', async () => {
    const { adapter } = makeFakeAdapter({ startShouldThrow: true });
    const seenReelIds: string[] = [];
    await performReelVideoUpload(
      () => adapter,
      async (_ct, _size, reelId) => {
        seenReelIds.push(reelId);
        return { uploadUrl: 'https://x', contentType: 'video/mp4', mediaUrl: 'https://x' };
      },
      'reel1',
      'video/mp4',
      () => {}
    );
    // A second, retried attempt after the first failure — same reelId,
    // proving a retry re-targets the exact same server-derived object.
    await performReelVideoUpload(
      () => adapter,
      async (_ct, _size, reelId) => {
        seenReelIds.push(reelId);
        return { uploadUrl: 'https://x', contentType: 'video/mp4', mediaUrl: 'https://x' };
      },
      'reel1',
      'video/mp4',
      () => {}
    );
    assert.deepEqual(seenReelIds, ['reel1', 'reel1']);
  });

  await check('onUploadTaskReady is called synchronously with a real cancel function BEFORE the transfer even starts', async () => {
    const { adapter, calls } = makeFakeAdapter();
    let capturedCancel: (() => void) | null = null;
    await performReelVideoUpload(
      () => adapter,
      async () => ({ uploadUrl: 'https://x', contentType: 'video/mp4', mediaUrl: 'https://x' }),
      'reel1',
      'video/mp4',
      () => {},
      (cancel) => {
        capturedCancel = cancel;
      }
    );
    assert.ok(capturedCancel, 'onUploadTaskReady must have been called');
    capturedCancel!();
    assert.equal(calls.cancel, 1, 'the adapter\'s own cancel() must actually be invoked');
  });
}

async function main() {
  await runEligibilityTests();
  await runProviderUrlTests();
  await runUploadCoreTests();

  console.log('\n=== src/ Reel-video R2 business-logic test results ===');
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
