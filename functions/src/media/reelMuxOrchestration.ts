/**
 * Step 9B — the full, pure ORCHESTRATION of muxReelMusic's own workflow
 * (download original video -> download music -> run ffmpeg -> upload the
 * muxed result back -> record sound attribution -> confirm the Firestore
 * document -> clean up the now-redundant standalone music object),
 * extracted into its own file with ZERO firebase-functions/firebase-admin
 * import — same reasoning as reelEligibility.ts/reelSourceStorage.ts: the
 * real Firestore/Storage/ffmpeg calls this needs can only happen in a
 * real Cloud Function (index.ts's own muxReelMusic), but the WORKFLOW
 * ITSELF — which step runs when, what happens on each kind of failure,
 * and in what order the final writes land — is pure orchestration logic
 * with no reason to be untestable just because its real dependencies
 * (ffmpeg, Firestore, Storage) aren't mockable the same way under plain
 * Node.
 *
 * Every real dependency is injected via `ReelMuxDeps`, each with no
 * default — index.ts's own muxReelMusic is responsible for supplying the
 * real bindings (ffmpeg via execFile, Firestore via the Admin SDK,
 * Storage via reelSourceStorage.ts's provider-aware helpers); a test
 * supplies plain fakes instead, including a FAKE FFMPEG boundary
 * (`runFfmpegMux`) — this file never shells out to a real binary itself.
 *
 * CRITICAL ORDERING FIX (Step 9B): the pre-existing Firebase-only
 * implementation deleted the standalone music object BEFORE confirming
 * the Firestore document (`musicFile.delete()` ran, then
 * `reelDocRef.update()` ran last). That ordering meant "final upload
 * succeeds but the Firestore confirmation fails" left NOTHING for a
 * retry to re-download the music from — the standalone object was
 * already gone. This file reverses that: the Firestore update happens
 * FIRST, and the (still best-effort) music delete happens only AFTER it
 * succeeds — see performReelMux's own body. This applies equally to the
 * pre-existing Firebase path (an unobservable change when everything
 * succeeds) and the new R2 path, and is what makes "client retries mux"
 * genuinely safe per the Step 9B spec's own Part 10/15.
 *
 * TRUE IDEMPOTENCY (Step 11B, fixed after an initial review caught the
 * gap): the paragraph above makes a confirm-write-failure retry SAFE, but
 * not actually idempotent on its own — a naive retry would re-download
 * the already-muxed/already-normalized canonical video and run ffmpeg
 * (the merge AND the Step 11B normalization encode) on it AGAIN, every
 * time confirmation fails, risking repeated lossy re-encodes. `deps.
 * readCanonicalSourceState` (optional; see its own doc comment) is
 * checked FIRST: if the canonical source object already carries the
 * CURRENT profile's normalization marker (stamped by
 * uploadMuxedVideo's/reelSourceStorage.ts's own prior, already-successful
 * run), this skips downloading/encoding the video entirely — but STILL
 * downloads the music, computes its hash, and resolves/archives its sound
 * origin (none of which were necessarily recorded anywhere durable before
 * the failed confirm — the standalone music object is deliberately still
 * present at this point, exactly because of the ordering fix above), then
 * retries ONLY the Firestore confirmation, then deletes the standalone
 * music exactly once, after that confirmation actually succeeds. No
 * second ffmpeg mux/render ever runs for an already-normalized canonical
 * asset.
 */
import { isReelSourceAlreadyNormalized } from './reelVideoProfile';

export type ReelMuxFailureReason =
  | 'video-unavailable'
  | 'music-unavailable'
  | 'ffmpeg-failed'
  | 'ffmpeg-empty-output'
  | 'sound-origin-copy-failed'
  | 'final-upload-failed'
  | 'confirm-write-failed';

export type ReelMuxOutcome = { ok: true } | { ok: false; reason: ReelMuxFailureReason };

export type ReelMuxSoundOrigin = { originAuthorUid: string; originReelId: string; isNewOrigin: boolean };

export type ReelMuxPaths = {
  localVideoPath: string;
  localMusicPath: string;
  localOutputPath: string;
};

export type ReelMuxCanonicalState = { sizeBytes: number; normalizationMarker: string | null };

export type ReelMuxDeps = {
  /**
   * Step 11B — a METADATA-ONLY check (reelSourceStorage.ts's
   * readReelCanonicalSourceState) of whether the Reel's CURRENT canonical
   * source object already carries the CURRENT profile's normalization
   * marker — see this file's own top doc comment for the full
   * idempotency reasoning. `null` means "cannot confirm — run the full
   * pipeline," the safe default for a missing object or any read
   * failure. Optional and defaults to "always run the full pipeline"
   * when omitted — every existing caller/test that has no reason to
   * exercise this new short-circuit is unaffected.
   */
  readCanonicalSourceState?(): Promise<ReelMuxCanonicalState | null>;
  /** Provider-aware — writes the CURRENT original video to `paths.localVideoPath`. `false` (not a throw) means "not available," mapped to the `video-unavailable` failure reason. */
  downloadVideo(localVideoPath: string): Promise<boolean>;
  /** Always Firebase (Reel audio/music itself is not migrated in Step 9B) — writes the picked music file to `paths.localMusicPath`. */
  downloadMusic(localMusicPath: string): Promise<boolean>;
  /** The ENTIRE native-process boundary — a real implementation shells out to ffmpeg; a test substitutes a fake that writes whatever bytes it wants to `localOutputPath`, or throws to simulate a real ffmpeg failure. This file never inspects HOW muxing happened, only whether it produced a real, non-empty output file. */
  runFfmpegMux(localVideoPath: string, localMusicPath: string, localOutputPath: string): Promise<void>;
  /** Real file size, in bytes, of the path given — used both to detect an empty/corrupt ffmpeg output and to record `fileSizeBytes` on the Reel document. */
  statFileSize(path: string): Promise<number>;
  /** SHA-256 of the music file's own bytes, for sound attribution — see Reel.musicHash's own doc comment in src/types/reel.ts. */
  computeSha256(path: string): Promise<string>;
  /** First-write-wins sound-origin resolution (functions/src/index.ts's own resolveSoundOrigin, unchanged by Step 9B). */
  resolveSoundOrigin(musicHash: string): Promise<ReelMuxSoundOrigin>;
  /** Provider-aware — uploads the muxed `localOutputPath` back to the Reel's OWN existing deterministic source key, overwriting the original in place, on whichever backend that Reel actually uses. */
  uploadMuxedVideo(localOutputPath: string): Promise<void>;
  /** Only called when `resolveSoundOrigin` reports `isNewOrigin: true` — permanently archives this exact sound's bytes at its own stable, hash-keyed Firebase path (unchanged by Step 9B: this canonical copy always stays on Firebase regardless of the Reel's own video provider). `musicHash` is the exact same value already passed to `resolveSoundOrigin` — handed back here rather than recomputed, since it determines the destination key. NOT best-effort — a failure here propagates as `sound-origin-copy-failed`, matching this workflow's own pre-existing behavior (this step was never wrapped in a swallow-the-error catch before Step 9B either). */
  uploadSoundOriginCopy(localMusicPath: string, musicHash: string): Promise<void>;
  /** Writes the trusted, post-mux fields onto the Reel's own Firestore document — `storageContentType`/`fileSizeBytes`/`musicHash`/`soundOriginAuthorUid`/`soundOriginReelId`/`updatedAt` always; `sourceUrl` only for an R2-backed Reel (see buildVersionedSourceUrl below) — via the Admin SDK, bypassing Firestore Rules entirely, exactly like this same write already did before Step 9B. */
  updateReelDocument(fields: Record<string, unknown>): Promise<void>;
  /** Best-effort deletion of the now-redundant standalone music object — see this file's own top doc comment for why this must run AFTER updateReelDocument succeeds, not before. */
  deleteStandaloneMusic(): Promise<void>;
  /**
   * Returns a freshly-versioned, cache-busted delivery URL for the Reel's
   * OWN source object — called ONLY for an R2-backed Reel (the caller is
   * responsible for passing a function that returns `null` outright for
   * a Firebase-backed Reel, so this file never needs to know the Reel's
   * own provider directly). Returning `null` (e.g. no public media
   * domain configured yet) is treated as "nothing to add to the
   * confirm-write" — never a hard failure; an R2 Reel whose delivery
   * isn't configured yet already couldn't display before mux either (see
   * Step 9A's own "never fabricate a URL" principle), so mux succeeding
   * without one is consistent with that, not a regression.
   */
  buildVersionedSourceUrl(): string | null;
};

/**
 * Step 9C — merged verbatim into the same `fields` object this file
 * already builds for its own confirm-write, letting a second caller
 * (renderPhotoToVideo) reuse this ENTIRE orchestration function
 * unchanged otherwise. muxReelMusic itself never passes this (defaults
 * to `{}`, a no-op merge); renderPhotoToVideo passes
 * `{ needsPhotoVideoRender: false }` — the one extra field its own
 * workflow needs recorded atomically in the SAME write that confirms the
 * rendered video is now the Reel's real source, so no reader can ever
 * observe `needsPhotoVideoRender: true` alongside an already-rendered
 * video. Deliberately a plain optional bag rather than a named
 * "photo-render mode" boolean — this file's own job is running steps in
 * the right order and mapping failures, not knowing which caller it is;
 * see this file's own top doc comment.
 */
export type ReelMuxExtraConfirmFields = Record<string, unknown>;

/**
 * Runs the full mux workflow against injected dependencies. Every
 * distinct failure mode from the Step 9B spec's own Part 10 maps to a
 * distinct `reason` — the caller (index.ts's own muxReelMusic) is
 * responsible for translating that into a real HttpsError.
 *
 * Never publishes/confirms a half-finished result: every step from
 * ffmpeg onward either fully completes or the function returns
 * `ok: false` before any further state changes — in particular, the
 * ORIGINAL (pre-mux) bytes at the Reel's own source key are left
 * completely untouched unless/until `uploadMuxedVideo` is actually
 * called, which only happens after a real, non-empty ffmpeg output
 * exists.
 */
export async function performReelMux(
  paths: ReelMuxPaths,
  deps: ReelMuxDeps,
  extraConfirmFields: ReelMuxExtraConfirmFields = {}
): Promise<ReelMuxOutcome> {
  const canonicalState = deps.readCanonicalSourceState ? await deps.readCanonicalSourceState() : null;
  const alreadyNormalized = !!canonicalState && isReelSourceAlreadyNormalized(canonicalState.normalizationMarker);

  let outputSize: number;

  if (!alreadyNormalized) {
    const videoReady = await deps.downloadVideo(paths.localVideoPath);
    if (!videoReady) return { ok: false, reason: 'video-unavailable' };
  }

  const musicReady = await deps.downloadMusic(paths.localMusicPath);
  if (!musicReady) return { ok: false, reason: 'music-unavailable' };

  // Hashed from the exact bytes just downloaded, BEFORE the standalone
  // music object is ever deleted — see this file's own "Sound
  // attribution" reasoning (unchanged from before Step 9B). Computed
  // and resolved EVEN on the already-normalized retry path: neither the
  // hash nor the sound-origin attribution was necessarily ever recorded
  // anywhere durable before the previous confirm-write failed.
  const musicHash = await deps.computeSha256(paths.localMusicPath);
  const soundOrigin = await deps.resolveSoundOrigin(musicHash);

  if (alreadyNormalized) {
    // TRUE IDEMPOTENCY — see this file's own top doc comment. The
    // canonical object already IS the final merged+normalized asset;
    // never mux/encode it a second time (which could duplicate or alter
    // the audio, not just waste CPU).
    outputSize = canonicalState!.sizeBytes;
  } else {
    try {
      await deps.runFfmpegMux(paths.localVideoPath, paths.localMusicPath, paths.localOutputPath);
    } catch {
      return { ok: false, reason: 'ffmpeg-failed' };
    }

    outputSize = await deps.statFileSize(paths.localOutputPath);
    if (outputSize <= 0) {
      return { ok: false, reason: 'ffmpeg-empty-output' };
    }

    try {
      await deps.uploadMuxedVideo(paths.localOutputPath);
    } catch {
      return { ok: false, reason: 'final-upload-failed' };
    }
  }

  if (soundOrigin.isNewOrigin) {
    try {
      await deps.uploadSoundOriginCopy(paths.localMusicPath, musicHash);
    } catch {
      return { ok: false, reason: 'sound-origin-copy-failed' };
    }
  }

  const versionedSourceUrl = deps.buildVersionedSourceUrl();
  const fields: Record<string, unknown> = {
    ...extraConfirmFields,
    storageContentType: 'video/mp4',
    fileSizeBytes: outputSize,
    musicHash,
    soundOriginAuthorUid: soundOrigin.originAuthorUid,
    soundOriginReelId: soundOrigin.originReelId,
  };
  if (versionedSourceUrl) {
    fields.sourceUrl = versionedSourceUrl;
  }

  try {
    await deps.updateReelDocument(fields);
  } catch {
    // The muxed video is ALREADY the object at the Reel's own source
    // key at this point (uploadMuxedVideo above already succeeded, and
    // already carries the normalization marker) — a retry re-reads the
    // canonical state above, finds that SAME marker, skips ffmpeg
    // entirely (Step 11B's own idempotency fix — see this file's own top
    // doc comment), re-downloads the STILL-PRESENT standalone music
    // object (not yet deleted — see below) only to re-resolve its hash/
    // sound-origin, and retries only this exact confirm-write.
    return { ok: false, reason: 'confirm-write-failed' };
  }

  // Only AFTER the Firestore confirm has actually succeeded — best-effort,
  // matching this codebase's own "media cleanup failure never undoes an
  // already-decided operation" convention (e.g. discardReelDraft's own
  // Storage cleanup). Deliberately LAST, not before the write above — see
  // this file's own top doc comment for the ordering bug this fixes.
  await deps.deleteStandaloneMusic().catch(() => undefined);

  return { ok: true };
}
