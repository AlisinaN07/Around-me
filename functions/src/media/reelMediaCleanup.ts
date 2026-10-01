/**
 * Step 9D — the ONE shared, provider-aware cleanup function for a Reel's
 * OWN physical media objects: `cleanupReelOwnedMedia`. Extracted into its
 * own file with ZERO firebase-functions/firebase-admin import — same
 * reasoning as reelSourceStorage.ts/reelEligibility.ts/reelDiscardCleanup.ts:
 * the real Firestore READ that produces the `reel` object, and the real
 * bucket/R2 client, can only exist in a real Cloud Function, but the
 * DECISION logic (given a Reel's data, which physical objects actually
 * need deleting, and on which backend) is pure enough to be directly
 * unit-tested with a fake bucket and a delete spy.
 *
 * WHY THIS FILE EXISTS (the Step 9D audit): three separate Reel-delete
 * paths — deleteMyReel, deleteOwnReels (account deletion), and
 * removeReportedReel (moderation) — each called deleteReelSourceMedia
 * directly for the Reel's own SOURCE object only. None of them ever
 * cleaned up:
 *   1. The Reel's own separate THUMBNAIL object (video Reels only — a
 *      genuine, confirmed storage leak on both Firebase and R2, for
 *      every published video Reel ever deleted through any of the three
 *      paths above).
 *   2. A still-present standalone MUSIC object (reels/{uid}/{reelId}/music)
 *      — e.g. a Reel deleted mid-upload, before muxReelMusic/
 *      renderPhotoToVideo ever ran and deleted it themselves.
 * This function is the single place that now knows the full, correct
 * physical-object model for every Reel variant, so all three delete
 * paths share ONE implementation instead of drifting independently.
 *
 * ============================================================
 * THE FULL PHYSICAL-OBJECT MODEL (per Reel variant)
 * ============================================================
 *  - Plain video (mediaType 'video', needsPhotoVideoRender false,
 *    musicSourceType 'none'): TWO physical objects — source, thumbnail.
 *    No music object ever existed.
 *  - Video + music (musicSourceType 'device'): up to THREE physical
 *    objects — source (the merged/muxed video after a successful mux,
 *    or the still-silent video before one), thumbnail, and a standalone
 *    music object IF mux hasn't deleted it yet (see below).
 *  - Plain photo (mediaType 'photo'): ONE physical object. Its
 *    `thumbnailStoragePath` is the exact SAME string as `storagePath`
 *    (enforced by firestore.rules' own isValidReelThumbnail, and, for an
 *    R2-backed one, isValidReelPhotoSourceProviderUpdate's own lockstep
 *    URL equality — see Step 9C) — there is NO second object to delete.
 *    Deleting source once is the whole job; a second delete attempt at
 *    the deterministic THUMBNAIL key would target an object that was
 *    NEVER written (the client never dispatches a separate R2/Firebase
 *    thumbnail upload for a photo Reel — see
 *    requestMediaUploadAuthorization.ts's own checkReelThumbnailEligibility),
 *    so this function explicitly SKIPS it rather than issue a pointless
 *    (if harmless) extra call.
 *  - Photo + music / photo-pending-render (mediaType 'video',
 *    needsPhotoVideoRender true or already rendered, musicSourceType
 *    'device'): up to THREE physical objects — source (the original
 *    photo before render, or the rendered video after — either way, one
 *    object, physically distinct from its own thumbnail: a REAL
 *    separate cover JPEG is generated client-side for this variant, same
 *    as plain video+music — see camera.tsx's own doc comment), a real
 *    separate thumbnail, and a standalone music object if not yet
 *    cleaned up by a successful render.
 *
 * NEVER deleted by this function (shared/reusable, not Reel-owned):
 *  - soundOrigins/{musicHash}/audio — the one permanent, hash-keyed copy
 *    of a sound's bytes, potentially referenced by many OTHER authors'
 *    Reels via their own soundOriginReelId/soundOriginAuthorUid (see
 *    Reel.musicHash's own doc comment, src/types/reel.ts). Deleting a
 *    Reel that merely contributed to or reused this hash must never
 *    remove the shared copy other Reels still depend on.
 *  - Any other Reel's own media, regardless of hashtag/city/author.
 *
 * Every key this function deletes is DERIVED, never read off the
 * document's own storagePath/thumbnailUrl/sourceUrl string fields —
 * `reelSourceKey`/`reelThumbnailKey`/`reelMusicKey`(uid, reelId), from
 * the CALLER-supplied, already-trusted uid/reelId — the same convention
 * Step 9B/9C's performReelMux/renderPhotoToVideo already established for
 * their own R2 reads/writes. (firestore.rules independently ALSO pins
 * storagePath/thumbnailStoragePath/musicStorageAudioPath to these exact
 * same deterministic strings at create time and forbids them from ever
 * changing after — so reading the document fields would be provably
 * equivalent for any legitimately-created Reel, but deriving them here
 * keeps this function correct even if that Rules invariant were ever
 * weakened, and never requires trusting a URL string as a delete path.)
 */
import { reelMusicKey, reelSourceKey, reelThumbnailKey } from './objectKey';
import { deleteR2Object } from './r2Storage';
import { deleteReelSourceMedia, type BucketLike, type RawReelData } from './reelSourceStorage';

export type ReelMediaCleanupResult = {
  /** Whether a delete was actually attempted for the Reel's own source object (false only when `storagePath` itself is missing — an incomplete/corrupt document, not a real variant). */
  sourceAttempted: boolean;
  /** Whether the source object existed immediately before this delete — mirrors deleteReelSourceMedia's own return convention (not a guarantee the delete itself succeeded for the R2 branch, which is logged-and-swallowed on failure, same as before this file existed). */
  sourceDeleted: boolean;
  /** Whether a SEPARATE thumbnail delete was attempted at all — always `false` when `thumbnailSameAsSource` is true (see that field). */
  thumbnailAttempted: boolean;
  /** Whether the thumbnail object existed immediately before this delete. Always `false` when `thumbnailAttempted` is false. */
  thumbnailDeleted: boolean;
  /** `true` for a plain photo Reel (and any other Reel whose declared mediaType is 'photo') — the Reel's thumbnail IS its own source object, so no separate delete is ever attempted. This is the explicit physical-identity signal Part 4 of the Step 9D spec asked for. */
  thumbnailSameAsSource: boolean;
  /** Whether a standalone music delete was attempted at all — only when `musicSourceType === 'device'`, regardless of Reel status (covers a still-uploading draft, a published-but-never-muxed oddity, and the common case where mux already deleted it — see musicDeleted). */
  musicAttempted: boolean;
  /** Whether the standalone music object existed immediately before this delete. `false` is the EXPECTED, common outcome for any Reel whose mux/render already ran successfully (that step already deleted it) — never treated as an error. */
  musicDeleted: boolean;
};

export type ReelMediaCleanupDeps = {
  /** Defaults to the real, authenticated deleteR2Object — overridden in tests with a fake in-memory object store's own delete function. */
  deleteR2?: (key: string) => Promise<void>;
};

/**
 * Deletes every physical media object a Reel actually owns, on whichever
 * backend each one actually lives, given the Reel's OWN Firestore data,
 * the TRUSTED author uid (never `reel.authorUid` — see this file's own
 * top doc comment), and the Reel's own id. Best-effort per object,
 * exactly like deleteReelSourceMedia's own pre-existing convention: one
 * missing/already-deleted/failed object never prevents an attempt at the
 * others, and never throws — the caller is always free to proceed with
 * the rest of its own deletion (Firestore doc, subcollections, hashtag
 * counts) regardless of what this function reports.
 *
 * `uid` is a required, explicit parameter — never read from `reel` —
 * specifically so a caller with a more trustworthy identity than the
 * document's own (possibly-missing, in the one legitimate case this
 * matters — see handleMissingReelDocumentCleanup's own doc comment) can
 * supply it directly.
 */
export async function cleanupReelOwnedMedia(
  bucket: BucketLike,
  reel: RawReelData,
  uid: string,
  reelId: string,
  deps: ReelMediaCleanupDeps = {}
): Promise<ReelMediaCleanupResult> {
  const deleteR2 = deps.deleteR2 ?? deleteR2Object;

  // ---- 1. SOURCE ---------------------------------------------------------
  const storagePath = typeof reel.storagePath === 'string' && reel.storagePath.length > 0 ? reel.storagePath : undefined;
  const storageProvider = reel.storageProvider as string | undefined;
  const sourceAttempted = Boolean(storagePath);
  const sourceDeleted = storagePath ? await deleteReelSourceMedia(bucket, storagePath, storageProvider, deleteR2) : false;

  // ---- 2. THUMBNAIL — explicit physical-identity check -------------------
  // A plain photo Reel's thumbnail IS its own source object (see this
  // file's own top doc comment) — mediaType is the authoritative,
  // already-established signal for this everywhere else in this codebase
  // (checkReelThumbnailEligibility, isValidReelThumbnailProviderUpdate,
  // isValidReelPhotoSourceProviderUpdate all gate the same way). A
  // missing mediaType (a genuinely pre-"FOTO"-mode legacy Reel) can only
  // ever be a real video, matching normalizeReel's own client-side
  // default — so it correctly takes the "separate thumbnail" branch.
  const mediaType = (reel.mediaType as string | undefined) ?? 'video';
  const thumbnailSameAsSource = mediaType === 'photo';
  const thumbnailStorageProvider = reel.thumbnailStorageProvider as string | undefined;
  let thumbnailAttempted = false;
  let thumbnailDeleted = false;
  if (!thumbnailSameAsSource) {
    thumbnailAttempted = true;
    const thumbnailKey = reelThumbnailKey(uid, reelId);
    if (thumbnailStorageProvider === 'r2') {
      try {
        await deleteR2(thumbnailKey);
        thumbnailDeleted = true;
      } catch (error) {
        console.warn(`[cleanupReelOwnedMedia] Could not delete R2 thumbnail at "${thumbnailKey}" for Reel "${reelId}":`, error);
      }
    } else {
      const file = bucket.file(thumbnailKey);
      const [existedBefore] = await file.exists();
      await file.delete({ ignoreNotFound: true });
      thumbnailDeleted = existedBefore;
    }
  }

  // ---- 3. STANDALONE MUSIC — always Firebase, never migrated -------------
  // Deliberately keyed on `musicSourceType === 'device'` alone, NOT on
  // Reel status or whether mux/render already ran — a still-"uploading"
  // draft abandoned mid-upload, and an already-published Reel whose mux
  // genuinely already deleted this object, both reach this same branch;
  // the idempotent exists-then-delete pattern below makes either outcome
  // safe (see this function's own top doc comment on musicDeleted).
  let musicAttempted = false;
  let musicDeleted = false;
  if (reel.musicSourceType === 'device') {
    musicAttempted = true;
    const musicKey = reelMusicKey(uid, reelId);
    const file = bucket.file(musicKey);
    const [existedBefore] = await file.exists();
    await file.delete({ ignoreNotFound: true });
    musicDeleted = existedBefore;
  }

  return { sourceAttempted, sourceDeleted, thumbnailAttempted, thumbnailDeleted, thumbnailSameAsSource, musicAttempted, musicDeleted };
}

export type ReelMediaBlindCleanupResult = {
  /** Firebase delete attempted at reelSourceKey(uid, reelId) — `true` means the object existed before this delete. */
  firebaseSourceDeleted: boolean;
  /** R2 delete attempted at reelSourceKey(uid, reelId) — `true` only means the call did not throw (R2's own DeleteObjectCommand is idempotent and does not distinguish "existed" from "already gone"). */
  r2SourceAttempted: boolean;
  /** Same as firebaseSourceDeleted, for reelThumbnailKey(uid, reelId). For a Reel that was actually a plain photo, this key was never written — the delete is a harmless no-op, same reasoning as cleanupReelOwnedMedia's own thumbnailSameAsSource branch, just without the ability to know that in advance. */
  firebaseThumbnailDeleted: boolean;
  r2ThumbnailAttempted: boolean;
  /** Same as above, for reelMusicKey(uid, reelId) — Firebase only, music is never migrated to R2. For a Reel with no music at all, this key was never written — harmless no-op. */
  firebaseMusicDeleted: boolean;
};

/**
 * Step 9D (Part 9) — the deliberately narrow answer to Step 9A's own
 * documented "moderation deletion when the Reel's Firestore document is
 * already missing cannot determine storage provider" limitation.
 *
 * This is now SAFE to do more than a single Firebase-only guess, because
 * every precondition the Step 9D spec requires is actually met at this
 * exact call site (removeReportedReel's own missing-document branch):
 *  - `uid` and `reelId` are TRUSTED — not read from request.data, but
 *    from the reports/{reportId} document's own `targetUid`/`reelId`
 *    fields, which firestore.rules' isValidReelReport already pinned to
 *    the Reel's real authorUid/id at REPORT-creation time (see
 *    removeReportedReel's own doc comment) and which no client write
 *    path can ever mutate afterward.
 *  - Every key is fully DETERMINISTIC — reelSourceKey/reelThumbnailKey/
 *    reelMusicKey(uid, reelId), the exact same builders every other
 *    trusted Reel-media operation in this codebase already uses.
 *  - There is NO possibility of targeting an unrelated object: these
 *    three keys, under this one uid+reelId pair, are the ENTIRE universe
 *    of objects a Reel could ever have owned (see cleanupReelOwnedMedia's
 *    own top doc comment for the full physical-object model) — nothing
 *    else is ever touched.
 *
 * So rather than continuing to guess "assume Firebase" (Step 9A's own
 * prior behavior, which silently found and deleted nothing for an
 * R2-sourced Reel), this attempts a delete on BOTH backends, for all
 * three keys — each individually best-effort/idempotent, so an object
 * that was never real on one backend (or never existed at all — a draft
 * reported and already discarded by its own author, say) costs nothing
 * beyond a few no-op calls. This still cannot know whether a given Reel
 * ever actually had music, or was a photo whose "thumbnail" key was
 * never written — but every one of those is already a safe no-op, never
 * an error and never a risk to an unrelated object.
 */
export async function cleanupReelOwnedMediaWithoutDocument(
  bucket: BucketLike,
  uid: string,
  reelId: string,
  deps: ReelMediaCleanupDeps = {}
): Promise<ReelMediaBlindCleanupResult> {
  const deleteR2 = deps.deleteR2 ?? deleteR2Object;

  async function deleteFirebaseKey(key: string): Promise<boolean> {
    const file = bucket.file(key);
    const [existedBefore] = await file.exists();
    await file.delete({ ignoreNotFound: true });
    return existedBefore;
  }
  async function attemptR2Delete(key: string): Promise<boolean> {
    try {
      await deleteR2(key);
      return true;
    } catch (error) {
      console.warn(`[cleanupReelOwnedMediaWithoutDocument] Could not delete R2 object at "${key}":`, error);
      return false;
    }
  }

  const sourceKey = reelSourceKey(uid, reelId);
  const thumbnailKey = reelThumbnailKey(uid, reelId);
  const musicKey = reelMusicKey(uid, reelId);

  const firebaseSourceDeleted = await deleteFirebaseKey(sourceKey);
  const r2SourceAttempted = await attemptR2Delete(sourceKey);
  const firebaseThumbnailDeleted = await deleteFirebaseKey(thumbnailKey);
  const r2ThumbnailAttempted = await attemptR2Delete(thumbnailKey);
  // Music is never migrated to R2 (Step 9A/9B/9C/9D's own standing
  // constraint) — only the Firebase key is ever meaningful.
  const firebaseMusicDeleted = await deleteFirebaseKey(musicKey);

  return { firebaseSourceDeleted, r2SourceAttempted, firebaseThumbnailDeleted, r2ThumbnailAttempted, firebaseMusicDeleted };
}
