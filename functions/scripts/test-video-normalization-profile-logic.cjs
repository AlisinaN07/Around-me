/**
 * Step 11B — plain-Node tests for the pure, shared Reel video delivery
 * profile in functions/src/media/videoNormalizationProfile.ts:
 * computeVideoOutputDimensions, buildVideoScaleFilter, and
 * buildVideoEncodeArgs. These are the ONE place every finalization
 * pipeline (plain-video finalize, video+music mux, photo+music render)
 * draws its resolution/fps/codec/bitrate/faststart settings from — see
 * that file's own doc comment for why this is a profile module rather
 * than one giant shared orchestration function.
 *
 * Runs against the COMPILED lib/ output — `npm run build` first.
 */
const assert = require('node:assert/strict');
const {
  VIDEO_DELIVERY_PROFILE,
  VIDEO_NORMALIZATION_PROFILE_VERSION,
  VIDEO_NORMALIZATION_METADATA_KEY,
  computeVideoOutputDimensions,
  buildVideoScaleFilter,
  buildVideoEncodeArgs,
  buildVideoNormalizationMetadata,
  isVideoSourceAlreadyNormalized,
} = require('../lib/media/videoNormalizationProfile.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function isEven(n) {
  return n % 2 === 0;
}

// ---------------------------------------------------------------------------
// computeVideoOutputDimensions — Part 20's own "profile" test list.
// ---------------------------------------------------------------------------

check('portrait 4K (2160x3840) is bounded to <=1080x1920, aspect ratio preserved exactly', () => {
  const result = computeVideoOutputDimensions(2160, 3840);
  assert.ok(result.width <= 1080 && result.height <= 1920, `expected within 1080x1920, got ${result.width}x${result.height}`);
  // 2160:3840 reduces to exactly 1:1.777... (16:9 portrait) — the output
  // must preserve that same ratio, not independently clamp each axis.
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1920);
});

check('landscape 4K (3840x2160) is bounded to a <=1920x1080-equivalent box, not squeezed into a portrait box', () => {
  const result = computeVideoOutputDimensions(3840, 2160);
  assert.ok(result.width <= 1920 && result.height <= 1080, `expected within 1920x1080, got ${result.width}x${result.height}`);
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
});

check('square source (2000x2000) is bounded to <=1080x1080', () => {
  const result = computeVideoOutputDimensions(2000, 2000);
  assert.equal(result.width, 1080);
  assert.equal(result.height, 1080);
});

check('a low-resolution input (480x854, well under the box) is NEVER upscaled — returned at its own original size', () => {
  const result = computeVideoOutputDimensions(480, 854);
  assert.equal(result.width, 480);
  assert.equal(result.height, 854);
});

check('a low-resolution landscape input (640x360) is never upscaled either', () => {
  const result = computeVideoOutputDimensions(640, 360);
  assert.equal(result.width, 640);
  assert.equal(result.height, 360);
});

check('odd source dimensions (1081x1921, just over the box) become safe/even AND still fit the box', () => {
  const result = computeVideoOutputDimensions(1081, 1921);
  assert.ok(isEven(result.width), `width ${result.width} must be even`);
  assert.ok(isEven(result.height), `height ${result.height} must be even`);
  assert.ok(result.width <= 1080 && result.height <= 1920);
});

check('odd source dimensions already WITHIN the box (e.g. 719x1279) still come out even — never upscaled past the odd original, never left odd', () => {
  const result = computeVideoOutputDimensions(719, 1279);
  assert.ok(isEven(result.width));
  assert.ok(isEven(result.height));
  // Never upscaled: the even-corrected result must not exceed the
  // original on either axis.
  assert.ok(result.width <= 719);
  assert.ok(result.height <= 1279);
});

check('a source exactly at the box boundary (1080x1920) is returned unchanged (already even, already in bounds)', () => {
  const result = computeVideoOutputDimensions(1080, 1920);
  assert.deepEqual(result, { width: 1080, height: 1920 });
});

check('a source exactly at the landscape box boundary (1920x1080) is returned unchanged', () => {
  const result = computeVideoOutputDimensions(1920, 1080);
  assert.deepEqual(result, { width: 1920, height: 1080 });
});

check('a non-standard aspect ratio (e.g. 9:21 ultra-tall) still preserves its own ratio within the box, not forced to 9:16', () => {
  const result = computeVideoOutputDimensions(900, 2100); // 3:7
  assert.ok(result.width <= 1080 && result.height <= 1920);
  // scale = min(1, 1080/900, 1920/2100) = min(1, 1.2, 0.914...) = 0.914...
  // width ≈ 822.8 -> even-floored 822; height ≈ 1920 (clamped by maxLongEdge) -> even already
  assert.ok(Math.abs(result.width / result.height - 900 / 2100) < 0.01, 'aspect ratio must be preserved within even-rounding tolerance');
});

check('throws on a non-positive width or height — never silently produces a nonsensical 0x0/negative result', () => {
  assert.throws(() => computeVideoOutputDimensions(0, 1920));
  assert.throws(() => computeVideoOutputDimensions(1080, 0));
  assert.throws(() => computeVideoOutputDimensions(-100, 1920));
});

// ---------------------------------------------------------------------------
// Frame rate — Part 4/20's own test list. The actual ffmpeg `-fpsmax`
// BEHAVIOR (does it really cap without raising) was independently
// verified live against the installed ffmpeg-static 6.1.1 binary during
// this step's own audit (a 60fps synthetic source came out at exactly
// 30fps; a 24fps one came out completely unchanged) — see
// videoNormalizationProfile.ts's own doc comment. What's tested here is the
// DECISION this codebase makes: which flag, and which value, every
// finalization pipeline actually passes.
// ---------------------------------------------------------------------------

check('VIDEO_DELIVERY_PROFILE.fpsMax is 30', () => {
  assert.equal(VIDEO_DELIVERY_PROFILE.fpsMax, 30);
});

check('buildVideoEncodeArgs always emits "-fpsmax 30", never a plain "-r" (which would force a LOWER source fps upward)', () => {
  const args = buildVideoEncodeArgs({ width: 1080, height: 1920 });
  const fpsmaxIndex = args.indexOf('-fpsmax');
  assert.ok(fpsmaxIndex >= 0, 'expected -fpsmax in the output args');
  assert.equal(args[fpsmaxIndex + 1], '30');
  assert.equal(args.includes('-r'), false, 'must never use a plain -r, which forces fps upward for a lower-fps source');
});

// ---------------------------------------------------------------------------
// buildVideoScaleFilter / buildVideoEncodeArgs — exact ffmpeg arg
// shape every finalization pipeline shares.
// ---------------------------------------------------------------------------

check('buildVideoScaleFilter produces a plain "scale=W:H" string from already-computed dimensions', () => {
  assert.equal(buildVideoScaleFilter({ width: 1080, height: 1920 }), 'scale=1080:1920');
});

check('buildVideoEncodeArgs includes the exact shared profile: libx264, veryfast, crf 23, maxrate/bufsize, yuv420p, aac 128k, faststart', () => {
  const args = buildVideoEncodeArgs({ width: 720, height: 1280 });
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  const asMap = new Map(pairs);
  assert.equal(asMap.get('-vf'), 'scale=720:1280');
  assert.equal(asMap.get('-c:v'), 'libx264');
  assert.equal(asMap.get('-preset'), 'veryfast');
  assert.equal(asMap.get('-crf'), '23');
  assert.equal(asMap.get('-maxrate'), '5000k');
  assert.equal(asMap.get('-bufsize'), '10000k');
  assert.equal(asMap.get('-pix_fmt'), 'yuv420p');
  assert.equal(asMap.get('-c:a'), 'aac');
  assert.equal(asMap.get('-b:a'), '128k');
  assert.equal(asMap.get('-movflags'), '+faststart');
});

check('buildVideoEncodeArgs is a pure function of its dimensions argument — same input, same output, every call', () => {
  const a = buildVideoEncodeArgs({ width: 1080, height: 1920 });
  const b = buildVideoEncodeArgs({ width: 1080, height: 1920 });
  assert.deepEqual(a, b);
});

check('VIDEO_DELIVERY_PROFILE values match the spec\'s own documented ranges exactly: CRF 23, maxrate in 4-6 Mbps, bufsize in 8-12 Mbps, audio 128-160k', () => {
  assert.equal(VIDEO_DELIVERY_PROFILE.crf, 23);
  assert.ok(VIDEO_DELIVERY_PROFILE.maxrateKbps >= 4000 && VIDEO_DELIVERY_PROFILE.maxrateKbps <= 6000);
  assert.ok(VIDEO_DELIVERY_PROFILE.bufsizeKbps >= 8000 && VIDEO_DELIVERY_PROFILE.bufsizeKbps <= 12000);
  assert.ok(VIDEO_DELIVERY_PROFILE.audioBitrateKbps >= 128 && VIDEO_DELIVERY_PROFILE.audioBitrateKbps <= 160);
  assert.equal(VIDEO_DELIVERY_PROFILE.maxLongEdge, 1920);
  assert.equal(VIDEO_DELIVERY_PROFILE.maxShortEdge, 1080);
});

// ---------------------------------------------------------------------------
// Step 11B — idempotency fix: the normalization-profile marker this
// codebase stamps onto a Reel's canonical source object, and the pure
// decision of whether a value read back later matches it.
// ---------------------------------------------------------------------------

check('VIDEO_NORMALIZATION_PROFILE_VERSION is a plain positive integer, not a random string', () => {
  assert.equal(typeof VIDEO_NORMALIZATION_PROFILE_VERSION, 'number');
  assert.ok(Number.isInteger(VIDEO_NORMALIZATION_PROFILE_VERSION) && VIDEO_NORMALIZATION_PROFILE_VERSION > 0);
});

check('buildVideoNormalizationMetadata returns exactly one key, matching VIDEO_NORMALIZATION_METADATA_KEY, with the CURRENT version as its string value', () => {
  const metadata = buildVideoNormalizationMetadata();
  assert.deepEqual(Object.keys(metadata), [VIDEO_NORMALIZATION_METADATA_KEY]);
  assert.equal(metadata[VIDEO_NORMALIZATION_METADATA_KEY], String(VIDEO_NORMALIZATION_PROFILE_VERSION));
  assert.equal(typeof metadata[VIDEO_NORMALIZATION_METADATA_KEY], 'string', 'S3/R2 metadata values must be strings');
});

check('isVideoSourceAlreadyNormalized(marker) is true ONLY for the exact current-version stamped value', () => {
  const metadata = buildVideoNormalizationMetadata();
  assert.equal(isVideoSourceAlreadyNormalized(metadata[VIDEO_NORMALIZATION_METADATA_KEY]), true);
});

check('isVideoSourceAlreadyNormalized is false for an absent marker (null/undefined) — a raw, never-finalized source, or a legacy Reel', () => {
  assert.equal(isVideoSourceAlreadyNormalized(null), false);
  assert.equal(isVideoSourceAlreadyNormalized(undefined), false);
});

check('isVideoSourceAlreadyNormalized is false for an OLDER/different profile version string — forces a real re-encode, never silently treated as current', () => {
  assert.equal(isVideoSourceAlreadyNormalized('0'), false);
  assert.equal(isVideoSourceAlreadyNormalized(String(VIDEO_NORMALIZATION_PROFILE_VERSION + 1)), false);
});

check('isVideoSourceAlreadyNormalized is false for an arbitrary/garbage string — never a loose/coercive comparison', () => {
  assert.equal(isVideoSourceAlreadyNormalized('true'), false);
  assert.equal(isVideoSourceAlreadyNormalized(''), false);
  assert.equal(isVideoSourceAlreadyNormalized('v1'), false);
});

console.log('\n=== functions/ Reel video delivery profile logic test results ===');
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
