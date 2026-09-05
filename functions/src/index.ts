/**
 * Step 34.2 — trusted, idempotent account-DATA deletion backend.
 *
 * This does NOT delete the Firebase Auth account — that is a deliberately
 * later step (34.3/34.4), once a reauthentication UX exists. This callable
 * cleans every piece of Around Me application data owned by, or authored
 * by, the caller, per the owner's locked Step 34 policy:
 *
 *   - Posts/Activities/Events the caller authored: DELETE (subcollections
 *     first, then the parent).
 *   - Reels the caller authored: DELETE Firestore doc + Storage object +
 *     subcollections.
 *   - The caller's own likes/comments/responses/participation left on
 *     OTHER users' content/Reels: DELETE (participation on someone else's
 *     still-existing Activity decrements that Activity's stats counter in
 *     the same transaction as the participant doc's removal — see
 *     cleanupCrossUserParticipants).
 *   - Follow graph, block graph, notifications (both directions): DELETE.
 *   - Conversations/messages, Reports: RETAIN — never mutated, never
 *     deleted, never leaked into this callable's response.
 *   - Profile documents are removed last, in dependency order:
 *     privacySettings -> publicProfiles -> usernames (only if the
 *     reservation still actually points at this uid) -> users/{uid} LAST,
 *     since usernameLower is read from users/{uid} right up until then.
 *
 * SECURITY: the target uid comes exclusively from `request.auth.uid`.
 * `request.data` is never read for identity — there is no uid/targetUid/
 * userId parameter of any kind, so a caller can only ever delete their own
 * data no matter what they send.
 *
 * IDEMPOTENCY: every phase treats a missing document/object as "already
 * cleaned," never an error, so this callable is safe to invoke again after
 * a partial failure (network drop, timeout, retry) without double-counting
 * or corrupting another user's data.
 *
 * PAGINATION: every query that could return many documents uses "query a
 * bounded page, delete it, repeat until empty" rather than an unbounded
 * get() or a cursor (a cursor is unsafe here since deleting shifts the
 * result set out from under it).
 */
import {
  FieldValue,
  getFirestore,
  type Firestore,
  type Query,
} from 'firebase-admin/firestore';
import { initializeApp } from 'firebase-admin/app';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

initializeApp();

// europe-north1 (Finland) — see Step 34.1: the closest Cloud Functions
// 2nd-gen-supported region to this project's Firestore location,
// europe-north2 (Stockholm).
const REGION = 'europe-north1';

// Firestore's hard cap is 500 ops/batch — stay comfortably under it.
const BATCH_DELETE_SIZE = 400;
// Own content/Reels pages are processed one doc at a time (several nested
// operations each), so a smaller page keeps any single iteration bounded.
const OWNED_DOC_PAGE_SIZE = 50;
// Participant transactions run one at a time — keep pages modest.
const PARTICIPANT_PAGE_SIZE = 100;

type DrainResult = { total: number; roots: Record<string, number> };

/** Deletes every document in a query, paginating until it's empty. */
async function drainQuery(db: Firestore, makeQuery: () => Query): Promise<DrainResult> {
  let total = 0;
  const roots: Record<string, number> = {};
  for (;;) {
    const snap = await makeQuery().limit(BATCH_DELETE_SIZE).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const docSnap of snap.docs) {
      const root = docSnap.ref.path.split('/')[0];
      roots[root] = (roots[root] ?? 0) + 1;
      batch.delete(docSnap.ref);
    }
    await batch.commit();
    total += snap.size;
  }
  return { total, roots };
}

/** Deletes every document directly under one collection path (no filter needed — the whole subcollection is going away). */
async function drainCollection(db: Firestore, collectionPath: string): Promise<number> {
  const { total } = await drainQuery(db, () => db.collection(collectionPath));
  return total;
}

// ---------------------------------------------------------------------------
// Cross-user Activity participation — the one cross-user artifact with a
// paired invariant (content/{contentId}/stats/activity.participantCount)
// that must move atomically with the participant doc's removal.
// ---------------------------------------------------------------------------

type ParticipantCleanupResult = {
  /** The caller's own participation record on an Activity they themselves authored — removed directly; its stats doc is going away with the whole Activity in the own-content phase, so no decrement is needed or performed here. */
  ownActivitySkipped: number;
  /** Cross-user: participant doc removed and the sibling stats counter decremented by exactly 1, atomically. */
  crossUserDecremented: number;
  /** Already gone on a retry, or the parent content no longer exists at all. */
  alreadyGone: number;
  /** Stats doc missing/corrupt for a still-existing, someone-else-authored Activity — left untouched rather than risk corrupting that user's counter. */
  errors: string[];
};

async function cleanupCrossUserParticipants(db: Firestore, uid: string): Promise<ParticipantCleanupResult> {
  const result: ParticipantCleanupResult = {
    ownActivitySkipped: 0,
    crossUserDecremented: 0,
    alreadyGone: 0,
    errors: [],
  };

  for (;;) {
    const snap = await db.collectionGroup('participants').where('uid', '==', uid).limit(PARTICIPANT_PAGE_SIZE).get();
    if (snap.empty) break;

    let progressed = false;

    for (const participantSnap of snap.docs) {
      // participants live at content/{contentId}/participants/{uid}.
      const contentId = participantSnap.ref.path.split('/')[1];
      const contentRef = db.doc(`content/${contentId}`);
      const contentSnap = await contentRef.get();

      if (!contentSnap.exists) {
        await participantSnap.ref.delete();
        result.alreadyGone += 1;
        progressed = true;
        continue;
      }

      if (contentSnap.data()?.authorUid === uid) {
        // Own Activity — the whole document (and its stats doc) is removed
        // together in the own-content phase, so no counter correction is
        // needed here; just remove this one participant doc now.
        await participantSnap.ref.delete();
        result.ownActivitySkipped += 1;
        progressed = true;
        continue;
      }

      const statsRef = db.doc(`content/${contentId}/stats/activity`);
      try {
        const outcome = await db.runTransaction(async (tx) => {
          const [pSnap, statsSnap] = await Promise.all([tx.get(participantSnap.ref), tx.get(statsRef)]);
          if (!pSnap.exists) return 'already-gone' as const;
          if (!statsSnap.exists) return 'stats-missing' as const;
          const count = statsSnap.data()?.participantCount;
          if (typeof count !== 'number' || count <= 0) return 'stats-invalid' as const;
          tx.delete(participantSnap.ref);
          tx.update(statsRef, { participantCount: count - 1, updatedAt: FieldValue.serverTimestamp() });
          return 'decremented' as const;
        });

        if (outcome === 'decremented') {
          result.crossUserDecremented += 1;
          progressed = true;
        } else if (outcome === 'already-gone') {
          result.alreadyGone += 1;
          progressed = true;
        } else {
          result.errors.push(`content/${contentId}/participants/${uid}: ${outcome}, left untouched`);
        }
      } catch (error) {
        result.errors.push(`content/${contentId}/participants/${uid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!progressed) {
      result.errors.push('Activity participation cleanup stalled on remaining items — stopped rather than loop or corrupt another user\'s counter.');
      break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Own authored content (Posts/Activities/Events) — subcollections first
// (every possible one; a Post simply has none of participants/responses,
// which just costs one empty read), then the parent document.
// ---------------------------------------------------------------------------

async function deleteOwnContent(db: Firestore, uid: string): Promise<{ deleted: number }> {
  let deleted = 0;
  for (;;) {
    const snap = await db.collection('content').where('authorUid', '==', uid).limit(OWNED_DOC_PAGE_SIZE).get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      const contentId = docSnap.id;
      await drainCollection(db, `content/${contentId}/likes`);
      await drainCollection(db, `content/${contentId}/comments`);
      await drainCollection(db, `content/${contentId}/participants`);
      await drainCollection(db, `content/${contentId}/responses`);
      await db.doc(`content/${contentId}/stats/activity`).delete().catch(() => undefined);
      await docSnap.ref.delete();
      deleted += 1;
    }
  }
  return { deleted };
}

// ---------------------------------------------------------------------------
// Own Reels — subcollections, then the exact-path Storage object (never a
// prefix/recursive delete), then the Firestore doc. Covers both
// still-"uploading" drafts and "published" Reels through the same
// authoritative path, unlike the client-only discardReelDraft().
// ---------------------------------------------------------------------------

async function deleteOwnReels(
  db: Firestore,
  uid: string
): Promise<{ deleted: number; storageDeleted: number; storageAlreadyMissing: number }> {
  const bucket = getStorage().bucket();
  let deleted = 0;
  let storageDeleted = 0;
  let storageAlreadyMissing = 0;

  for (;;) {
    const snap = await db.collection('reels').where('authorUid', '==', uid).limit(OWNED_DOC_PAGE_SIZE).get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      const reelId = docSnap.id;
      const storagePath = docSnap.data()?.storagePath as string | undefined;

      await drainCollection(db, `reels/${reelId}/likes`);
      await drainCollection(db, `reels/${reelId}/comments`);

      if (storagePath) {
        const file = bucket.file(storagePath);
        const [existedBefore] = await file.exists();
        await file.delete({ ignoreNotFound: true });
        if (existedBefore) storageDeleted += 1;
        else storageAlreadyMissing += 1;
      }

      await docSnap.ref.delete();
      deleted += 1;
    }
  }

  return { deleted, storageDeleted, storageAlreadyMissing };
}

// ---------------------------------------------------------------------------
// Profile documents — dependency order matters: users/{uid} is read for
// usernameLower right up until it is the LAST document removed of any kind.
// ---------------------------------------------------------------------------

async function deleteProfileDocuments(db: Firestore, uid: string) {
  const result = {
    privacySettingsDeleted: false,
    publicProfileDeleted: false,
    usernameReservationDeleted: false,
    usernameReservationMismatch: false,
    userDocDeleted: false,
  };

  await db.doc(`privacySettings/${uid}`).delete().catch(() => undefined);
  result.privacySettingsDeleted = true;

  await db.doc(`publicProfiles/${uid}`).delete().catch(() => undefined);
  result.publicProfileDeleted = true;

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (userSnap.exists) {
    const usernameLower = userSnap.data()?.usernameLower as string | undefined;
    if (typeof usernameLower === 'string') {
      const reservationRef = db.doc(`usernames/${usernameLower}`);
      const reservationSnap = await reservationRef.get();
      if (reservationSnap.exists) {
        if (reservationSnap.data()?.uid === uid) {
          await reservationRef.delete();
          result.usernameReservationDeleted = true;
        } else {
          // Data corruption, not a normal case: the reservation this
          // profile claims as its own actually points at someone else.
          // Leave it untouched rather than delete another uid's reservation.
          result.usernameReservationMismatch = true;
        }
      }
    }
    await userRef.delete();
    result.userDocDeleted = true;
  }

  return result;
}

// ---------------------------------------------------------------------------
// The callable itself.
// ---------------------------------------------------------------------------

export const deleteMyAccountData = onCall({ region: REGION, timeoutSeconds: 300, memory: '256MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  // The ONLY source of truth for whose data this deletes. request.data is
  // never consulted for identity — see file header.
  const uid = request.auth.uid;
  const db = getFirestore();

  const followerOf = await drainQuery(db, () => db.collection('follows').where('followerUid', '==', uid));
  const followingOf = await drainQuery(db, () => db.collection('follows').where('followingUid', '==', uid));
  const blockerOf = await drainQuery(db, () => db.collection('blocks').where('blockerUid', '==', uid));
  const blockedOf = await drainQuery(db, () => db.collection('blocks').where('blockedUid', '==', uid));

  // No counter is paired with likes/comments/responses (see firestore.rules
  // — like/comment counts are aggregation queries, and Event responses have
  // no stored count at all), so these are plain deletes across both content
  // and reels roots at once — see Step 34.1's proven collectionGroup finding.
  const crossUserLikes = await drainQuery(db, () => db.collectionGroup('likes').where('uid', '==', uid));
  const crossUserComments = await drainQuery(db, () => db.collectionGroup('comments').where('authorUid', '==', uid));
  const crossUserResponses = await drainQuery(db, () => db.collectionGroup('responses').where('uid', '==', uid));
  const crossUserParticipants = await cleanupCrossUserParticipants(db, uid);

  const ownContent = await deleteOwnContent(db, uid);
  const ownReels = await deleteOwnReels(db, uid);

  // The backend also cleans the underlying actions itself (above), so it
  // doesn't need the client-rules "paired action" pairing constraint —
  // both directions are simply removed directly.
  const notifRecipient = await drainQuery(db, () => db.collection('notifications').where('recipientUid', '==', uid));
  const notifActor = await drainQuery(db, () => db.collection('notifications').where('actorUid', '==', uid));

  const profile = await deleteProfileDocuments(db, uid);

  return {
    uid,
    follows: { asFollowerRemoved: followerOf.total, asFollowingRemoved: followingOf.total },
    blocks: { asBlockerRemoved: blockerOf.total, asBlockedRemoved: blockedOf.total },
    crossUser: {
      likesRemoved: crossUserLikes.total,
      likesRemovedByRoot: crossUserLikes.roots,
      commentsRemoved: crossUserComments.total,
      commentsRemovedByRoot: crossUserComments.roots,
      eventResponsesRemoved: crossUserResponses.total,
      activityParticipation: crossUserParticipants,
    },
    ownContentDeleted: ownContent.deleted,
    ownReels,
    notifications: { asRecipientRemoved: notifRecipient.total, asActorRemoved: notifActor.total },
    // Locked policy: never deleted, never mutated, never inspected beyond
    // this fixed literal — no counts, no bodies, no reasons ever leave here.
    conversations: 'retained',
    reports: 'retained',
    profile,
    authAccountDeleted: false,
  };
});
