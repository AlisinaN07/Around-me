/**
 * Step 9A — the R2 cleanup ORCHESTRATION behind the discardReelSource
 * callable (discardReelSource.ts), extracted into its own file with ZERO
 * firebase-functions/firebase-admin import — same reasoning as
 * mediaUploadValidation.ts/reelEligibility.ts/objectKey.ts: importing
 * `firebase-functions/v2/https` transitively pulls in `firebase-admin`'s
 * auth module -> `jwks-rsa` -> `jose` (a pure-ESM package), which fails
 * to `require()` under this project's plain-Node test runner. Keeping
 * this logic here, with no such import, is what makes it directly
 * unit-testable — see functions/scripts/test-discard-reel-source-logic.cjs.
 *
 * discardReelSource.ts imports this and supplies the real
 * `deleteR2Object` as the default `deleteObject` — a test supplies a
 * plain spy instead.
 */
import { reelMusicKey, reelSourceKey, reelThumbnailKey } from './objectKey';
import { deleteR2Object } from './r2Storage';

export type RawReelData = Record<string, unknown>;

/**
 * Given a Reel's data, its author uid, and its own reelId, decide which
 * of its two possible R2 objects to delete and attempt each one,
 * best-effort. Deliberately takes `deleteObject` as a parameter
 * (defaulting to the real `deleteR2Object`) rather than importing it
 * directly at call sites: this is the entire reason the function is
 * structured this way — a test can pass a plain spy/fake here and
 * exercise the real branching/error-handling logic without needing real
 * R2 credentials or network access.
 *
 * The Firestore ownership/status READ and the eligibility DECISION both
 * still happen in the caller (discardReelSource.ts's own
 * handleDiscardReelSourceRequest), via the pure checkReelDiscardEligibility
 * every other Reel-media operation in this codebase also uses — this
 * function assumes that check has ALREADY passed.
 *
 * Key derivation reads ONLY the `uid`/`reelId` PARAMETERS — never
 * anything off the `reel` object itself (e.g. a hostile/foreign
 * `authorUid` field) — so a client can never influence which R2 object
 * gets targeted beyond the exact Reel it already proved ownership of.
 *
 * Step 9C — a plain photo Reel's discard reaches this SAME, unmodified
 * function: after src/services/reels.ts's own lockstep
 * confirmReelPhotoSourceProvider, BOTH `storageProvider` and
 * `thumbnailStorageProvider` read `'r2'`, so this function attempts a
 * delete at BOTH `reelSourceKey`/`reelThumbnailKey` — even though a photo
 * Reel only ever had ONE real R2 object written, at the source key (see
 * confirmReelPhotoSourceProvider's own doc comment: there is no separate
 * client thumbnail-upload step for a photo Reel at all). The
 * `reelThumbnailKey` delete for such a Reel is a harmless no-op — an S3/R2
 * DeleteObjectCommand for a key that was never written succeeds
 * idempotently rather than throwing — so this never creates an orphan or
 * a real error; it costs one redundant API call. Deliberately NOT special-
 * cased away: doing so would mean this function needs to know about
 * `mediaType` at all, which it currently doesn't, and the cost of leaving
 * it as-is is zero (see test-discard-reel-source-logic.cjs's own Step 9C
 * test).
 *
 * Step 10B — ALSO attempts the Reel's own standalone music object at
 * `reelMusicKey(uid, reelId)` when `musicStorageProvider === 'r2'`. Only
 * ever real for a `musicSourceType === 'device'` Reel (createReelDraft's
 * own Firestore Rules already guarantee `musicStorageProvider` stays at
 * its fixed 'firebase' default for a no-music Reel, same sentinel
 * convention as every other music field) — a no-music Reel's own check
 * here simply never fires, costing nothing.
 */
export async function performReelSourceDiscardCleanup(
  reel: RawReelData,
  uid: string,
  reelId: string,
  deleteObject: (key: string) => Promise<void> = deleteR2Object
): Promise<{ videoAttempted: boolean; thumbnailAttempted: boolean; musicAttempted: boolean }> {
  let videoAttempted = false;
  let thumbnailAttempted = false;
  let musicAttempted = false;

  if (reel.storageProvider === 'r2') {
    videoAttempted = true;
    try {
      await deleteObject(reelSourceKey(uid, reelId));
    } catch (error) {
      // Best-effort, matching this codebase's own established convention
      // for discard-time cleanup (see discardReelDraft's own Firebase
      // deletes in src/services/reels.ts) — a failed cleanup attempt
      // never blocks the draft's own Firestore deletion, it just risks
      // leaving an orphaned object for later trusted CLI cleanup.
      console.warn(`[discardReelSource] Could not delete R2 video source for Reel "${reelId}":`, error);
    }
  }
  if (reel.thumbnailStorageProvider === 'r2') {
    thumbnailAttempted = true;
    try {
      await deleteObject(reelThumbnailKey(uid, reelId));
    } catch (error) {
      console.warn(`[discardReelSource] Could not delete R2 thumbnail for Reel "${reelId}":`, error);
    }
  }
  if (reel.musicStorageProvider === 'r2') {
    musicAttempted = true;
    try {
      await deleteObject(reelMusicKey(uid, reelId));
    } catch (error) {
      console.warn(`[discardReelSource] Could not delete R2 music for Reel "${reelId}":`, error);
    }
  }

  return { videoAttempted, thumbnailAttempted, musicAttempted };
}
