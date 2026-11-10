/**
 * The shared, provider-aware cleanup for a user's own profile-photo and
 * profile-cover physical media objects, used by account deletion
 * (deleteProfileDocuments, functions/src/index.ts). Fills a real,
 * confirmed gap: unlike a Reel/Story, `profilePhotoKey(uid)`/
 * `profileCoverKey(uid)` were never deleted by any code path on either
 * backend, including account deletion.
 *
 * UNLIKE cleanupReelOwnedMedia/cleanupStoryOwnedMedia, there is no
 * `photoStorageProvider`/`coverStorageProvider` field on UserProfile to
 * branch on — a profile photo/cover is uploaded to the SAME deterministic
 * key regardless of backend (overwritten in place on every re-upload, see
 * objectKey.ts's own doc comment), and nothing in this codebase persists
 * which backend last wrote it. The safe, idempotent answer is the same one
 * cleanupReelOwnedMediaWithoutDocument already established for an
 * identical "don't know which provider; try both" situation
 * (reelMediaCleanup.ts): attempt a delete on BOTH backends for both keys.
 * A key that was never real on one backend costs nothing beyond one
 * harmless no-op call; a key that IS real on either backend is always
 * covered regardless of which.
 */
import { profileCoverKey, profilePhotoKey } from './objectKey';
import { deleteR2Object } from './r2Storage';
import type { BucketLike } from './reelSourceStorage';

export type ProfileMediaCleanupResult = {
  /** Whether the Firebase-side profilePhotos/{uid}/photo object existed immediately before this delete. */
  photoFirebaseDeleted: boolean;
  /** Whether an R2 delete call was made for the same key — true only means the call did not throw (R2's own DeleteObjectCommand is idempotent and does not distinguish "existed" from "already gone"). */
  photoR2Attempted: boolean;
  /** Same meaning as photoFirebaseDeleted, for profileCovers/{uid}/photo. */
  coverFirebaseDeleted: boolean;
  /** Same meaning as photoR2Attempted, for profileCovers/{uid}/photo. */
  coverR2Attempted: boolean;
};

export type ProfileMediaCleanupDeps = {
  /** Defaults to the real, authenticated deleteR2Object — overridden in tests with a fake in-memory object store's own delete function. */
  deleteR2?: (key: string) => Promise<void>;
};

/**
 * Deletes a user's own profile-photo and profile-cover objects, on both
 * backends, best-effort and idempotent — never throws (a media-cleanup
 * hiccup must never block the rest of account deletion, matching every
 * other cleanup function in this codebase). `uid` is a required, explicit
 * parameter, never inferred from anything else, since both keys are
 * derived purely from it (there is no Firestore document to read first).
 */
export async function cleanupProfileOwnedMedia(
  bucket: BucketLike,
  uid: string,
  deps: ProfileMediaCleanupDeps = {}
): Promise<ProfileMediaCleanupResult> {
  const deleteR2 = deps.deleteR2 ?? deleteR2Object;

  async function deleteFirebaseKey(key: string): Promise<boolean> {
    try {
      const file = bucket.file(key);
      const [existedBefore] = await file.exists();
      await file.delete({ ignoreNotFound: true });
      return existedBefore;
    } catch (error) {
      console.warn(`[cleanupProfileOwnedMedia] Could not delete Firebase object at "${key}":`, error);
      return false;
    }
  }
  async function attemptR2Delete(key: string): Promise<boolean> {
    try {
      await deleteR2(key);
      return true;
    } catch (error) {
      console.warn(`[cleanupProfileOwnedMedia] Could not delete R2 object at "${key}":`, error);
      return false;
    }
  }

  const photoKey = profilePhotoKey(uid);
  const coverKey = profileCoverKey(uid);

  const photoFirebaseDeleted = await deleteFirebaseKey(photoKey);
  const photoR2Attempted = await attemptR2Delete(photoKey);
  const coverFirebaseDeleted = await deleteFirebaseKey(coverKey);
  const coverR2Attempted = await attemptR2Delete(coverKey);

  return { photoFirebaseDeleted, photoR2Attempted, coverFirebaseDeleted, coverR2Attempted };
}
