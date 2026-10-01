/**
 * Step 11B — the ONE shared, pure definition of this app's final Reel
 * video delivery profile: the exact resolution/fps/codec/bitrate/faststart
 * target every published VIDEO Reel's source object must end up at,
 * regardless of which of the three finalization pipelines produced it:
 *  - plain video, no music (the new gap this step closes) —
 *    reelVideoFinalization.ts's performReelVideoFinalization, wired into
 *    index.ts's new finalizeReelVideo callable.
 *  - video + music — muxReelMusic (index.ts), via the pre-existing
 *    performReelMux (reelMuxOrchestration.ts), now producing a single
 *    merge+normalize encode instead of a `-c:v copy` passthrough.
 *  - photo + music render — renderPhotoToVideo (index.ts), via the same
 *    performReelMux, already producing a real H.264 encode — now
 *    reusing this exact profile instead of its own separate, looser
 *    settings.
 * A plain photo Reel (mediaType 'photo', no music) is NEVER touched by
 * any of this — see reelEligibility.ts's own checks for why that path
 * never reaches ffmpeg at all.
 *
 * Dependency-free (no firebase-functions/firebase-admin import) — same
 * reasoning as every other pure media helper in this directory: WHAT
 * ffmpeg args to build is a pure, deterministic decision, even though
 * actually running ffmpeg isn't.
 *
 * Why one profile module instead of one single finalization function
 * shared literally verbatim across all three pipelines: the three
 * pipelines have genuinely different INPUTS (one video stream only; one
 * video + one separate audio stream to merge; one still image + one
 * separate audio stream to render from) and already have their own
 * distinct, independently-tested orchestration (reelMuxOrchestration.ts's
 * performReelMux, intentionally reused for both mux and photo-render —
 * see that file's own doc comment — plus this step's new, structurally
 * simpler performReelVideoFinalization for the plain-video case, which
 * has no second input/mapping/sound-attribution step at all). Forcing all
 * three into one function that branches internally on "do I have music,
 * do I have a still image" would be a MORE complex, harder-to-test
 * orchestration than three thin ones that share the one thing that
 * actually matters for this step's own stated goal: the final ENCODE
 * SETTINGS are identical no matter which path produced them. That shared
 * settings-and-dimension logic lives here, exactly once.
 */

/**
 * CRF 23 / preset "veryfast" / 5 Mbps maxrate / 10 Mbps bufsize / 128k AAC
 * — chosen and justified against the ACTUAL installed ffmpeg-static binary
 * (ffmpeg 6.1.1, confirmed via `ffmpeg -version` and `-h full` during this
 * step's own audit — never assumed):
 *  - `crf: 23` is x264's own documented default "visually near-lossless"
 *    quality target — the exact value ffmpeg already silently fell back
 *    to for every PRE-11B `-c:v libx264` call in this codebase that
 *    passed no explicit rate-control flag at all (e.g. renderPhotoToVideo
 *    before this step). Made explicit here so it can never silently
 *    drift if ffmpeg's own default ever changes.
 *  - `preset: 'veryfast'` — Cloud Functions here run on CPU-only, 1GiB
 *    memory-tier allocations (see muxReelMusic's/renderPhotoToVideo's own
 *    onCall config, both reused unchanged) with a 240s hard
 *    execFileAsync timeout already in place. x264's "medium" default
 *    preset is tuned for offline/unconstrained encoding time, not a
 *    time-boxed serverless invocation that — after this step — runs for
 *    EVERY plain video Reel, not just music ones. "veryfast" is x264's
 *    own documented trade for exactly this constraint: a few percent
 *    larger output for substantially faster encoding, keeping
 *    finalization comfortably inside the existing timeout even for a
 *    near-60-second, high-resolution source.
 *  - `maxrateKbps: 5000` / `bufsizeKbps: 10000` — a VBV cap, not the
 *    primary rate control (CRF already targets a quality level); this
 *    only bounds the rare high-motion/high-complexity clip CRF alone
 *    might otherwise let grow larger than typical. 5 Mbps sits in the
 *    middle of this step's own 4-6 Mbps guidance; bufsize at 2x maxrate
 *    is the standard VBV convention, giving the rate controller enough
 *    headroom to smooth bursts rather than visibly stepping down quality
 *    moment to moment.
 *  - `audioBitrateKbps: 128` — the lower end of this step's own 128k-160k
 *    guidance: every audio track being normalized here is a short-form
 *    phone video's own track (camera mic, or a merged device-picked
 *    music bed), not a dedicated music-only master, where 128k AAC is
 *    already transparent on a phone speaker/earbuds. Picking the
 *    conservative end keeps bytes down, which is this whole step's own
 *    stated goal.
 *  - `fpsMax: 30` via ffmpeg's own `-fpsmax` OUTPUT option (confirmed
 *    present in the installed binary via `-h full`, and empirically
 *    verified against two synthetic sources during this step's own
 *    audit: a 60fps source came out at exactly 30fps; a 24fps source
 *    came out completely unchanged at 24fps) — deliberately NOT a plain
 *    `-r 30`, which forces a LOWER source fps UP by duplicating frames,
 *    the one behavior this step's own spec explicitly forbids.
 */
export const REEL_VIDEO_PROFILE = {
  /** The longer of the two output dimensions is never allowed to exceed this — 1920, matching a 1080x1920 portrait target exactly, and a landscape video's own 1920x1080 bounding box exactly (see computeReelVideoOutputDimensions below). */
  maxLongEdge: 1920,
  /** The shorter of the two output dimensions is never allowed to exceed this — 1080. */
  maxShortEdge: 1080,
  fpsMax: 30,
  videoCodec: 'libx264',
  pixelFormat: 'yuv420p',
  crf: 23,
  preset: 'veryfast',
  maxrateKbps: 5000,
  bufsizeKbps: 10000,
  audioCodec: 'aac',
  audioBitrateKbps: 128,
} as const;

/**
 * Step 11B — the idempotency fix: a durable, server-verifiable marker
 * every finalization pipeline stamps onto a Reel's canonical source
 * OBJECT (never the Firestore document — Firestore's own `sourceNormalized`
 * confirm-write is exactly the step that can still fail AFTER this stamp
 * already landed) the moment it finishes normalizing it. A retry reads
 * this marker BACK from storage metadata (a cheap HEAD-style read, never
 * a full byte download — see reelSourceStorage.ts's
 * readReelCanonicalSourceState) to distinguish "raw, never-touched
 * canonical source" from "canonical source already IS the final
 * normalized asset, only the Firestore confirmation still needs to
 * happen" — WITHOUT ever inferring that from a URL shape, a codec guess,
 * or client-reported state, all of which this step's own spec explicitly
 * forbade.
 *
 * Versioned so a future profile change (e.g. a higher-resolution target,
 * a different codec) can deliberately re-normalize existing objects
 * stamped with an OLDER version, rather than being permanently stuck
 * treating them as "already done": bump
 * REEL_VIDEO_NORMALIZATION_PROFILE_VERSION, and every object stamped
 * under the OLD version simply stops matching
 * REEL_VIDEO_NORMALIZATION_MARKER on its next finalization attempt,
 * running the full ffmpeg path again exactly once. Never compared via
 * scattered ad-hoc string literals anywhere else in this codebase — every
 * comparison goes through isReelSourceAlreadyNormalized below, the one
 * place that actually knows what "matches the CURRENT profile" means.
 */
export const REEL_VIDEO_NORMALIZATION_PROFILE_VERSION = 1;

/** The exact custom-metadata KEY every finalization pipeline writes/reads on a Reel's canonical source object — one name, defined once, never duplicated as a string literal at any call site. */
export const REEL_VIDEO_NORMALIZATION_METADATA_KEY = 'aroundMeReelVideoNormalizedProfile';

/**
 * The exact VALUE stamped for the CURRENT profile version — a plain
 * string (both GCS custom metadata and S3/R2 object metadata require
 * string values; see putR2Object's and bucket.upload's own doc comments
 * for confirmation against the actually-installed SDK types). Callers
 * never hardcode this string themselves — they call
 * buildReelVideoNormalizationMetadata() below to get the full
 * key/value pair to attach at upload time, and
 * isReelSourceAlreadyNormalized() to check a value read back later.
 */
function currentNormalizationMarkerValue(): string {
  return String(REEL_VIDEO_NORMALIZATION_PROFILE_VERSION);
}

/** The exact metadata object every finalization pipeline's own upload call attaches to a Reel's canonical source object once it has produced a real, final, normalized asset at REEL_VIDEO_PROFILE. */
export function buildReelVideoNormalizationMetadata(): Record<string, string> {
  return { [REEL_VIDEO_NORMALIZATION_METADATA_KEY]: currentNormalizationMarkerValue() };
}

/**
 * `true` only when `marker` is EXACTLY the current profile version's own
 * stamped value — `undefined`/`null` (marker absent — a raw, never-
 * finalized source, or a legacy Reel predating this step), any OTHER
 * string (a different/older profile version, or a metadata-read failure
 * the caller already mapped to some placeholder), all return `false`,
 * which is the deliberately SAFE default: "run the normal ffmpeg path,"
 * never "assume this is already done." See reelSourceStorage.ts's
 * readReelCanonicalSourceState for the one place that reads a REAL
 * marker value and passes it here.
 */
export function isReelSourceAlreadyNormalized(marker: string | null | undefined): boolean {
  return marker === currentNormalizationMarkerValue();
}

export type ReelVideoDimensions = { width: number; height: number };

/** Floors to the nearest EVEN integer, never below 2 — H.264/yuv420p requires even width/height on both axes (an odd dimension makes ffmpeg itself fail, not just look wrong); the floor of 2 is a defensive guard against a degenerate near-zero input, never expected to matter for any real camera/library video. */
function toEvenFloor(value: number): number {
  const floored = Math.max(2, Math.floor(value));
  return floored % 2 === 0 ? floored : floored - 1;
}

/**
 * Computes the output dimensions for a Reel video from its OWN already-
 * trusted, already-persisted `width`/`height` (the exact fields every
 * Reel document already carries — see Reel.width/Reel.height in
 * src/types/reel.ts — captured client-side at selection/capture time and
 * never re-probed server-side; no ffprobe binary is installed in this
 * project, and none is needed for this decision).
 *
 * Preserves the source's own aspect ratio EXACTLY — a single scale
 * factor applied to both axes, never fitting width/height independently
 * (which would distort the aspect ratio for any source that isn't
 * exactly 1080:1920 or 1920:1080). Never upscales — a source already
 * smaller than the bounding box on every axis is returned at its own
 * original size (scale factor clamped at 1), then only even-corrected.
 * Orientation-aware, not a single fixed portrait box: a portrait-or-
 * square source (`height >= width`) is bounded at
 * `maxShortEdge x maxLongEdge` (1080x1920); a landscape source
 * (`width > height`) is bounded at `maxLongEdge x maxShortEdge`
 * (1920x1080) instead — so a landscape 4K source lands at 1920x1080,
 * never squeezed into a 1080-wide portrait box. A square source falls
 * out of the portrait-or-square branch naturally (`height >= width` is
 * true when they're equal), landing at 1080x1080.
 */
export function computeReelVideoOutputDimensions(sourceWidth: number, sourceHeight: number): ReelVideoDimensions {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error('computeReelVideoOutputDimensions requires positive source dimensions.');
  }
  const isPortraitOrSquare = sourceHeight >= sourceWidth;
  const maxWidth = isPortraitOrSquare ? REEL_VIDEO_PROFILE.maxShortEdge : REEL_VIDEO_PROFILE.maxLongEdge;
  const maxHeight = isPortraitOrSquare ? REEL_VIDEO_PROFILE.maxLongEdge : REEL_VIDEO_PROFILE.maxShortEdge;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: toEvenFloor(sourceWidth * scale),
    height: toEvenFloor(sourceHeight * scale),
  };
}

/** The ffmpeg `-vf` scale filter string for the given already-computed output dimensions — a plain `scale=W:H`, since computeReelVideoOutputDimensions above already did the aspect-ratio/never-upscale/even-dimension work; this never needs ffmpeg's own `scale` expression language (`trunc(iw/2)*2` and friends) at all. */
export function buildReelVideoScaleFilter(dimensions: ReelVideoDimensions): string {
  return `scale=${dimensions.width}:${dimensions.height}`;
}

/**
 * The shared OUTPUT-side ffmpeg args every one of the three finalization
 * pipelines appends after its own distinct `-i`/`-map`/duration args —
 * see this file's own top doc comment for why the INPUT side isn't
 * shared. Order matters only in that these must come after every input
 * flag and before the output path; callers simply `[...inputArgs,
 * ...buildReelVideoEncodeArgs(dimensions), outputPath]`.
 */
export function buildReelVideoEncodeArgs(dimensions: ReelVideoDimensions): string[] {
  return [
    '-vf', buildReelVideoScaleFilter(dimensions),
    '-fpsmax', String(REEL_VIDEO_PROFILE.fpsMax),
    '-c:v', REEL_VIDEO_PROFILE.videoCodec,
    '-preset', REEL_VIDEO_PROFILE.preset,
    '-crf', String(REEL_VIDEO_PROFILE.crf),
    '-maxrate', `${REEL_VIDEO_PROFILE.maxrateKbps}k`,
    '-bufsize', `${REEL_VIDEO_PROFILE.bufsizeKbps}k`,
    '-pix_fmt', REEL_VIDEO_PROFILE.pixelFormat,
    '-c:a', REEL_VIDEO_PROFILE.audioCodec,
    '-b:a', `${REEL_VIDEO_PROFILE.audioBitrateKbps}k`,
    '-movflags', '+faststart',
  ];
}
