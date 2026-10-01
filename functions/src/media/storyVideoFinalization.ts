/**
 * Step 11C — the full, pure ORCHESTRATION of the NEW finalizeStoryVideo
 * callable's own workflow — mirrors reelVideoFinalization.ts's
 * performReelVideoFinalization field-for-field (download the current
 * video source -> run ffmpeg to normalize it to VIDEO_DELIVERY_PROFILE ->
 * upload the result back over the Story's OWN existing source object ->
 * confirm the Firestore document), extracted into its own file with ZERO
 * firebase-functions/firebase-admin import — same reasoning as every
 * other pure orchestration in this directory.
 *
 * Deliberately its OWN file rather than a reused call into
 * performReelVideoFinalization: a Story's own confirm-write touches the
 * `stories/{storyId}` document, not `reels/{reelId}` — genuinely
 * different Firestore collections/documents, so sharing the orchestration
 * function itself would mean threading a "which collection" parameter
 * through a function whose entire point is NOT knowing anything about
 * its caller. What IS shared — the ENCODE PROFILE and the idempotency
 * marker logic — already lives in videoNormalizationProfile.ts and is
 * imported here unchanged, same as reelVideoFinalization.ts does.
 *
 * TRUE IDEMPOTENCY (built in from the start here, not a later fix — see
 * reelVideoFinalization.ts's own top doc comment for the full reasoning
 * this mirrors): `readCanonicalSourceState` is checked FIRST, before any
 * download. If the canonical object already carries the CURRENT profile's
 * own normalization marker (a prior run's uploadNormalizedVideo already
 * succeeded; only the confirm below failed last time), this skips
 * download/ffmpeg/upload entirely and goes straight to the (idempotent,
 * safe-to-repeat) Firestore confirm, reading the object's own CURRENT
 * size via the same metadata call rather than a stale locally-remembered
 * one.
 */
import { isVideoSourceAlreadyNormalized, NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S } from './videoNormalizationProfile';

export type StoryVideoFinalizationFailureReason =
  | 'video-unavailable'
  | 'ffmpeg-failed'
  | 'ffmpeg-empty-output'
  | 'output-too-large'
  | 'final-upload-failed'
  | 'confirm-write-failed';

export type StoryVideoFinalizationOutcome = { ok: true } | { ok: false; reason: StoryVideoFinalizationFailureReason };

export type StoryVideoFinalizationPaths = {
  localVideoPath: string;
  localOutputPath: string;
};

export type StoryVideoFinalizationCanonicalState = { sizeBytes: number; normalizationMarker: string | null };

export type StoryVideoFinalizationDeps = {
  /**
   * Step 11C — a METADATA-ONLY check (storySourceStorage.ts's
   * readStoryCanonicalSourceState) of whether the Story's CURRENT
   * canonical source object already carries the CURRENT profile's
   * normalization marker — see this file's own top doc comment. `null`
   * means "cannot confirm — run the full pipeline," the safe default for
   * a missing object or any read failure. Optional and defaults to
   * "always run the full pipeline" when omitted.
   */
  readCanonicalSourceState?(): Promise<StoryVideoFinalizationCanonicalState | null>;
  /** Provider-aware — writes the CURRENT video source to `paths.localVideoPath`. `false` (not a throw) means "not available," mapped to the `video-unavailable` failure reason. */
  downloadVideo(localVideoPath: string): Promise<boolean>;
  /** The ENTIRE native-process boundary — a real implementation shells out to ffmpeg with the shared VIDEO_DELIVERY_PROFILE args; a test substitutes a fake. This file never inspects HOW normalization happened, only whether it produced a real, non-empty, size-bounded output file. */
  runFfmpegNormalize(localVideoPath: string, localOutputPath: string): Promise<void>;
  /** Real file size, in bytes, of the path given. */
  statFileSize(path: string): Promise<number>;
  /** Provider-aware — uploads the normalized `localOutputPath` back to the Story's OWN existing deterministic source key, overwriting the original in place (reuses storySourceStorage.ts's own uploadNormalizedStorySourceToProvider). */
  uploadNormalizedVideo(localOutputPath: string): Promise<void>;
  /** Writes the trusted, post-finalization fields onto the Story's own Firestore document — `storageContentType`/`fileSizeBytes`/`sourceNormalized`/`updatedAt` always; `mediaUrl` only for an R2-backed Story (see buildVersionedSourceUrl below) — via the Admin SDK, bypassing Firestore Rules entirely. */
  updateStoryDocument(fields: Record<string, unknown>): Promise<void>;
  /**
   * Returns a freshly-versioned, cache-busted delivery URL for the
   * Story's OWN source object — called ONLY for an R2-backed Story.
   * Returning `null` is treated as "nothing to add to the confirm-write,"
   * never a hard failure.
   */
  buildVersionedSourceUrl(): string | null;
};

/**
 * Step 11C — reuses the EXACT SAME 40MB guard Reel's own finalization
 * enforces (NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S) — correct because a
 * direct Story video shares the identical 60-second maximum duration as a
 * Reel (see videoNormalizationProfile.ts's own doc comment for the full
 * derivation and the explicit "never reuse by blind assumption" caveat
 * for any FUTURE video kind whose duration cap differs).
 */
export const STORY_NORMALIZED_VIDEO_MAX_SIZE_BYTES = NORMALIZED_VIDEO_MAX_SIZE_BYTES_60S;

/**
 * Runs the full Story-video finalization workflow against injected
 * dependencies. Every distinct failure mode maps to a distinct `reason`
 * — the caller (index.ts's own finalizeStoryVideo) is responsible for
 * translating that into a real HttpsError.
 */
export async function performStoryVideoFinalization(
  paths: StoryVideoFinalizationPaths,
  deps: StoryVideoFinalizationDeps
): Promise<StoryVideoFinalizationOutcome> {
  const canonicalState = deps.readCanonicalSourceState ? await deps.readCanonicalSourceState() : null;
  const alreadyNormalized = !!canonicalState && isVideoSourceAlreadyNormalized(canonicalState.normalizationMarker);

  let outputSize: number;

  if (alreadyNormalized) {
    // TRUE IDEMPOTENCY — see this file's own top doc comment. The
    // canonical object already IS the final normalized asset; never
    // re-download/re-encode/re-upload it.
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
    if (outputSize > STORY_NORMALIZED_VIDEO_MAX_SIZE_BYTES) {
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
    fields.mediaUrl = versionedSourceUrl;
  }

  try {
    await deps.updateStoryDocument(fields);
  } catch {
    // The normalized video is ALREADY the object at the Story's own
    // source key at this point — a retry re-reads the canonical state
    // above, finds the SAME current-profile marker, skips ffmpeg again,
    // and retries only this confirm-write.
    return { ok: false, reason: 'confirm-write-failed' };
  }

  return { ok: true };
}
