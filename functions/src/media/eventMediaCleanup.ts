/**
 * The shared, provider-aware cleanup for an Event's own cover-photo
 * physical media object, used by `deleteContentDocumentAndSubcollections`
 * (functions/src/index.ts) — the one primitive all three real Event
 * deletion routes already funnel through (self-delete via deleteMyContent,
 * account-deletion cascade via deleteOwnContent, and moderation removal
 * via removeReportedContent).
 *
 * ROOT CAUSE this fixes: `createEvent` (src/services/content.ts)
 * previously persisted only `coverPhotoURL` — a resolved, opaque display
 * URL — never the underlying storage key. `EventContent.coverStoragePath`/
 * `coverStorageProvider` (src/types/content.ts) are the fix: persisted
 * once, at creation, alongside `coverPhotoURL`.
 *
 * SECURITY — Step 2B, EXACT Event ownership (not just namespace
 * ownership): the first version of this fix only verified that
 * `coverStoragePath` started with the author's own `eventCovers/{uid}/`
 * namespace — which still let a client claim ANY object under its own
 * namespace, including one belonging to a DIFFERENT, already-published
 * Event of the SAME author's (two Events by one author share a uid, but
 * never a `contentId`). The fix is to bind the cover's storage path to
 * THIS Event's own real, final `contentId` by EXACT string equality —
 * `eventCovers/{authorUid}/{contentId}/photo`, nothing else — rather than
 * a same-uid prefix with an arbitrary trailing segment. `contentId` is
 * generated once, upfront, by the Create Event screen (see
 * generateEventId's own doc comment in content.ts) and reused as BOTH the
 * cover's own upload path AND the Event document's own id, so a NEW
 * Event's `contentId` can never equal a PRE-EXISTING Event's `contentId`
 * (Firestore's own create/update semantics guarantee a `create` only
 * ever targets a path with no prior document — content/{contentId} can
 * never be updated at all, see firestore.rules' own
 * `allow update: if false`).
 *
 * firestore.rules' own isValidEventShape already enforces this exact
 * same equality at WRITE time (content documents are immutable after
 * creation, so this only ever needs to hold once). This function
 * re-checks the identical property again, independently, at DELETE time,
 * using the Event document's own `authorUid` AND `contentId` fields —
 * never trusting `coverStoragePath` on its own, even though the
 * write-time Rule should already guarantee it. A path that doesn't EXACTLY
 * match is treated exactly like a missing key: skipped, logged, never
 * deleted — this includes a cross-Event reuse attempt (same author,
 * wrong contentId), a cross-user attempt (wrong authorUid), an unrelated
 * media kind, and an arbitrary string.
 *
 * LEGACY EVENTS: an Event created before these fields existed, an Event
 * created under the brief PRIOR scheme that tied `coverStoragePath` to an
 * independently-generated `draftId` (which can essentially never equal
 * this document's own `contentId` by chance), or an Event with no cover
 * at all — all three simply fail the exact-match check above and are
 * treated identically: nothing to clean up. This function does NOT guess
 * a path from `coverPhotoURL` (parsing a Firebase download URL or an R2
 * delivery URL back into a storage key is fragile and could, on a
 * malformed/unexpected URL shape, target the wrong object) — a legacy
 * Event's cover image, if one exists, is an ACCEPTED, EXPLAINED
 * limitation: it is never deleted by any code path until/unless a future
 * step adds a real backfill.
 */
import { deleteR2Object } from './r2Storage';
import type { BucketLike } from './reelSourceStorage';

export type RawEventData = Record<string, unknown>;

export type EventMediaCleanupResult = {
  /** False when there was no coverStoragePath to act on at all (no cover, a legacy/draftId-scheme Event, a cross-Event or cross-user mismatch, or any other value that failed the exact-match trust check) — never true for a value this function refused to trust. */
  coverAttempted: boolean;
  /** Whether the object existed immediately before this delete (Firebase), or the R2 delete call did not throw (R2's own DeleteObjectCommand is idempotent and does not distinguish "existed" from "already gone"). Always false when coverAttempted is false. */
  coverDeleted: boolean;
};

export type EventMediaCleanupDeps = {
  /** Defaults to the real, authenticated deleteR2Object — overridden in tests with a fake in-memory object store's own delete function. */
  deleteR2?: (key: string) => Promise<void>;
};

/**
 * Pure — the one real security property this whole file exists to
 * enforce. Exported for direct testing. EXACT equality only — not a
 * prefix/namespace check — against THIS Event's own authorUid AND
 * contentId together, so a cross-Event reuse attempt (right author,
 * wrong contentId) is rejected exactly like a cross-user attempt (wrong
 * author) or an arbitrary string.
 */
export function isTrustedEventCoverStoragePath(coverStoragePath: string, authorUid: string, contentId: string): boolean {
  if (
    typeof coverStoragePath !== 'string' ||
    typeof authorUid !== 'string' ||
    authorUid.length === 0 ||
    typeof contentId !== 'string' ||
    contentId.length === 0
  ) {
    return false;
  }
  return coverStoragePath === `eventCovers/${authorUid}/${contentId}/photo`;
}

/**
 * Deletes an Event's own cover-photo object, on whichever backend it
 * actually lives, given the Event's OWN Firestore data. Never throws — a
 * media-cleanup hiccup must never block the rest of an already-decided
 * Event deletion (hashtag-count decrement, subcollections, the
 * Firestore doc itself all still proceed regardless), matching every
 * other media-cleanup primitive in this codebase.
 */
export async function cleanupEventOwnedMedia(
  bucket: BucketLike,
  event: RawEventData,
  deps: EventMediaCleanupDeps = {}
): Promise<EventMediaCleanupResult> {
  const deleteR2 = deps.deleteR2 ?? deleteR2Object;

  const coverStoragePath = typeof event.coverStoragePath === 'string' ? event.coverStoragePath : undefined;
  const authorUid = typeof event.authorUid === 'string' ? event.authorUid : '';
  const contentId = typeof event.contentId === 'string' ? event.contentId : '';

  if (!coverStoragePath || !isTrustedEventCoverStoragePath(coverStoragePath, authorUid, contentId)) {
    // No cover, a legacy/draftId-scheme Event, a cross-Event or
    // cross-user mismatch, or any other untrusted value — in every case,
    // nothing is deleted. See this file's own top doc comment for why
    // guessing is never done here.
    if (coverStoragePath) {
      console.warn(`[cleanupEventOwnedMedia] Ignoring an untrusted coverStoragePath "${coverStoragePath}" — does not exactly match this Event's own author/contentId.`);
    }
    return { coverAttempted: false, coverDeleted: false };
  }

  const coverStorageProvider = event.coverStorageProvider as string | undefined;

  if (coverStorageProvider === 'r2') {
    try {
      await deleteR2(coverStoragePath);
      return { coverAttempted: true, coverDeleted: true };
    } catch (error) {
      console.warn(`[cleanupEventOwnedMedia] Could not delete R2 cover at "${coverStoragePath}":`, error);
      return { coverAttempted: true, coverDeleted: false };
    }
  }

  try {
    const file = bucket.file(coverStoragePath);
    const [existedBefore] = await file.exists();
    await file.delete({ ignoreNotFound: true });
    return { coverAttempted: true, coverDeleted: existedBefore };
  } catch (error) {
    console.warn(`[cleanupEventOwnedMedia] Could not delete Firebase cover at "${coverStoragePath}":`, error);
    return { coverAttempted: true, coverDeleted: false };
  }
}
