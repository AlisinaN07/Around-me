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
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

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
// postLikes/{likeId} (Step 41.2H.1) paired trusted cleanup (Step 41.2H.2).
//
// Admin SDK writes BYPASS Firestore Rules entirely — the atomic
// create/delete pairing between a postLikes row and its real per-target
// Like (reels/{id}/likes/{uid} or content/{id}/likes/{uid}) that
// firestore.rules enforces for ordinary client writes is NOT automatically
// preserved here. A naive "drain postLikes, then separately drain likes"
// (in either order) would leave a real transient window where one half of
// a pair exists without the other — exactly the inconsistency this
// primitive exists to avoid. Both functions below always delete a
// postLikes row and its paired real Like in the SAME Admin batch.
//
// Neither function assumes every real Like has a postLikes row — a
// generic `drainCollection(...likes...)` (self-likes, Event/Activity
// Likes, and — until Step 41.2H.3's backfill runs — historical Likes
// predating this relationship model) still runs afterward at every call
// site below to remove whatever these paired passes don't cover.
// ---------------------------------------------------------------------------

function likeDocPath(targetType: 'reel' | 'post', targetId: string, likerUid: string): string {
  return targetType === 'reel' ? `reels/${targetId}/likes/${likerUid}` : `content/${targetId}/likes/${likerUid}`;
}

/**
 * Removes every postLikes relationship pointing at one exact target
 * (a single Reel or a single legacy text Post), pairing each removal with
 * its real per-target Like in the same batch. Bounded/paginated exactly
 * like drainQuery — never an unlimited scan, and the query's two equality
 * filters (targetType + targetId) mean it can never touch a postLikes row
 * for any other target.
 */
async function drainPairedPostLikesForTarget(db: Firestore, targetType: 'reel' | 'post', targetId: string): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await db
      .collection('postLikes')
      .where('targetType', '==', targetType)
      .where('targetId', '==', targetId)
      .limit(BATCH_DELETE_SIZE)
      .get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const docSnap of snap.docs) {
      const likerUid = docSnap.data().likerUid as string;
      batch.delete(docSnap.ref);
      batch.delete(db.doc(likeDocPath(targetType, targetId, likerUid)));
    }
    await batch.commit();
    total += snap.size;
  }
  return total;
}

/**
 * Removes every postLikes relationship one account GAVE (as the liker),
 * across every target, pairing each removal with the corresponding real
 * per-target Like in the same batch. Bounded/paginated the same way.
 */
async function drainPairedPostLikesForLiker(db: Firestore, likerUid: string): Promise<number> {
  let total = 0;
  for (;;) {
    const snap = await db.collection('postLikes').where('likerUid', '==', likerUid).limit(BATCH_DELETE_SIZE).get();
    if (snap.empty) break;
    const batch = db.batch();
    for (const docSnap of snap.docs) {
      const data = docSnap.data() as { targetType: 'reel' | 'post'; targetId: string };
      batch.delete(docSnap.ref);
      batch.delete(db.doc(likeDocPath(data.targetType, data.targetId, likerUid)));
    }
    await batch.commit();
    total += snap.size;
  }
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
//
// deleteContentDocumentAndSubcollections is the shared per-document
// primitive: deleteMyAccountData calls it once per document an author owns
// (below), and Step 39.1's removeReportedContent calls it exactly once for
// a single moderator-named contentId. Sharing this primitive is safe
// because it never queries "everything this author owns" itself — the
// caller always supplies one exact contentId — so reusing it cannot widen
// moderation's scope beyond the one target a report actually named.
// ---------------------------------------------------------------------------

/**
 * Step 41.2H.2.1 — whether a target's RECEIVED postLikes should be removed
 * along with the target, or left standing as historical earned-Like
 * relationships. Required explicitly at every call site (no default) so
 * intent is never ambiguous:
 *
 *   'preserve' — voluntary author self-delete (deleteMyContent/deleteMyReel).
 *                Liked is a lifetime-earned reputation value; deleting your
 *                own Post must not erase Likes it already earned. The real
 *                nested Like docs still disappear with the target (a Like
 *                on a Post that no longer exists can't be un-liked through
 *                the normal UI either way) — only the normalized
 *                postLikes row, which represents the credit itself,
 *                survives, now referencing a target that no longer exists.
 *                That is intentional, not an orphan bug (see the README).
 *
 *   'remove'   — moderation (removeReportedContent/removeReportedReel) and
 *                an author's own account deletion (deleteOwnContent/
 *                deleteOwnReels, via deleteMyAccountData). Moderated
 *                content was never legitimately earned reputation to begin
 *                with, and a deleted account has no Profile left for a
 *                lifetime value to belong to — so received postLikes are
 *                removed in both cases, exactly like Step 41.2H.2's
 *                original behavior.
 */
type ReceivedPostLikesPolicy = 'preserve' | 'remove';

async function deleteContentDocumentAndSubcollections(
  db: Firestore,
  contentId: string,
  receivedPostLikesPolicy: ReceivedPostLikesPolicy
): Promise<void> {
  // Step 41.2H.2 — postLikes/{likeId} only ever exists for a legacy text
  // Post (never Event/Activity — see firestore.rules' isValidPostLikeCreate,
  // which requires content.type == 'post'). One read of the content doc's
  // own type is enough to skip running a provably-empty query for every
  // other type — cheaper than always attempting it, and reuses the exact
  // same read this function needs regardless (see below). When the paired
  // cleanup does run, it runs BEFORE the residual drainCollection just
  // after it, so whatever real Likes it doesn't cover (self-likes, or
  // historical Likes predating Step 41.2H.1) are still removed by that
  // generic pass either way.
  const contentSnap = await db.doc(`content/${contentId}`).get();
  const contentType = contentSnap.exists ? (contentSnap.data()?.type as string | undefined) : undefined;
  if (contentType === 'post' && receivedPostLikesPolicy === 'remove') {
    await drainPairedPostLikesForTarget(db, 'post', contentId);
  }

  await drainCollection(db, `content/${contentId}/likes`);
  await drainCollection(db, `content/${contentId}/comments`);
  await drainCollection(db, `content/${contentId}/participants`);
  await drainCollection(db, `content/${contentId}/responses`);
  await db.doc(`content/${contentId}/stats/activity`).delete().catch(() => undefined);
  // reposts/{repostId} (Step 41.2F) is a public ROOT collection, not a
  // subcollection of content/{contentId} — but any Repost pointing at this
  // exact contentId is now pointing at nothing, so it's cleaned up here too.
  // A compound-equality query (targetType == 'post' && targetId ==
  // contentId) needs no composite index — Firestore serves any number of
  // pure equality filters from its automatic single-field indexes — and is
  // bounded to exactly the reposts of this one document, never a broader
  // scan. Sharing this in the one primitive both deleteMyContent and
  // removeReportedContent already call means it also runs for free
  // whenever deleteOwnContent (called from deleteMyAccountData) deletes an
  // author's own content — covering "reposts OF their authored Posts"
  // without a separate targetAuthorUid query.
  await drainQuery(db, () => db.collection('reposts').where('targetType', '==', 'post').where('targetId', '==', contentId));
  await db.doc(`content/${contentId}`).delete();
}

async function deleteOwnContent(db: Firestore, uid: string): Promise<{ deleted: number }> {
  let deleted = 0;
  for (;;) {
    const snap = await db.collection('content').where('authorUid', '==', uid).limit(OWNED_DOC_PAGE_SIZE).get();
    if (snap.empty) break;
    for (const docSnap of snap.docs) {
      // Step 41.2H.2.1 — this is the author's own ACCOUNT being deleted;
      // their Profile is going away entirely, so there is no lifetime
      // value left to preserve credit for.
      await deleteContentDocumentAndSubcollections(db, docSnap.id, 'remove');
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
//
// deleteReelDocumentAndSubcollections is the shared per-document primitive
// — same sharing rationale as deleteContentDocumentAndSubcollections above.
// storagePath is always the caller's choice, never re-derived here, so a
// caller that only has a reelId/authorUid pair (no Firestore doc left to
// read a stored path from) must build the canonical path itself; see
// removeReportedReel's storage-retry branch.
// ---------------------------------------------------------------------------

async function deleteReelDocumentAndSubcollections(
  db: Firestore,
  bucket: ReturnType<ReturnType<typeof getStorage>['bucket']>,
  reelId: string,
  storagePath: string | undefined,
  receivedPostLikesPolicy: ReceivedPostLikesPolicy
): Promise<{ storageDeleted: boolean }> {
  // Step 41.2H.2 — every Reel is inherently a social Post (no Event/
  // Activity equivalent exists for Reels), so this paired cleanup runs
  // whenever the caller asks to actually remove received credit (see
  // ReceivedPostLikesPolicy's own doc comment), before the residual
  // drainCollection just after it (which still removes self-likes and any
  // historical Likes predating Step 41.2H.1 either way).
  if (receivedPostLikesPolicy === 'remove') {
    await drainPairedPostLikesForTarget(db, 'reel', reelId);
  }

  await drainCollection(db, `reels/${reelId}/likes`);
  await drainCollection(db, `reels/${reelId}/comments`);
  // Same reasoning as deleteContentDocumentAndSubcollections's repost
  // cleanup above — a compound-equality query, no composite index, bounded
  // to exactly the reposts of this one Reel.
  await drainQuery(db, () => db.collection('reposts').where('targetType', '==', 'reel').where('targetId', '==', reelId));

  let storageDeleted = false;
  if (storagePath) {
    const file = bucket.file(storagePath);
    const [existedBefore] = await file.exists();
    await file.delete({ ignoreNotFound: true });
    storageDeleted = existedBefore;
  }

  await db.doc(`reels/${reelId}`).delete();
  return { storageDeleted };
}

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
      const storagePath = docSnap.data()?.storagePath as string | undefined;
      // Step 41.2H.2.1 — same reasoning as deleteOwnContent's own call
      // site: the author's account is going away entirely.
      const result = await deleteReelDocumentAndSubcollections(db, bucket, docSnap.id, storagePath, 'remove');
      if (storagePath) {
        if (result.storageDeleted) storageDeleted += 1;
        else storageAlreadyMissing += 1;
      }
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
    savedRelationshipsDeleted: 0,
    userDocDeleted: false,
  };

  await db.doc(`privacySettings/${uid}`).delete().catch(() => undefined);
  result.privacySettingsDeleted = true;

  await db.doc(`publicProfiles/${uid}`).delete().catch(() => undefined);
  result.publicProfileDeleted = true;

  // users/{uid}/saved (Step 41.2E) — a subcollection, which Firestore never
  // cascade-deletes with its parent document, so it must be drained
  // explicitly before users/{uid} itself is removed below. Private to the
  // owner and never referenced from anywhere else, so a plain bounded
  // drainCollection (no cross-user counter, no notification pairing) is
  // all this needs — same primitive already used for every other owned
  // subcollection in this file.
  result.savedRelationshipsDeleted = await drainCollection(db, `users/${uid}/saved`);

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
  // reposts/{repostId} this account itself created (Step 41.2F) — a public
  // ROOT collection, so unlike Saved it isn't reached by deleteProfileDocuments'
  // users/{uid} subtree cleanup. Reposts OF this account's own authored
  // Posts/Reels are handled separately, for free, inside
  // deleteContentDocumentAndSubcollections/deleteReelDocumentAndSubcollections
  // as deleteOwnContent/deleteOwnReels run below.
  const ownRepostsOf = await drainQuery(db, () => db.collection('reposts').where('userUid', '==', uid));

  // Step 41.2H.2 — this account's own outgoing postLikes (Likes it GAVE to
  // other people's Posts/Reels), each paired with its real per-target Like
  // in the same Admin batch — see drainPairedPostLikesForLiker's own doc
  // comment for why Admin SDK writes must preserve that pairing themselves
  // (Admin SDK bypasses Rules). Runs BEFORE the crossUserLikes residual
  // drain just below, which then only has to clean up what this pass
  // doesn't cover: Event/Activity Likes, self-likes, and (pre-Step-41.2H.3
  // backfill) historical Likes with no postLikes row.
  const ownOutgoingPostLikes = await drainPairedPostLikesForLiker(db, uid);

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
    ownRepostsRemoved: ownRepostsOf.total,
    ownOutgoingPostLikesRemoved: ownOutgoingPostLikes,
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

// ---------------------------------------------------------------------------
// Step 41.2G — Profile Activities (Events a profile owner marked
// Interested/Going). NOT an admin/moderation callable — any signed-in user
// may call this for any profileUid, exactly the same floor
// firestore.rules already sets for content/{eventId}/responses/{uid}
// itself ("allow read: if isSignedIn() && ..."). This exists as a trusted
// backend call ONLY because collectionGroup() queries are denied outright
// to client SDK callers in this Firebase project regardless of Rules
// content (see README's "Event card interaction state", Step 26.1) — the
// Admin SDK has no such restriction (already relied on by
// deleteMyAccountData's own collectionGroup cross-user cleanup above).
// This callable grants no privilege beyond what firestore.rules already
// permits a real client to read one document at a time; it just runs the
// one query type clients here structurally cannot run themselves.
// ---------------------------------------------------------------------------

const PROFILE_ACTIVITIES_LIMIT = 50;

export const fetchProfileActivities = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const profileUid = request.data?.profileUid;
  if (typeof profileUid !== 'string' || profileUid.length === 0) {
    throw new HttpsError('invalid-argument', 'profileUid is required.');
  }

  const db = getFirestore();
  const snap = await db.collectionGroup('responses').where('uid', '==', profileUid).limit(PROFILE_ACTIVITIES_LIMIT).get();

  const activities: { event: Record<string, unknown>; responseStatus: string }[] = [];
  for (const responseDoc of snap.docs) {
    const responseData = responseDoc.data();
    // content/{eventId}/responses/{uid} — the response doc's own parent
    // document is always the exact Event it belongs to, so this never
    // queries the whole content collection per response.
    const eventId = responseDoc.ref.parent.parent?.id;
    if (!eventId) continue;

    const eventSnap = await db.doc(`content/${eventId}`).get();
    if (!eventSnap.exists) continue;
    const event = eventSnap.data()!;
    if (event.type !== 'event' || event.status !== 'published') continue;
    // Defensive exclusion (Section 29): a Business account should never
    // see its own authored Event doubled into its own Activities tab.
    if (event.authorUid === profileUid) continue;

    activities.push({
      event: {
        contentId: eventId,
        authorUid: event.authorUid,
        authorDisplayName: event.authorDisplayName,
        authorUsername: event.authorUsername,
        cityName: event.cityName,
        countryCode: event.countryCode,
        cityKey: event.cityKey,
        categoryId: event.categoryId,
        status: event.status,
        visibility: event.visibility,
        placeId: event.placeId,
        type: 'event',
        title: event.title,
        description: event.description,
        placeName: event.placeName,
        // Serialized as epoch milliseconds, not raw Timestamp objects —
        // see src/services/profileActivities.ts's own doc comment for why
        // the client reconstructs real Timestamps from these explicitly
        // rather than relying on callable-transport auto-marshalling.
        startsAt: (event.startsAt as FirebaseFirestore.Timestamp).toMillis(),
        endsAt: (event.endsAt as FirebaseFirestore.Timestamp).toMillis(),
        createdAt: (event.createdAt as FirebaseFirestore.Timestamp).toMillis(),
        updatedAt: (event.updatedAt as FirebaseFirestore.Timestamp).toMillis(),
      },
      responseStatus: responseData.status as string,
    });
  }

  return { activities };
});

// ---------------------------------------------------------------------------
// Step 39.1 — moderation authorization foundation.
//
// Admin identity is a Firebase Auth custom claim (admin: true), set only by
// a trusted operator via the Admin SDK — never by any client write, never
// derived from accountType (Personal/Business is unrelated and stays
// locked), and never a hardcoded uid. requireAdmin is the single choke
// point every moderation callable must call first; it trusts nothing from
// request.data for authorization, only the verified ID token's own claim.
//
// reports/{reportId}'s Firestore Rules keep "allow update: if false" for
// every client, including an admin-claimed one (see firestore.rules) — a
// claim only authorizes trusted Functions in v1, never a direct client
// write, so every moderation action lives here, reading/writing via the
// Admin SDK, which bypasses Rules through IAM rather than through them.
// ---------------------------------------------------------------------------

function requireAdmin(request: CallableRequest): void {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin privileges required.');
  }
}

const MAX_REPORT_ID_LENGTH = 300;

/** Shared by every moderation callable — input is always exactly `{ reportId }`. */
function parseReportId(request: CallableRequest): string {
  const reportId = request.data?.reportId;
  if (typeof reportId !== 'string' || reportId.length === 0 || reportId.length > MAX_REPORT_ID_LENGTH) {
    throw new HttpsError('invalid-argument', 'reportId must be a non-empty string.');
  }
  return reportId;
}

/**
 * Marks one report dismissed — the only moderation action this step ships.
 * Removal/ban/suspend callables are explicitly out of scope (Step 39.2+).
 *
 * Input is exactly { reportId }: no report object, no reporterUid/targetUid,
 * no moderatedByUid, no isAdmin — every one of those is derived server-side
 * (moderatedByUid from request.auth.uid) or read from the existing document,
 * never accepted from the caller.
 *
 * Reports created before this step have no status/moderatedAt/
 * moderatedByUid fields at all; a missing status is treated as 'open' here
 * without ever writing that default back onto the document except as part
 * of a genuine dismiss.
 */
export const dismissReport = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const reportId = parseReportId(request);

  const db = getFirestore();
  const reportRef = db.doc(`reports/${reportId}`);
  const adminUid = request.auth!.uid;

  const outcome = await db.runTransaction(async (tx) => {
    const snap = await tx.get(reportRef);
    if (!snap.exists) return 'not-found' as const;
    const status = (snap.data()?.status as string | undefined) ?? 'open';
    if (status === 'resolved') return 'already-resolved' as const;
    if (status === 'dismissed') return 'already-dismissed' as const;
    tx.update(reportRef, {
      status: 'dismissed',
      moderatedAt: FieldValue.serverTimestamp(),
      moderatedByUid: adminUid,
    });
    return 'dismissed' as const;
  });

  if (outcome === 'not-found') {
    throw new HttpsError('not-found', 'No report with that ID exists.');
  }
  if (outcome === 'already-resolved') {
    throw new HttpsError('failed-precondition', 'This report was already resolved and cannot be dismissed.');
  }

  return {
    status: 'dismissed' as const,
    reportId,
    alreadyDismissed: outcome === 'already-dismissed',
  };
});

// ---------------------------------------------------------------------------
// Step 39.2 — trusted removal of reported public content (Post/Activity/
// Event/Reel). Report CAPTURE, moderation STATUS (39.1), and moderation
// ACTION (this) stay three separate concerns: these two callables are the
// only code in this app that can delete someone else's published content,
// and they may only ever act on the exact single target a report already
// named — never an author's other content, never a client-supplied id.
//
// Both callables:
//   1. requireAdmin(request) first — same choke point as dismissReport.
//   2. Accept ONLY { reportId }. The target id is read from the TRUSTED
//      reports/{reportId} document via the Admin SDK, never from
//      request.data — so a client can never redirect a report about one
//      target into deleting a different one by adding an extra field.
//   3. Validate report.targetType matches the callable, and normalize a
//      missing status to 'open' (same as dismissReport, for reports
//      created before Step 39.1).
//   4. dismissed -> failed-precondition, target untouched. resolved ->
//      idempotent short-circuit (no re-check, no re-delete, no new
//      moderatedAt) — a resolved content/reel report can only have
//      reached that state via this exact code path already having
//      finished once.
//   5. Only after the target (and its subcollections/Storage) are
//      confirmed gone does the report become resolved. If any step
//      throws, the report is left 'open' — every deletion primitive
//      here (drainCollection, delete-if-exists, Storage
//      ignoreNotFound) is already idempotent, so a retry safely resumes
//      wherever the previous attempt stopped.
// ---------------------------------------------------------------------------

function reportStatusOf(data: FirebaseFirestore.DocumentData): string {
  return (data.status as string | undefined) ?? 'open';
}

async function loadReportOrThrow(db: Firestore, reportId: string): Promise<FirebaseFirestore.DocumentData> {
  const snap = await db.doc(`reports/${reportId}`).get();
  if (!snap.exists) {
    throw new HttpsError('not-found', 'No report with that ID exists.');
  }
  return snap.data()!;
}

async function resolveReport(db: Firestore, reportId: string, adminUid: string): Promise<void> {
  await db.doc(`reports/${reportId}`).update({
    status: 'resolved',
    moderatedAt: FieldValue.serverTimestamp(),
    moderatedByUid: adminUid,
  });
}

/** contentId/reelId are plain equality filters — Firestore auto-indexes single-field equality, so this needs no composite index. */
async function drainNotificationsByField(db: Firestore, field: 'contentId' | 'reelId', value: string): Promise<number> {
  const { total } = await drainQuery(db, () => db.collection('notifications').where(field, '==', value));
  return total;
}

/**
 * Removes a reported Post/Activity/Event and its subcollections
 * (likes/comments/participants/responses/stats — all four are drained
 * unconditionally regardless of which of the three content types this
 * actually is, exactly like deleteContentDocumentAndSubcollections already
 * does for account deletion; an absent subcollection just costs one empty
 * read) plus every notification referencing it. Never touches any other
 * content the same author owns.
 */
export const removeReportedContent = onCall({ region: REGION, timeoutSeconds: 300, memory: '256MiB' }, async (request) => {
  requireAdmin(request);
  const reportId = parseReportId(request);
  const adminUid = request.auth!.uid;

  const db = getFirestore();
  const report = await loadReportOrThrow(db, reportId);
  if (report.targetType !== 'content') {
    throw new HttpsError('failed-precondition', 'This report is not a content report.');
  }
  const contentId = report.contentId as string | undefined;
  if (typeof contentId !== 'string' || contentId.length === 0) {
    throw new HttpsError('failed-precondition', 'This report has no valid content target.');
  }

  const status = reportStatusOf(report);
  if (status === 'dismissed') {
    throw new HttpsError('failed-precondition', 'This report has been dismissed and cannot be used for removal.');
  }
  if (status === 'resolved') {
    return {
      reportId,
      status: 'resolved' as const,
      targetType: 'content' as const,
      removed: true,
      targetAlreadyMissing: false,
      alreadyResolved: true,
    };
  }

  const contentSnap = await db.doc(`content/${contentId}`).get();
  const targetAlreadyMissing = !contentSnap.exists;
  if (contentSnap.exists) {
    // Step 41.2H.2.1 — moderation removal, unlike voluntary self-delete,
    // never earned legitimate reputation credit to begin with.
    await deleteContentDocumentAndSubcollections(db, contentId, 'remove');
  }
  await drainNotificationsByField(db, 'contentId', contentId);
  await resolveReport(db, reportId, adminUid);

  return {
    reportId,
    status: 'resolved' as const,
    targetType: 'content' as const,
    removed: true,
    targetAlreadyMissing,
  };
});

/**
 * Removes a reported Reel: its subcollections, its exact Storage source
 * object, the Firestore document, and every notification referencing it.
 *
 * If the Firestore doc is already gone (e.g. a prior attempt deleted it
 * but failed before Storage cleanup), the canonical Storage path is
 * re-derived from the REPORT's own targetUid + reelId rather than given up
 * on — isValidReelReport (firestore.rules) pins targetUid to the Reel's
 * real authorUid at report-creation time, and authorUid is never mutated
 * afterward, so `reels/{targetUid}/{reelId}/source` is exactly the same
 * canonical path reelStoragePath() derives client-side
 * (src/services/reels.ts). This is what makes a Storage-only retry safe
 * without trusting anything from the request itself.
 */
export const removeReportedReel = onCall({ region: REGION, timeoutSeconds: 300, memory: '256MiB' }, async (request) => {
  requireAdmin(request);
  const reportId = parseReportId(request);
  const adminUid = request.auth!.uid;

  const db = getFirestore();
  const report = await loadReportOrThrow(db, reportId);
  if (report.targetType !== 'reel') {
    throw new HttpsError('failed-precondition', 'This report is not a Reel report.');
  }
  const reelId = report.reelId as string | undefined;
  const reportedAuthorUid = report.targetUid as string | undefined;
  if (typeof reelId !== 'string' || reelId.length === 0 || typeof reportedAuthorUid !== 'string' || reportedAuthorUid.length === 0) {
    throw new HttpsError('failed-precondition', 'This report has no valid Reel target.');
  }

  const status = reportStatusOf(report);
  if (status === 'dismissed') {
    throw new HttpsError('failed-precondition', 'This report has been dismissed and cannot be used for removal.');
  }
  if (status === 'resolved') {
    return {
      reportId,
      status: 'resolved' as const,
      targetType: 'reel' as const,
      removed: true,
      targetAlreadyMissing: false,
      alreadyResolved: true,
    };
  }

  const bucket = getStorage().bucket();
  const reelDocRef = db.doc(`reels/${reelId}`);
  const reelSnap = await reelDocRef.get();
  const targetAlreadyMissing = !reelSnap.exists;

  if (reelSnap.exists) {
    const storagePath = reelSnap.data()?.storagePath as string | undefined;
    // Step 41.2H.2.1 — moderation removal never earned legitimate
    // reputation credit to begin with.
    await deleteReelDocumentAndSubcollections(db, bucket, reelId, storagePath, 'remove');
  } else {
    const inferredStoragePath = `reels/${reportedAuthorUid}/${reelId}/source`;
    await bucket.file(inferredStoragePath).delete({ ignoreNotFound: true });
  }

  await drainNotificationsByField(db, 'reelId', reelId);
  await resolveReport(db, reportId, adminUid);

  return {
    reportId,
    status: 'resolved' as const,
    targetType: 'reel' as const,
    removed: true,
    targetAlreadyMissing,
  };
});

// ---------------------------------------------------------------------------
// Step 39.3 — narrow reported-message review and removal.
//
// This is deliberately the narrowest possible privileged DM access: ONE
// reportId names ONE message, and that is the only message either callable
// can ever read or delete. There is no conversation browsing, no
// surrounding-message access, no generic "read any message" or "delete any
// message" endpoint — conversationId/messageId always come from the
// trusted reports/{reportId} document (validated at report-creation time
// by isValidMessageReport in firestore.rules: reporter was a participant,
// the message existed, and targetUid was pinned to the real sender —
// see src/services/reports.ts's reportMessage), never from request.data.
//
// Reports still store zero message content (see src/types/report.ts) — the
// review callable fetches the LIVE message only at the moment an
// authorized admin explicitly asks to review that one report, and nothing
// is ever copied back into the report document.
// ---------------------------------------------------------------------------

async function requireValidMessageReport(
  db: Firestore,
  reportId: string
): Promise<{ report: FirebaseFirestore.DocumentData; conversationId: string; messageId: string }> {
  const report = await loadReportOrThrow(db, reportId);
  if (report.targetType !== 'message') {
    throw new HttpsError('failed-precondition', 'This report is not a message report.');
  }
  const conversationId = report.conversationId as string | undefined;
  const messageId = report.messageId as string | undefined;
  if (typeof conversationId !== 'string' || conversationId.length === 0 || typeof messageId !== 'string' || messageId.length === 0) {
    throw new HttpsError('failed-precondition', 'This report has no valid message target.');
  }
  return { report, conversationId, messageId };
}

/**
 * Lets an admin see exactly the one message a report named, plus why it
 * was reported — nothing else. No status gate: this is a read with no
 * side effects, so it's allowed regardless of open/dismissed/resolved
 * (an admin reviewing moderation history is a legitimate, safe use of a
 * read-only action; gating it on status would only complicate this
 * without adding any real protection).
 *
 * Never returns reporterUid — the admin can see what was reported and why
 * without learning who reported it, matching the same reporter-privacy
 * guarantee normal report reads already have.
 */
export const getReportedMessageForReview = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const reportId = parseReportId(request);

  const db = getFirestore();
  const { report, conversationId, messageId } = await requireValidMessageReport(db, reportId);
  const status = reportStatusOf(report);

  const messageSnap = await db.doc(`conversations/${conversationId}/messages/${messageId}`).get();
  if (!messageSnap.exists) {
    return { reportId, status, messageMissing: true as const };
  }
  const message = messageSnap.data()!;

  return {
    reportId,
    status,
    report: {
      reason: report.reason as string,
      details: (report.details as string | null) ?? null,
    },
    message: {
      messageId,
      senderUid: message.senderUid as string,
      body: message.body as string,
      createdAt: message.createdAt as FirebaseFirestore.Timestamp,
    },
  };
});

/**
 * Deletes exactly the one message a report named. Never touches the
 * conversation itself beyond the exact preview repair below, any other
 * message, or any other conversation.
 *
 * Conversation preview repair: conversations/{conversationId} denormalizes
 * lastMessageId/lastMessageText/lastMessageSenderUid/lastMessageAt (see
 * src/types/message.ts) so the Inbox never has to query every
 * conversation's messages just to render a preview. If the removed
 * message was the CURRENT lastMessageId, that preview is repaired from
 * the single newest surviving message (one bounded orderBy(createdAt,
 * desc).limit(1) query — never the full history). If no messages remain
 * at all, the Conversation document itself is deleted rather than left
 * with a stale preview: the type has no "empty" representation for
 * lastMessageText/lastMessageId (required strings, not nullable), so
 * there is no safe value to write that both satisfies the schema and
 * doesn't leave the moderated-away body sitting in the Inbox. Deleting
 * the document is safe specifically because sendMessage's own transaction
 * already creates a Conversation from scratch on a pair's very first
 * message — a future message between the same two users simply takes
 * that exact path again, and until then fetchConversations' query just
 * won't return a document that doesn't exist, identical to the "never
 * messaged" state the Inbox already renders correctly today.
 *
 * unreadCounts is a per-recipient SENT-message counter, not a count of
 * existing message documents (see sendMessage) — there is no way to
 * "correctly" decrement it for one deleted message without knowing
 * whether the recipient had already read it, so it is deliberately left
 * untouched when the conversation survives. The user's next visit to a
 * surviving conversation already resets their own count to 0 via
 * markConversationRead regardless, so any one-off overcount is bounded
 * and self-correcting; when the conversation is deleted outright (the
 * zero-survivor case above), unreadCounts is deleted along with it.
 */
export const removeReportedMessage = onCall({ region: REGION, timeoutSeconds: 300, memory: '256MiB' }, async (request) => {
  requireAdmin(request);
  const reportId = parseReportId(request);
  const adminUid = request.auth!.uid;

  const db = getFirestore();
  const { report, conversationId, messageId } = await requireValidMessageReport(db, reportId);
  const status = reportStatusOf(report);

  if (status === 'dismissed') {
    throw new HttpsError('failed-precondition', 'This report has been dismissed and cannot be used for removal.');
  }
  if (status === 'resolved') {
    return {
      reportId,
      status: 'resolved' as const,
      removed: true,
      targetAlreadyMissing: false,
      alreadyResolved: true,
    };
  }

  const messageRef = db.doc(`conversations/${conversationId}/messages/${messageId}`);
  const messageSnap = await messageRef.get();
  const targetAlreadyMissing = !messageSnap.exists;

  if (messageSnap.exists) {
    await messageRef.delete();

    const convRef = db.doc(`conversations/${conversationId}`);
    const convSnap = await convRef.get();
    if (convSnap.exists && convSnap.data()?.lastMessageId === messageId) {
      const newestSnap = await db
        .collection(`conversations/${conversationId}/messages`)
        .orderBy('createdAt', 'desc')
        .limit(1)
        .get();
      if (!newestSnap.empty) {
        const newest = newestSnap.docs[0].data();
        await convRef.update({
          lastMessageId: newest.messageId,
          lastMessageText: newest.body,
          lastMessageSenderUid: newest.senderUid,
          lastMessageAt: newest.createdAt,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } else {
        // No messages remain at all — the Conversation type has no
        // nullable/"empty" representation for lastMessageId/lastMessageText
        // (required strings), so there is no safe value to write that
        // doesn't either invent unsupported schema or leave the moderated
        // body sitting in the preview. Deleting the root instead is safe
        // and idiomatic: sendMessage's own transaction already creates a
        // Conversation from scratch on a pair's very first message (see
        // src/services/messages.ts) — a future message between these same
        // two users takes that exact path again, recreating the document
        // correctly. Until then, fetchConversations' participantUids query
        // simply won't return a document that doesn't exist, matching the
        // same "never messaged" state the Inbox already renders correctly
        // for any two users who haven't spoken yet.
        await convRef.delete();
      }
    }
  }

  await resolveReport(db, reportId, adminUid);

  return {
    reportId,
    status: 'resolved' as const,
    removed: true,
    targetAlreadyMissing,
  };
});

// ---------------------------------------------------------------------------
// Step 40.1 — author self-delete for Post/Activity/Event/Reel.
//
// This is NOT moderation. requireAdmin is never called here — authorization
// is exclusively "does request.auth.uid match the trusted target document's
// own authorUid," checked server-side against the Admin-SDK-loaded document,
// never against anything the client claims. A payload smuggling a
// different authorUid/contentId alongside the real target has zero effect,
// same reportId-only/contentId-only discipline as every other trusted
// callable in this file.
//
// Both callables reuse the exact same per-document cleanup primitives as
// moderation (deleteContentDocumentAndSubcollections /
// deleteReelDocumentAndSubcollections) and the same root-last ordering:
// the root document is what proves ownership, so it is only ever deleted
// once every subcollection/notification has been drained. If a call fails
// partway, the root still exists, so a retry re-proves ownership and
// safely resumes — every cleanup step is already idempotent. A second call
// after a genuinely successful deletion sees no root at all and gets
// 'not-found', which is the correct, honest outcome — there is nothing to
// re-authorize ownership against once the document is gone, so this
// deliberately does not fake idempotent success the way the moderation
// callables can (they still have the report document to key off of).
// ---------------------------------------------------------------------------

function parseContentIdParam(request: CallableRequest): string {
  const contentId = request.data?.contentId;
  if (typeof contentId !== 'string' || contentId.length === 0 || contentId.length > MAX_REPORT_ID_LENGTH) {
    throw new HttpsError('invalid-argument', 'contentId must be a non-empty string.');
  }
  return contentId;
}

function parseReelIdParam(request: CallableRequest): string {
  const reelId = request.data?.reelId;
  if (typeof reelId !== 'string' || reelId.length === 0 || reelId.length > MAX_REPORT_ID_LENGTH) {
    throw new HttpsError('invalid-argument', 'reelId must be a non-empty string.');
  }
  return reelId;
}

/**
 * Deletes exactly one Post/Activity/Event the caller authored. Never
 * touches any other document the same author owns — the target is the
 * one exact contentId given, nothing derived from an authorUid query.
 */
export const deleteMyContent = onCall({ region: REGION, timeoutSeconds: 300, memory: '256MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const contentId = parseContentIdParam(request);
  const uid = request.auth.uid;

  const db = getFirestore();
  const contentSnap = await db.doc(`content/${contentId}`).get();
  if (!contentSnap.exists) {
    throw new HttpsError('not-found', 'No content with that ID exists.');
  }
  const content = contentSnap.data()!;
  if (content.authorUid !== uid) {
    throw new HttpsError('permission-denied', 'You can only delete your own content.');
  }
  const type = content.type as string | undefined;
  if (type !== 'post' && type !== 'activity' && type !== 'event') {
    throw new HttpsError('failed-precondition', 'Unsupported content type.');
  }

  await drainNotificationsByField(db, 'contentId', contentId);
  // Step 41.2H.2.1 — voluntary author self-delete: Liked is a lifetime-
  // earned reputation value, so received postLikes on this Post survive
  // even though the Post itself, and its real nested Like docs, do not.
  await deleteContentDocumentAndSubcollections(db, contentId, 'preserve');

  return { contentId, type, deleted: true as const };
});

/**
 * Deletes exactly one Reel the caller authored — any status, published or
 * still "uploading" (this doesn't replace or narrow the existing
 * client-side discardReelDraft path for a still-uploading draft; it's just
 * an equally-valid, trusted way to remove a Reel the author owns
 * regardless of status, reusing the same per-document primitive
 * moderation already relies on).
 */
export const deleteMyReel = onCall({ region: REGION, timeoutSeconds: 300, memory: '256MiB' }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const reelId = parseReelIdParam(request);
  const uid = request.auth.uid;

  const db = getFirestore();
  const reelSnap = await db.doc(`reels/${reelId}`).get();
  if (!reelSnap.exists) {
    throw new HttpsError('not-found', 'No Reel with that ID exists.');
  }
  const reel = reelSnap.data()!;
  if (reel.authorUid !== uid) {
    throw new HttpsError('permission-denied', 'You can only delete your own Reel.');
  }

  const bucket = getStorage().bucket();
  const storagePath = reel.storagePath as string | undefined;

  await drainNotificationsByField(db, 'reelId', reelId);
  // Step 41.2H.2.1 — voluntary author self-delete: same reasoning as
  // deleteMyContent above — received postLikes survive.
  await deleteReelDocumentAndSubcollections(db, bucket, reelId, storagePath, 'preserve');

  return { reelId, deleted: true as const };
});
