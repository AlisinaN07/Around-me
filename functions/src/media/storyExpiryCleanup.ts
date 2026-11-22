/**
 * Step 10A.1 — the pure, per-story and per-batch ORCHESTRATION behind the
 * scheduled expired-Story cleanup (functions/src/index.ts's own
 * cleanupExpiredStories, an onSchedule function). Extracted into its own
 * file with ZERO firebase-functions/firebase-admin import — same
 * reasoning as reelMuxOrchestration.ts/reelMediaCleanup.ts: the real
 * Firestore QUERY/DELETE and the real bucket/R2 client can only exist in
 * a real Cloud Function, but the DECISION logic (given one expired
 * Story's data, clean up its media then its document, in the right order,
 * with the right retry semantics) is pure and directly testable with a
 * fake bucket and a delete spy.
 *
 * ============================================================
 * WHY THIS FILE EXISTS (the Step 10A.1 audit)
 * ============================================================
 * `expiresAt` makes an expired Story stop being QUERIED (every read path
 * filters `expiresAt > now`) — it does NOT delete anything. Before this
 * step, NOTHING ever deleted an expired Story's Firestore document or its
 * Storage media, on Firebase OR R2: no Firestore TTL policy exists in
 * this repository (there is no config surface for one in firebase.json/
 * firestore.indexes.json, and even if there were, Part 2 of this step's
 * own spec is right that TTL alone is unsafe here — it would delete the
 * document before anything could read `storageProvider` off it to know
 * which backend to clean up), and no scheduled Cloud Function covered
 * Stories at all (the only existing one, collaborative.ts's own
 * refreshCollaborativeRecommendations, does unrelated recommendation-
 * profile work). Migrating Stories to R2 (Step 10A) without fixing this
 * would mean R2 objects accumulate forever, same as Firebase ones already
 * silently did — this file is what actually stops that.
 *
 * ============================================================
 * REAL-FAILURE vs. ALREADY-MISSING (Part 6 of the spec)
 * ============================================================
 * This is DELIBERATELY NOT the same cleanupStoryOwnedMedia
 * (storyMediaCleanup.ts) that account deletion/manual delete use — those
 * two always proceed to delete the Firestore document regardless of
 * whether the media delete itself succeeded (an acceptable, already-
 * documented "orphan media, never a stuck document" trade-off for a
 * USER-INITIATED action). A SCHEDULED, unattended job needs the opposite
 * trade-off: if a genuine storage-provider/network failure happens (not
 * "the object was already gone," which is a perfectly normal, safe
 * outcome), the Story's Firestore document MUST be kept — it is the only
 * remaining record of which uid/storyId pair that leftover media belongs
 * to. Deleting it anyway would permanently orphan the media with no way
 * to ever find it again. This file's own cleanupExpiredStory therefore
 * distinguishes three real outcomes per object, not two:
 *  - 'deleted' — a real object existed and was just removed.
 *  - 'already-missing' — nothing was there to remove (Firebase's own
 *    `file.exists()` reported `false` before `delete({ignoreNotFound:true})`
 *    ran; R2's own DeleteObjectCommand is inherently idempotent and
 *    cannot distinguish "existed" from "already gone" at the protocol
 *    level, so a non-throwing R2 call is treated as this same safe
 *    outcome either way — never a cause for concern).
 *  - 'failed' — the delete call itself THREW. For R2 specifically, R2's
 *    own API never throws just because a key doesn't exist (delete is
 *    idempotent there), so a thrown error here can only mean a genuine
 *    transport/credential/service failure — never a false positive. For
 *    Firebase, `ignoreNotFound: true` already absorbs the "didn't exist"
 *    case inside the client library itself, so anything that still
 *    throws past that is, likewise, a genuine failure.
 * Only 'deleted' and 'already-missing' ever proceed to delete the
 * Firestore document. 'failed' leaves it untouched, ready for the NEXT
 * scheduled run to retry — see cleanupExpiredStory's own doc comment.
 *
 * Every key this file deletes is DERIVED via storySourceKey(authorUid,
 * storyId) — the authorUid/storyId pair READ OFF THE STORY'S OWN
 * FIRESTORE DOCUMENT by the trusted scheduled job (never from any client
 * request — there is no client input anywhere in this path at all) —
 * never parsed from `mediaUrl`, never a client-supplied path of any kind.
 */
import { storySourceKey } from './objectKey';
import { deleteR2Object } from './r2Storage';
import type { BucketLike } from './reelSourceStorage';

/** The minimal shape this file needs per expired Story — read directly off its own Firestore document by the caller (functions/src/index.ts's own cleanupExpiredStories), never trusted from anywhere else. */
export type ExpiredStoryRecord = {
  /** The Firestore document id — always equal to the Story's own `storyId` field (isValidStoryCreate pins `data.storyId == storyId` at create time, immutable afterward), reused here as both the doc-delete target and the key-derivation input. */
  id: string;
  authorUid: string;
  /** `undefined`/anything other than exactly `'r2'` defaults to 'firebase' — same convention as every other provider field in this codebase (never inferred from a URL/path shape). */
  storageProvider?: string;
};

export type ExpiredStoryMediaStatus = 'deleted' | 'already-missing' | 'failed';

export type ExpiredStoryCleanupOutcome = {
  storyId: string;
  mediaStatus: ExpiredStoryMediaStatus;
  /** Only ever `true` when `mediaStatus` is 'deleted' or 'already-missing' AND the Firestore delete call itself also succeeded — see cleanupExpiredStory's own doc comment for why a genuine media failure must never reach the document-delete step at all. */
  documentDeleted: boolean;
};

export type ExpiredStoryCleanupDeps = {
  /** Defaults to the real, authenticated deleteR2Object — overridden in tests with a fake in-memory object store's own delete function. */
  deleteR2?: (key: string) => Promise<void>;
  /** Deletes the Story's own Firestore document by id — the caller's real implementation is `db.doc(\`stories/${id}\`).delete()`. Idempotent on Firestore's own side (deleting an already-gone document is not an error), so a document that disappeared concurrently (a manual delete racing this same run) is handled correctly with no special-casing needed here. */
  deleteStoryDocument(id: string): Promise<void>;
};

/**
 * Cleans up ONE expired Story: its own physical media object, then (only
 * on a safe outcome) its Firestore document. Never throws — a failure at
 * either step is reported in the returned outcome, never propagated, so
 * one bad Story in a batch can never abort the rest (see
 * cleanupExpiredStoriesBatch below).
 *
 * ORDERING (Part 6): media cleanup is attempted FIRST, the Firestore
 * document is deleted ONLY AFTER a safe media outcome — the reverse order
 * would risk deleting the one record (authorUid/storyId/storageProvider)
 * needed to ever locate and retry a stuck media object again.
 */
export async function cleanupExpiredStory(
  bucket: BucketLike,
  story: ExpiredStoryRecord,
  deps: ExpiredStoryCleanupDeps
): Promise<ExpiredStoryCleanupOutcome> {
  const deleteR2 = deps.deleteR2 ?? deleteR2Object;
  const key = storySourceKey(story.authorUid, story.id);
  const provider = story.storageProvider === 'r2' ? 'r2' : 'firebase';

  let mediaStatus: ExpiredStoryMediaStatus;
  if (provider === 'r2') {
    try {
      // R2's own DeleteObjectCommand is idempotent — it does not throw
      // for a key that doesn't exist, so a successful call here always
      // means a safe outcome (the object is gone now, whether or not it
      // existed a moment ago) — see this file's own top doc comment.
      await deleteR2(key);
      mediaStatus = 'deleted';
    } catch {
      mediaStatus = 'failed';
    }
  } else {
    try {
      const file = bucket.file(key);
      const [existedBefore] = await file.exists();
      await file.delete({ ignoreNotFound: true });
      mediaStatus = existedBefore ? 'deleted' : 'already-missing';
    } catch {
      mediaStatus = 'failed';
    }
  }

  if (mediaStatus === 'failed') {
    return { storyId: story.id, mediaStatus, documentDeleted: false };
  }

  let documentDeleted = false;
  try {
    await deps.deleteStoryDocument(story.id);
    documentDeleted = true;
  } catch {
    // Best-effort — the media is already safely gone either way; a
    // future run's own Firestore delete call is itself idempotent, so
    // retrying costs nothing (see deleteStoryDocument's own doc comment).
    // This Story simply remains in the next query's own result set,
    // where its now-missing media resolves instantly as
    // 'already-missing' and the document delete is retried.
  }
  return { storyId: story.id, mediaStatus, documentDeleted };
}

export type ExpiredStoryBatchResult = {
  processed: number;
  mediaDeleted: number;
  mediaAlreadyMissing: number;
  mediaFailed: number;
  documentsDeleted: number;
};

/**
 * Processes an already-fetched, already-bounded batch of expired Stories
 * (the caller's own Firestore query — `status == 'published' && expiresAt
 * <= now`, `.limit(N)` — decides how many ever reach this function; this
 * function has no pagination/looping of its own, matching Part 2's own
 * "smallest reliable implementation" instruction: any overflow beyond one
 * batch simply waits for the next scheduled run, which is safe and
 * self-healing by design, never a correctness issue). One Story's own
 * failure (media or document) never aborts the rest of the batch —
 * cleanupExpiredStory above already never throws.
 */
export async function cleanupExpiredStoriesBatch(
  bucket: BucketLike,
  stories: ExpiredStoryRecord[],
  deps: ExpiredStoryCleanupDeps
): Promise<ExpiredStoryBatchResult> {
  const result: ExpiredStoryBatchResult = { processed: 0, mediaDeleted: 0, mediaAlreadyMissing: 0, mediaFailed: 0, documentsDeleted: 0 };
  for (const story of stories) {
    const outcome = await cleanupExpiredStory(bucket, story, deps);
    result.processed += 1;
    if (outcome.mediaStatus === 'deleted') result.mediaDeleted += 1;
    else if (outcome.mediaStatus === 'already-missing') result.mediaAlreadyMissing += 1;
    else result.mediaFailed += 1;
    if (outcome.documentDeleted) result.documentsDeleted += 1;
  }
  return result;
}
