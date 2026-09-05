/**
 * Step 34.1 — trusted-backend feasibility PROOF ONLY. This file does not
 * delete any user account or authored data. Its one export,
 * diagnoseAccountDeletionFeasibility, exists purely to answer, with real
 * evidence against the real production project, the open questions from
 * Step 34's read-only design audit:
 *
 *  - Can a trusted backend authenticate the caller safely, with the target
 *    uid coming ONLY from the callable's own auth context?
 *  - Can the Admin SDK do what Step 26.1 found the client SDK categorically
 *    could not (collectionGroup queries across content/{*}/likes,
 *    content/{*}/comments, content/{*}/responses, content/{*}/participants,
 *    reels/{*}/likes, reels/{*}/comments)?
 *  - Can the Admin SDK access/delete a published Reel's Storage object at
 *    its real deterministic path, which storage.rules blocks for every
 *    client (see storage.rules's own "no trusted media + Firestore
 *    cascade-deletion workflow yet" comment)?
 *
 * SECURITY: the target account is derived exclusively from
 * `request.auth.uid` (2nd-gen callable auth context, provided by Firebase
 * and unforgeable by the caller). `request.data` is never read for
 * identity purposes anywhere in this file — there is no `uid`/`targetUid`/
 * `userId` parameter of any kind. A caller can only ever see counts and
 * document paths for their OWN uid.
 *
 * This function only READS Firestore. Its only WRITE of any kind is one
 * tiny synthetic Storage object it creates and immediately deletes itself,
 * scoped under the caller's own uid, to prove Admin Storage access — see
 * runStorageAdminSelfTest below.
 */
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { HttpsError, onCall } from 'firebase-functions/v2/https';

initializeApp();

// europe-north1 (Finland) — the closest Cloud Functions 2nd-gen-supported
// region to this project's Firestore location, europe-north2 (Stockholm).
// Firebase's own "selecting regions based on Cloud Firestore location"
// guidance has no direct europe-north2 entry (confirmed by inspection of
// https://firebase.google.com/docs/functions/locations at design time —
// its one Nordic/Northern-Europe mapping example is eur3 -> europe-west1),
// so this falls back to genuine geographic proximity rather than that
// table's more distant example, since europe-north1 is an explicitly
// supported 2nd-gen region and sits far closer to Stockholm than any
// europe-west option.
const REGION = 'europe-north1';

type CollectionGroupCheck = {
  pass: boolean;
  count: number;
  paths: string[];
  error?: string;
};

async function checkCollectionGroupSplitByRoot(
  db: Firestore,
  groupName: string,
  field: 'uid' | 'authorUid',
  uid: string
): Promise<{ content: CollectionGroupCheck; reels: CollectionGroupCheck }> {
  const empty = (): CollectionGroupCheck => ({ pass: false, count: 0, paths: [] });
  const content = empty();
  const reels = empty();
  try {
    const snap = await db.collectionGroup(groupName).where(field, '==', uid).get();
    content.pass = true;
    reels.pass = true;
    for (const doc of snap.docs) {
      const root = doc.ref.path.split('/')[0];
      if (root === 'content') {
        content.count += 1;
        content.paths.push(doc.ref.path);
      } else if (root === 'reels') {
        reels.count += 1;
        reels.paths.push(doc.ref.path);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    content.error = message;
    reels.error = message;
  }
  return { content, reels };
}

async function checkCollectionGroupSingleRoot(
  db: Firestore,
  groupName: string,
  field: 'uid' | 'authorUid',
  uid: string
): Promise<CollectionGroupCheck> {
  try {
    const snap = await db.collectionGroup(groupName).where(field, '==', uid).get();
    return { pass: true, count: snap.size, paths: snap.docs.map((d) => d.ref.path) };
  } catch (error) {
    return { pass: false, count: 0, paths: [], error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Storage self-test — writes ONE tiny synthetic object at the exact
 * deterministic path scheme a real published Reel uses
 * (reels/{authorUid}/{reelId}/source, see src/services/reels.ts and
 * storage.rules), scoped under the caller's own uid with a
 * function-generated reelId (never client-supplied), then deletes it.
 * Proves Admin/IAM access to a path storage.rules explicitly denies every
 * client from deleting once status is 'published'. No real Reel or real
 * user's object is ever touched.
 */
async function runStorageAdminSelfTest(uid: string) {
  const diagnosticReelId = `diagnostic-${Date.now()}`;
  const path = `reels/${uid}/${diagnosticReelId}/source`;
  const bytes = Buffer.from('around-me step 34.1 storage admin feasibility proof', 'utf8');

  const result = {
    path,
    bytesWritten: bytes.byteLength,
    writeOk: false,
    existsAfterWrite: false,
    deleteOk: false,
    existsAfterDelete: true,
    error: undefined as string | undefined,
  };

  try {
    const bucket = getStorage().bucket();
    const file = bucket.file(path);
    await file.save(bytes, { contentType: 'text/plain', resumable: false });
    result.writeOk = true;

    const [existsAfterWrite] = await file.exists();
    result.existsAfterWrite = existsAfterWrite;

    await file.delete();
    result.deleteOk = true;

    const [existsAfterDelete] = await file.exists();
    result.existsAfterDelete = existsAfterDelete;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }

  return result;
}

export const diagnoseAccountDeletionFeasibility = onCall({ region: REGION }, async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  // The ONLY source of truth for "whose data" this function ever looks
  // at. request.data is never consulted for identity — see file header.
  const uid = request.auth.uid;

  const db = getFirestore();

  const [likes, comments, responses, participants] = await Promise.all([
    checkCollectionGroupSplitByRoot(db, 'likes', 'uid', uid),
    checkCollectionGroupSplitByRoot(db, 'comments', 'authorUid', uid),
    checkCollectionGroupSingleRoot(db, 'responses', 'uid', uid),
    checkCollectionGroupSingleRoot(db, 'participants', 'uid', uid),
  ]);

  // Section 11 — for every Activity participation found, confirm the
  // sibling stats/activity counter document is actually reachable from
  // the same parent, and report its current value. Read-only.
  const participantContentPairings = await Promise.all(
    participants.paths.map(async (participantPath) => {
      const contentId = participantPath.split('/')[1];
      const statsSnap = await db.doc(`content/${contentId}/stats/activity`).get();
      return {
        contentId,
        statsExists: statsSnap.exists,
        participantCount: statsSnap.exists ? (statsSnap.data()?.participantCount ?? null) : null,
      };
    })
  );

  const [ownContent, ownReels] = await Promise.all([
    db.collection('content').where('authorUid', '==', uid).get(),
    db.collection('reels').where('authorUid', '==', uid).get(),
  ]);

  const [followerOf, followingOf, blockerOf, blockedOf, notifRecipient, notifActor, conversations, reports] =
    await Promise.all([
      db.collection('follows').where('followerUid', '==', uid).get(),
      db.collection('follows').where('followingUid', '==', uid).get(),
      db.collection('blocks').where('blockerUid', '==', uid).get(),
      db.collection('blocks').where('blockedUid', '==', uid).get(),
      db.collection('notifications').where('recipientUid', '==', uid).get(),
      db.collection('notifications').where('actorUid', '==', uid).get(),
      db.collection('conversations').where('participantUids', 'array-contains', uid).get(),
      // Count only — never returns reason/details text (Section 19's own
      // "do not return sensitive report text" instruction).
      db.collection('reports').where('reporterUid', '==', uid).get(),
    ]);

  const storageAdminTest = await runStorageAdminSelfTest(uid);

  return {
    authenticatedUid: uid,
    crossUser: {
      contentLikes: likes.content,
      contentComments: comments.content,
      eventResponses: responses,
      activityParticipants: { ...participants, pairings: participantContentPairings },
      reelLikes: likes.reels,
      reelComments: comments.reels,
    },
    own: {
      content: { count: ownContent.size, ids: ownContent.docs.map((d) => d.id) },
      reels: { count: ownReels.size, ids: ownReels.docs.map((d) => d.id) },
    },
    follows: { asFollower: followerOf.size, asFollowing: followingOf.size },
    blocks: { asBlocker: blockerOf.size, asBlocked: blockedOf.size },
    notifications: { asRecipient: notifRecipient.size, asActor: notifActor.size },
    conversations: { count: conversations.size },
    reports: { asReporter: reports.size },
    storageAdminTest,
  };
});
