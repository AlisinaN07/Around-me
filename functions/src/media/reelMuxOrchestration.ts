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
 */

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

export type ReelMuxDeps = {
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
export async function performReelMux(paths: ReelMuxPaths, deps: ReelMuxDeps): Promise<ReelMuxOutcome> {
  const videoReady = await deps.downloadVideo(paths.localVideoPath);
  if (!videoReady) return { ok: false, reason: 'video-unavailable' };

  const musicReady = await deps.downloadMusic(paths.localMusicPath);
  if (!musicReady) return { ok: false, reason: 'music-unavailable' };

  // Hashed from the exact bytes just downloaded, BEFORE the standalone
  // music object is ever deleted — see this file's own "Sound
  // attribution" reasoning (unchanged from before Step 9B).
  const musicHash = await deps.computeSha256(paths.localMusicPath);
  const soundOrigin = await deps.resolveSoundOrigin(musicHash);

  try {
    await deps.runFfmpegMux(paths.localVideoPath, paths.localMusicPath, paths.localOutputPath);
  } catch {
    return { ok: false, reason: 'ffmpeg-failed' };
  }

  const outputSize = await deps.statFileSize(paths.localOutputPath);
  if (outputSize <= 0) {
    return { ok: false, reason: 'ffmpeg-empty-output' };
  }

  try {
    await deps.uploadMuxedVideo(paths.localOutputPath);
  } catch {
    return { ok: false, reason: 'final-upload-failed' };
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
    // key at this point (uploadMuxedVideo above already succeeded) — a
    // retry of the whole callable will re-download that SAME (already
    // muxed) video, re-download the STILL-PRESENT standalone music
    // object (not yet deleted — see below), and re-run ffmpeg/re-upload
    // idempotently (same deterministic output for the same inputs),
    // then retry this exact write. See this file's own top doc comment
    // for why the ordering below is what makes this safe.
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
