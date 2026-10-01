/**
 * Step 10B — provider-aware Reel-owned MUSIC storage operations (read +
 * delete), mirroring reelSourceStorage.ts's own downloadReelSourceForMux/
 * deleteReelSourceMedia exactly, but for the Reel's own standalone music
 * object (`reels/{uid}/{reelId}/music`) instead of its source. Extracted
 * into its own file with ZERO firebase-functions/firebase-admin import —
 * same reasoning as every other provider-aware storage module in this
 * codebase: directly unit-testable with a fake bucket and a fake R2
 * object store, no real credentials or network needed.
 *
 * Deliberately NOT a generic "Reel media storage" service — this file
 * only ever reads or deletes the ONE deterministic music key a Reel can
 * own, derived from the CALLER-supplied, already-trusted uid/reelId
 * (never from the Reel document's own fields) — same security posture as
 * downloadReelSourceForMux's own doc comment. There is no "upload/
 * replace" primitive here, unlike the source's own
 * uploadMuxedReelSourceToProvider: a Reel's music object is only ever
 * WRITTEN by the client's own direct upload (via a presigned R2 PUT or a
 * Firebase Storage Rules-authorized PUT — see requestMediaUploadAuthorization.ts's
 * own 'reelMusic' branch), never rewritten server-side the way a video
 * source is by mux/render.
 */
import { reelMusicKey } from './objectKey';
import { deleteR2Object, downloadR2ObjectBuffer } from './r2Storage';
import type { BucketLike, RawReelData } from './reelSourceStorage';

export interface ReelMusicStorageDeps {
  /** Defaults to the real, authenticated downloadR2ObjectBuffer — overridden in tests with a fake in-memory R2 store. */
  getObject?: (key: string) => Promise<Buffer>;
  /** Defaults to the real, authenticated deleteR2Object. */
  deleteObject?: (key: string) => Promise<void>;
  /** Defaults to `node:fs/promises`' own `writeFile`. */
  writeFileImpl?: (path: string, data: Buffer) => Promise<void>;
}

/**
 * Downloads a Reel's OWN standalone music file to `destination`, on
 * whichever backend `reel.musicStorageProvider` says — the music
 * counterpart of downloadReelSourceForMux (reelSourceStorage.ts). Used by
 * muxReelMusic/renderPhotoToVideo's own `downloadMusic` dependency (see
 * reelMuxOrchestration.ts's own ReelMuxDeps).
 *
 * For 'r2': an AUTHENTICATED read (GetObjectCommand via
 * downloadR2ObjectBuffer) — never the public delivery URL, for the exact
 * same "never depend on CDN-cache behavior for server-critical
 * processing" reasoning downloadReelSourceForMux's own doc comment
 * already gives, and because a Reel's music object never even HAS a
 * public URL in this design (see Reel.musicStorageProvider's own doc
 * comment, src/types/reel.ts, for why no `musicUrl` field exists at
 * all).
 *
 * Returns `false` (never throws) for a missing object on either backend
 * — the caller (performReelMux) turns that into the `music-unavailable`
 * failure reason, exactly as before this file existed.
 */
export async function downloadReelMusicToLocalFile(
  bucket: BucketLike,
  reel: RawReelData,
  uid: string,
  reelId: string,
  destination: string,
  deps: ReelMusicStorageDeps = {}
): Promise<boolean> {
  if (reel.musicStorageProvider === 'r2') {
    const getObject = deps.getObject ?? downloadR2ObjectBuffer;
    try {
      const buffer = await getObject(reelMusicKey(uid, reelId));
      if (deps.writeFileImpl) {
        await deps.writeFileImpl(destination, buffer);
      } else {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(destination, buffer);
      }
      return true;
    } catch {
      return false;
    }
  }
  const file = bucket.file(reel.musicStorageAudioPath as string);
  const [exists] = await file.exists();
  if (!exists) return false;
  await file.download({ destination });
  return true;
}

/**
 * Best-effort deletes a Reel's OWN standalone music object, on whichever
 * backend `reel.musicStorageProvider` says — used ONLY after a
 * successful mux/render confirm-write (see performReelMux's own
 * `deleteStandaloneMusic` dependency, called AFTER updateReelDocument
 * succeeds — Step 9B's own critical ordering fix, unchanged by this
 * file). Never throws, matching this codebase's own established
 * "cleanup failure never undoes an already-decided operation" convention.
 */
export async function deleteReelMusic(bucket: BucketLike, reel: RawReelData, uid: string, reelId: string, deps: ReelMusicStorageDeps = {}): Promise<void> {
  const musicKey = reelMusicKey(uid, reelId);
  if (reel.musicStorageProvider === 'r2') {
    const deleteObject = deps.deleteObject ?? deleteR2Object;
    await deleteObject(musicKey).catch(() => undefined);
    return;
  }
  await bucket
    .file(reel.musicStorageAudioPath as string)
    .delete({ ignoreNotFound: true })
    .catch(() => undefined);
}
