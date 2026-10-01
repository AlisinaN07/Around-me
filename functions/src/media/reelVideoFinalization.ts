/**
 * Step 11B — the full, pure ORCHESTRATION of the NEW finalizeReelVideo
 * callable's own workflow (download the current video source -> run
 * ffmpeg to normalize it to VIDEO_DELIVERY_PROFILE -> upload the result back
 * over the Reel's OWN existing source object -> confirm the Firestore
 * document), extracted into its own file with ZERO
 * firebase-functions/firebase-admin import — same reasoning, and the same
 * pattern, as reelMuxOrchestration.ts's performReelMux: the real
 * Firestore/Storage/ffmpeg calls this needs can only happen in a real
 * Cloud Function (index.ts's own finalizeReelVideo), but the WORKFLOW
 * ITSELF is pure orchestration logic with no reason to be untestable.
 *
 * Deliberately SEPARATE from performReelMux rather than a reused/extended
 * call into it: this workflow has only ONE input (the video itself) and
 * no music/sound-attribution/standalone-cleanup steps at all — forcing it
 * through performReelMux's own `ReelMuxDeps` shape would mean fabricating
 * meaningless no-op `downloadMusic`/`uploadSoundOriginCopy`/
 * `deleteStandaloneMusic` implementations for every caller, for no real
 * code reuse (the two workflows' own STEP SEQUENCES genuinely differ).
 * What IS shared between every finalization pipeline is the ENCODE
 * PROFILE itself — see videoNormalizationProfile.ts's own doc comment for why that
 * one shared piece is what actually matters for this step's stated goal.
 *
 * Never publishes/confirms a half-finished result, same invariant as
 * performReelMux: the ORIGINAL (pre-normalization) bytes at the Reel's
 * own source key are left completely untouched unless/until
 * `uploadNormalizedVideo` is actually called, which only happens after a
 * real, non-empty, size-bounded ffmpeg output exists.
 *
 * TRUE IDEMPOTENCY (fixed after an initial review caught the gap): if
 * `updateReelDocument` then fails, the already-normalized bytes ARE
 * already at the Reel's own source key — but naively retrying this whole
 * function would re-download those already-normalized bytes and run
 * ffmpeg on them AGAIN, repeatedly, on every confirm-write failure
 * ("normalized H.264 -> re-encode -> re-encode -> ..."), wasting Cloud
 * Function CPU/storage I/O and risking generational quality loss from
 * stacking lossy re-encodes. `readCanonicalSourceState` (see
 * reelSourceStorage.ts) is checked FIRST, before any download: if the
 * canonical object already carries the CURRENT profile's own
 * normalization marker (stamped by uploadNormalizedVideo's own prior,
 * already-successful run — see videoNormalizationProfile.ts's own
 * isVideoSourceAlreadyNormalized), this skips download/ffmpeg/upload
 * entirely and goes straight to the (idempotent, safe-to-repeat)
 * Firestore confirm — reading the object's own CURRENT size via the same
 * metadata call rather than a stale locally-remembered one. A marker
 * that's absent, from an older profile version, or unreadable (a
 * transient metadata-read error) all safely fall through to the full
 * normal pipeline — see readReelCanonicalSourceState's own doc comment
 * for why that's the deliberately safe default.
 */
import { isVideoSourceAlreadyNormalized, NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S } from './videoNormalizationProfile';

export type ReelVideoFinalizationFailureReason =
  | 'video-unavailable'
  | 'ffmpeg-failed'
  | 'ffmpeg-empty-output'
  | 'output-too-large'
  | 'final-upload-failed'
  | 'confirm-write-failed';

export type ReelVideoFinalizationOutcome = { ok: true } | { ok: false; reason: ReelVideoFinalizationFailureReason };

export type ReelVideoFinalizationPaths = {
  localVideoPath: string;
  localOutputPath: string;
};

export type ReelVideoFinalizationCanonicalState = { sizeBytes: number; normalizationMarker: string | null };

export type ReelVideoFinalizationDeps = {
  /**
   * Step 11B — a METADATA-ONLY check (reelSourceStorage.ts's
   * readReelCanonicalSourceState) of whether the Reel's CURRENT canonical
   * source object already carries the CURRENT profile's normalization
   * marker — see this file's own top doc comment for the full
   * idempotency reasoning. `null` means "cannot confirm — run the full
   * pipeline," the safe default for a missing object or any read
   * failure. Optional and defaults to "always run the full pipeline"
   * when omitted — existing callers/tests that have no reason to
   * exercise this new short-circuit are unaffected.
   */
  readCanonicalSourceState?(): Promise<ReelVideoFinalizationCanonicalState | null>;
  /** Provider-aware — writes the CURRENT video source to `paths.localVideoPath`. `false` (not a throw) means "not available," mapped to the `video-unavailable` failure reason — mirrors performReelMux's own `downloadVideo` contract exactly (same reelSourceStorage.ts helper, reused unchanged). */
  downloadVideo(localVideoPath: string): Promise<boolean>;
  /** The ENTIRE native-process boundary — a real implementation shells out to ffmpeg with the shared VIDEO_DELIVERY_PROFILE args (see videoNormalizationProfile.ts); a test substitutes a fake that writes whatever bytes it wants to `localOutputPath`, or throws to simulate a real ffmpeg failure. This file never inspects HOW normalization happened, only whether it produced a real, non-empty, size-bounded output file. */
  runFfmpegNormalize(localVideoPath: string, localOutputPath: string): Promise<void>;
  /** Real file size, in bytes, of the path given — used both to detect an empty/corrupt ffmpeg output and to enforce the final-output size guard, and to record `fileSizeBytes` on the Reel document. */
  statFileSize(path: string): Promise<number>;
  /** Provider-aware — uploads the normalized `localOutputPath` back to the Reel's OWN existing deterministic source key, overwriting the original in place, on whichever backend that Reel actually uses (reuses reelSourceStorage.ts's own uploadMuxedReelSourceToProvider — this is the exact same "overwrite the canonical source object" operation mux/photo-render already perform, just reached from a different caller). */
  uploadNormalizedVideo(localOutputPath: string): Promise<void>;
  /** Writes the trusted, post-finalization fields onto the Reel's own Firestore document — `storageContentType`/`fileSizeBytes`/`sourceNormalized`/`updatedAt` always; `sourceUrl` only for an R2-backed Reel (see buildVersionedSourceUrl below) — via the Admin SDK, bypassing Firestore Rules entirely, same convention as every other trusted confirm-write in this codebase. */
  updateReelDocument(fields: Record<string, unknown>): Promise<void>;
  /**
   * Returns a freshly-versioned, cache-busted delivery URL for the Reel's
   * OWN source object — called ONLY for an R2-backed Reel (the caller is
   * responsible for passing a function that returns `null` outright for
   * a Firebase-backed Reel). Returning `null` is treated as "nothing to
   * add to the confirm-write," never a hard failure — same contract as
   * performReelMux's own `buildVersionedSourceUrl`.
   */
  buildVersionedSourceUrl(): string | null;
};

/**
 * Step 11C — this Reel-specific name is now just a re-export of the
 * shared, duration-parameterized guard (see videoNormalizationProfile.ts's
 * own NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S doc comment for the full
 * derivation) — Story's own storyVideoFinalization.ts reuses the EXACT
 * same constant directly, since a Story video shares the identical 60s
 * duration cap as a Reel (see createStoryDraft in src/services/stories.ts,
 * which imports REEL_MAX_DURATION_MS unchanged for this exact reason).
 * Kept under this name here only so this file's own existing references
 * don't need touching — never redefined/duplicated.
 */
export const REEL_NORMALIZED_VIDEO_MAX_SIZE_BYTES = NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S;

/**
 * Runs the full plain-video finalization workflow against injected
 * dependencies. Every distinct failure mode maps to a distinct `reason`
 * — the caller (index.ts's own finalizeReelVideo) is responsible for
 * translating that into a real HttpsError.
 */
export async function performReelVideoFinalization(
  paths: ReelVideoFinalizationPaths,
  deps: ReelVideoFinalizationDeps
): Promise<ReelVideoFinalizationOutcome> {
  const canonicalState = deps.readCanonicalSourceState ? await deps.readCanonicalSourceState() : null;
  const alreadyNormalized = !!canonicalState && isVideoSourceAlreadyNormalized(canonicalState.normalizationMarker);

  let outputSize: number;

  if (alreadyNormalized) {
    // TRUE IDEMPOTENCY — see this file's own top doc comment. The
    // canonical object already IS the final normalized asset (a prior
    // run's uploadNormalizedVideo already succeeded; only the confirm
    // below failed last time) — skip download/ffmpeg/upload entirely,
    // never re-encode an already-normalized asset.
    outputSize = canonicalState!.sizeBytes;
  } else {
    const videoReady = await deps.downloadVideo(paths.localVideoPath);
    if (!videoReady) return { ok: false, reason: 'video-unavailable' };

    try {
      await deps.runFfmpegNormalize(paths.localVideoPath, paths.localOutputPath);
    } catch {
      return { ok: false, reason: 'ffmpeg-failed' };
    }

    outputSize = await deps.statFileSize(paths.localOutputPath);
    if (outputSize <= 0) {
      return { ok: false, reason: 'ffmpeg-empty-output' };
    }
    if (outputSize > REEL_NORMALIZED_VIDEO_MAX_SIZE_BYTES) {
      return { ok: false, reason: 'output-too-large' };
    }

    try {
      await deps.uploadNormalizedVideo(paths.localOutputPath);
    } catch {
      return { ok: false, reason: 'final-upload-failed' };
    }
  }

  const versionedSourceUrl = deps.buildVersionedSourceUrl();
  const fields: Record<string, unknown> = {
    storageContentType: 'video/mp4',
    fileSizeBytes: outputSize,
    sourceNormalized: true,
  };
  if (versionedSourceUrl) {
    fields.sourceUrl = versionedSourceUrl;
  }

  try {
    await deps.updateReelDocument(fields);
  } catch {
    // The normalized video is ALREADY the object at the Reel's own
    // source key at this point — a retry re-reads the canonical state
    // above, finds the SAME current-profile marker, skips ffmpeg again,
    // and retries only this confirm-write. See this file's own top doc
    // comment.
    return { ok: false, reason: 'confirm-write-failed' };
  }

  return { ok: true };
}
