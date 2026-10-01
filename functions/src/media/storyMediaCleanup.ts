/**
 * Step 10A — the shared, provider-aware cleanup for a Story's OWN
 * physical media object, used by account deletion (deleteOwnStories, see
 * functions/src/index.ts). Deliberately its own tiny file with ZERO
 * firebase-functions/firebase-admin import — same reasoning as every
 * other pure orchestration file in this codebase: the real Firestore
 * read/bucket/R2 client can only exist in a real Cloud Function, but the
 * decision ("which backend actually holds this Story's object") is pure
 * and directly testable with a fake bucket and a delete spy.
 *
 * A Story owns exactly ONE physical media object (its own `source` — see
 * storySourceKey) — unlike a Reel, there is no separate thumbnail object
 * (a Story has no cover-frame concept) and no music object (a Story
 * never has music). This is the entire reason this file is this small
 * compared to reelMediaCleanup.ts.
 */
import { deleteR2Object } from './r2Storage';
import { deleteReelSourceMedia, type BucketLike, type RawReelData } from './reelSourceStorage';

export type StoryMediaCleanupResult = {
  /** Whether a delete was actually attempted (false only when `storagePath` itself is missing — an incomplete/corrupt document). */
  mediaAttempted: boolean;
  /** Whether the object existed immediately before this delete — mirrors deleteReelSourceMedia's own return convention. */
  mediaDeleted: boolean;
};

export type StoryMediaCleanupDeps = {
  /** Defaults to the real, authenticated deleteR2Object — overridden in tests with a fake in-memory object store's own delete function. */
  deleteR2?: (key: string) => Promise<void>;
};

/**
 * Deletes a Story's own physical media object, on whichever backend it
 * actually lives, given the Story's OWN Firestore data. Unlike
 * cleanupReelOwnedMedia, this needs no separate trusted uid/storyId
 * parameters to derive a key from — see this function's own `storagePath`
 * comment below for why trusting the document's own field is already
 * provably safe here, so there is no client-facing surface this could
 * ever leak into (this is only ever called from account deletion, never
 * from a client-reachable callable). Reuses deleteReelSourceMedia
 * directly — that function is already fully generic over bucket/path/
 * provider, with no Reel-specific logic whatsoever, so duplicating it
 * here for Stories would be pure repetition for zero benefit.
 *
 * Best-effort: never throws, matching every other media-cleanup
 * convention in this codebase — a failed/missing object never blocks the
 * rest of an already-decided Story deletion.
 */
export async function cleanupStoryOwnedMedia(bucket: BucketLike, story: RawReelData, deps: StoryMediaCleanupDeps = {}): Promise<StoryMediaCleanupResult> {
  const deleteR2 = deps.deleteR2 ?? deleteR2Object;
  const storagePath = typeof story.storagePath === 'string' && story.storagePath.length > 0 ? story.storagePath : undefined;
  const storageProvider = story.storageProvider as string | undefined;
  const mediaAttempted = Boolean(storagePath);
  // Deliberately uses `storagePath` directly (the document's own field)
  // rather than deriving a fresh storySourceKey(uid, storyId) — same
  // reasoning deleteReelSourceMedia's own doc comment already gives:
  // firestore.rules pins this field to the exact deterministic
  // `stories/{uid}/{storyId}/source` string at create time and forbids
  // it from ever changing, so trusting it here is provably equivalent to
  // deriving it fresh.
  const mediaDeleted = storagePath ? await deleteReelSourceMedia(bucket, storagePath, storageProvider, deleteR2) : false;
  return { mediaAttempted, mediaDeleted };
}
