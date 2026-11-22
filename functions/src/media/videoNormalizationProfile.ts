/**
 * Step 11B (Reel) / Step 11C (Story) — the ONE shared, pure definition of
 * this app's final short-form VIDEO delivery profile: the exact
 * resolution/fps/codec/bitrate/faststart target every published video
 * object — Reel OR Story — must end up at, regardless of which
 * finalization pipeline produced it:
 *  - Reel, plain video, no music — reelVideoFinalization.ts's
 *    performReelVideoFinalization, wired into index.ts's finalizeReelVideo
 *    callable.
 *  - Reel, video + music — muxReelMusic (index.ts), via performReelMux
 *    (reelMuxOrchestration.ts), one merge+normalize encode.
 *  - Reel, photo + music render — renderPhotoToVideo (index.ts), via the
 *    same performReelMux, one render+normalize encode.
 *  - Story, direct video capture/upload (Step 11C) — index.ts's
 *    finalizeStoryVideo callable, via storyVideoFinalization.ts's
 *    performStoryVideoFinalization — structurally identical to the
 *    plain-Reel-video case (one input, no music/mux concept for Stories
 *    at all — see Story.mediaType's own doc comment, src/types/story.ts).
 *  - Story, copied from an already-published Reel (addReelToMyStory) —
 *    NEVER re-encoded here: that Reel already went through one of the
 *    three Reel pipelines above before it could ever reach `published`
 *    (see firestore.rules' own isValidReelPublish), so the copy simply
 *    carries the source Reel's own trusted `sourceNormalized` value
 *    forward — see index.ts's own addReelToMyStory for the exact
 *    reasoning this is safe without re-touching storage metadata at all.
 * A plain photo Reel or plain photo Story is NEVER touched by any of this
 * — see reelEligibility.ts's/storyEligibility.ts's own checks for why
 * those paths never reach ffmpeg at all.
 *
 * This module itself has NO idea whether its caller is a Reel or a Story
 * — it only knows "dimensions in, ffmpeg args out" and "a profile-version
 * marker, built and checked one way." The Reel-specific and Story-
 * specific pieces (which object KEY to read/write, which Firestore
 * document/field to confirm) live in reelSourceStorage.ts/
 * reelVideoFinalization.ts and storySourceStorage.ts/
 * storyVideoFinalization.ts respectively — see Part 16 of the Step 11C
 * spec's own "shared core vs. provider/key-specific logic" instruction
 * for why this module deliberately stays this narrow rather than growing
 * into one generic storage service.
 *
 * Dependency-free (no firebase-functions/firebase-admin import) — same
 * reasoning as every other pure media helper in this directory: WHAT
 * ffmpeg args to build is a pure, deterministic decision, even though
 * actually running ffmpeg isn't.
 *
 * Why one profile module instead of one single finalization function
 * shared literally verbatim across every pipeline: the pipelines have
 * genuinely different INPUTS (one video stream only; one video + one
 * separate audio stream to merge; one still image + one separate audio
 * stream to render from) and already have their own distinct,
 * independently-tested orchestration. Forcing all of them into one
 * function that branches internally on "do I have music, do I have a
 * still image, am I a Reel or a Story" would be a MORE complex, harder-
 * to-test orchestration than several thin ones that share the one thing
 * that actually matters for this step's own stated goal: the final
 * ENCODE SETTINGS are identical no matter which path produced them. That
 * shared settings-and-dimension logic lives here, exactly once.
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
export const VIDEO_DELIVERY_PROFILE = {
  /** The longer of the two output dimensions is never allowed to exceed this — 1920, matching a 1080x1920 portrait target exactly, and a landscape video's own 1920x1080 bounding box exactly (see computeVideoOutputDimensions below). */
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
 * Step 11B/11C — the idempotency fix: a durable, server-verifiable marker
 * every finalization pipeline (Reel or Story) stamps onto a canonical
 * source OBJECT (never the Firestore document — Firestore's own
 * `sourceNormalized` confirm-write is exactly the step that can still
 * fail AFTER this stamp already landed) the moment it finishes
 * normalizing it. A retry reads this marker BACK from storage metadata (a
 * cheap HEAD-style read, never a full byte download — see
 * reelSourceStorage.ts's readReelCanonicalSourceState /
 * storySourceStorage.ts's readStoryCanonicalSourceState) to distinguish
 * "raw, never-touched canonical source" from "canonical source already IS
 * the final normalized asset, only the Firestore confirmation still needs
 * to happen" — WITHOUT ever inferring that from a URL shape, a codec
 * guess, or client-reported state.
 *
 * ONE shared key/version pair for both Reel and Story objects — they live
 * at entirely different object keys (`reels/...` vs `stories/...`), so
 * there is no collision risk in sharing the same metadata KEY name; using
 * one name for "this object is normalized to video-delivery profile vN"
 * regardless of which collection owns the object is exactly the "do not
 * duplicate marker semantics" requirement.
 *
 * Versioned so a future profile change (e.g. a higher-resolution target,
 * a different codec) can deliberately re-normalize existing objects
 * stamped with an OLDER version, rather than being permanently stuck
 * treating them as "already done": bump
 * VIDEO_NORMALIZATION_PROFILE_VERSION, and every object stamped under the
 * OLD version simply stops matching on its next finalization attempt,
 * running the full ffmpeg path again exactly once. Never compared via
 * scattered ad-hoc string literals anywhere else in this codebase — every
 * comparison goes through isVideoSourceAlreadyNormalized below, the one
 * place that actually knows what "matches the CURRENT profile" means.
 */
export const VIDEO_NORMALIZATION_PROFILE_VERSION = 1;

/** The exact custom-metadata KEY every finalization pipeline (Reel or Story) writes/reads on a canonical source object — one name, defined once, never duplicated as a string literal at any call site. */
export const VIDEO_NORMALIZATION_METADATA_KEY = 'aroundMeVideoNormalizedProfile';

/**
 * The exact VALUE stamped for the CURRENT profile version — a plain
 * string (both GCS custom metadata and S3/R2 object metadata require
 * string values; see putR2Object's and bucket.upload's own doc comments
 * for confirmation against the actually-installed SDK types). Callers
 * never hardcode this string themselves — they call
 * buildVideoNormalizationMetadata() below to get the full
 * key/value pair to attach at upload time, and
 * isVideoSourceAlreadyNormalized() to check a value read back later.
 */
function currentNormalizationMarkerValue(): string {
  return String(VIDEO_NORMALIZATION_PROFILE_VERSION);
}

/** The exact metadata object every finalization pipeline's own upload call attaches to a canonical source object (Reel or Story) once it has produced a real, final, normalized asset at VIDEO_DELIVERY_PROFILE. */
export function buildVideoNormalizationMetadata(): Record<string, string> {
  return { [VIDEO_NORMALIZATION_METADATA_KEY]: currentNormalizationMarkerValue() };
}

/**
 * `true` only when `marker` is EXACTLY the current profile version's own
 * stamped value — `undefined`/`null` (marker absent — a raw, never-
 * finalized source, or a legacy Reel/Story predating this feature), any OTHER
 * string (a different/older profile version, or a metadata-read failure
 * the caller already mapped to some placeholder), all return `false`,
 * which is the deliberately SAFE default: "run the normal ffmpeg path,"
 * never "assume this is already done." See reelSourceStorage.ts's
 * readReelCanonicalSourceState for the one place that reads a REAL
 * marker value and passes it here.
 */
export function isVideoSourceAlreadyNormalized(marker: string | null | undefined): boolean {
  return marker === currentNormalizationMarkerValue();
}

export type VideoDimensions = { width: number; height: number };

/** Floors to the nearest EVEN integer, never below 2 — H.264/yuv420p requires even width/height on both axes (an odd dimension makes ffmpeg itself fail, not just look wrong); the floor of 2 is a defensive guard against a degenerate near-zero input, never expected to matter for any real camera/library video. */
function toEvenFloor(value: number): number {
  const floored = Math.max(2, Math.floor(value));
  return floored % 2 === 0 ? floored : floored - 1;
}

/**
 * Computes the output dimensions for a video (Reel or Story) from its
 * OWN already-trusted, already-persisted `width`/`height` (the exact
 * fields every Reel/Story document already carries — see
 * Reel.width/Reel.height in src/types/reel.ts, Story.width/Story.height
 * in src/types/story.ts — captured client-side at selection/capture time
 * and never re-probed server-side; no ffprobe binary is installed in
 * this project, and none is needed for this decision).
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
export function computeVideoOutputDimensions(sourceWidth: number, sourceHeight: number): VideoDimensions {
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error('computeVideoOutputDimensions requires positive source dimensions.');
  }
  const isPortraitOrSquare = sourceHeight >= sourceWidth;
  const maxWidth = isPortraitOrSquare ? VIDEO_DELIVERY_PROFILE.maxShortEdge : VIDEO_DELIVERY_PROFILE.maxLongEdge;
  const maxHeight = isPortraitOrSquare ? VIDEO_DELIVERY_PROFILE.maxLongEdge : VIDEO_DELIVERY_PROFILE.maxShortEdge;
  const scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  return {
    width: toEvenFloor(sourceWidth * scale),
    height: toEvenFloor(sourceHeight * scale),
  };
}

/** The ffmpeg `-vf` scale filter string for the given already-computed output dimensions — a plain `scale=W:H`, since computeVideoOutputDimensions above already did the aspect-ratio/never-upscale/even-dimension work; this never needs ffmpeg's own `scale` expression language (`trunc(iw/2)*2` and friends) at all. */
export function buildVideoScaleFilter(dimensions: VideoDimensions): string {
  return `scale=${dimensions.width}:${dimensions.height}`;
}

/**
 * The shared OUTPUT-side ffmpeg args every one of the three finalization
 * pipelines appends after its own distinct `-i`/`-map`/duration args —
 * see this file's own top doc comment for why the INPUT side isn't
 * shared. Order matters only in that these must come after every input
 * flag and before the output path; callers simply `[...inputArgs,
 * ...buildVideoEncodeArgs(dimensions), outputPath]`.
 */
export function buildVideoEncodeArgs(dimensions: VideoDimensions): string[] {
  return [
    '-vf', buildVideoScaleFilter(dimensions),
    '-fpsmax', String(VIDEO_DELIVERY_PROFILE.fpsMax),
    '-c:v', VIDEO_DELIVERY_PROFILE.videoCodec,
    '-preset', VIDEO_DELIVERY_PROFILE.preset,
    '-crf', String(VIDEO_DELIVERY_PROFILE.crf),
    '-maxrate', `${VIDEO_DELIVERY_PROFILE.maxrateKbps}k`,
    '-bufsize', `${VIDEO_DELIVERY_PROFILE.bufsizeKbps}k`,
    '-pix_fmt', VIDEO_DELIVERY_PROFILE.pixelFormat,
    '-c:a', VIDEO_DELIVERY_PROFILE.audioCodec,
    '-b:a', `${VIDEO_DELIVERY_PROFILE.audioBitrateKbps}k`,
    '-movflags', '+faststart',
  ];
}

/**
 * Step 11B (Reel) / Step 11C (Story) — the upper bound every finalization
 * pipeline enforces on a normalized output's own byte size, for any
 * video kind whose own maximum source duration is 60 seconds — both a
 * Reel (REEL_MAX_DURATION_MS, src/types/reel.ts) and a direct Story video
 * (createStoryDraft in src/services/stories.ts reuses that exact same
 * constant, unchanged, for its own duration validation) share this cap,
 * so this one constant correctly bounds both without duplicating the
 * derivation. At the configured rate-control ceiling (5000 kbps video +
 * 128 kbps audio = 5128 kbps, see VIDEO_DELIVERY_PROFILE above) sustained
 * for the full 60 seconds, the theoretical largest legitimate output is
 * 5128 * 60 / 8 ≈ 38.46 MB. 40 MB sits just above that ceiling — enough
 * headroom that no legitimately-encoded video at this profile is ever
 * rejected, while still catching a genuinely pathological/runaway ffmpeg
 * output (a rate-control failure, a corrupt/looping encode) before it
 * ever reaches Storage. Deliberately NOT the raw 50 MB upload cap
 * (REEL_VIDEO_MAX_SIZE_BYTES/REEL_MAX_FILE_SIZE_BYTES) — that limit
 * bounds an arbitrary, unprocessed device capture; this one bounds an
 * output this codebase itself just produced under known, fixed
 * rate-control settings, which should be materially smaller.
 *
 * If a FUTURE video kind this codebase normalizes ever has a genuinely
 * different maximum duration, derive a NEW constant from that duration —
 * never reuse this one by assumption (see the Step 11C spec's own
 * explicit "do not blindly copy 40MB if duration constraints differ"
 * instruction).
 */
export const NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S = 40 * 1024 * 1024;
