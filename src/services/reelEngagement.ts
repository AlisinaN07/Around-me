/**
 * Reel Likes and Comments — reels/{reelId}/likes/{uid} and
 * reels/{reelId}/comments/{commentId}. Structurally parallel to
 * src/services/socialEngagement.ts's content Likes/Comments, but kept as a
 * dedicated module since Reels are a separate root collection from
 * content/{contentId} (see src/types/reel.ts). UI code should only ever
 * import from here, never talk to Firestore directly for Reel engagement.
 */

import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  writeBatch,
  type WithFieldValue,
} from 'firebase/firestore';

import type { Notification } from '@/types/notification';
import { NOTIFICATION_PREVIEW_MAX_LENGTH } from '@/types/notification';
import type { PostLike } from '@/types/postLikes';
import type { Reel, ReelComment, ReelLike } from '@/types/reel';
import { REEL_COMMENT_BODY_MAX_LENGTH } from '@/types/reel';

import { resolveTrustedFields, type EngagementError, type EngagementResult } from './engagement';
import { firestore } from './firestore';
import { buildNotificationId, notificationRef } from './notifications';
import { postLikeRef } from './postLikes';
import { reelRef } from './reels';

const REELS_COLLECTION = 'reels';
const DEFAULT_REEL_COMMENT_LIMIT = 30;

function reelLikeRef(reelId: string, uid: string) {
  return doc(firestore!, REELS_COLLECTION, reelId, 'likes', uid);
}
function reelCommentsCollectionRef(reelId: string) {
  return collection(firestore!, REELS_COLLECTION, reelId, 'comments');
}
function reelCommentRef(reelId: string, commentId: string) {
  return doc(firestore!, REELS_COLLECTION, reelId, 'comments', commentId);
}

type AssertPublishedReelResult = { ok: true; reel: Reel } | { ok: false; error: EngagementError; message: string };

async function assertPublishedReel(reelId: string): Promise<AssertPublishedReelResult> {
  const snapshot = await getDoc(reelRef(reelId));
  if (!snapshot.exists() || snapshot.data().status !== 'published') {
    return { ok: false, error: 'not-found', message: "Couldn't find that post." };
  }
  return { ok: true, reel: snapshot.data() as Reel };
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

export type LikeReelResult = EngagementResult<{ alreadyLiked: boolean }>;

export async function likeReel(reelId: string, uid: string): Promise<LikeReelResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  const parent = await assertPublishedReel(reelId);
  if (!parent.ok) return { ...parent, message: "Couldn't like this post." };

  const existing = await getDoc(reelLikeRef(reelId, uid));
  if (existing.exists()) {
    return { ok: true, alreadyLiked: true };
  }

  try {
    // Like + notification + postLikes relationship land atomically — see
    // firestore.rules, which requires the like doc to exist (existsAfter)
    // for both the notification AND the postLikes create to be valid.
    // Never notify yourself for your own like, and never create a
    // postLikes relationship for a self-like either (Step 41.2H.1 — a
    // self-Like still behaves exactly as before, it just never
    // contributes to the author's future "Liked" total).
    const batch = writeBatch(firestore);
    batch.set(reelLikeRef(reelId, uid), {
      uid,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<ReelLike>);

    if (parent.reel.authorUid !== uid) {
      const notificationId = buildNotificationId('reel_like', { reelId, actorUid: uid });
      batch.set(notificationRef(notificationId), {
        notificationId,
        recipientUid: parent.reel.authorUid,
        actorUid: uid,
        actorDisplayName: trusted.fields.displayName,
        actorUsername: trusted.fields.username,
        type: 'reel_like',
        contentId: null,
        reelId,
        commentId: null,
        previewText: null,
        responseStatus: null,
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<Notification>);

      batch.set(postLikeRef(uid, 'reel', reelId), {
        likerUid: uid,
        targetAuthorUid: parent.reel.authorUid,
        targetType: 'reel',
        targetId: reelId,
        createdAt: serverTimestamp(),
      } satisfies WithFieldValue<PostLike>);
    }

    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't like this post." };
  }

  return { ok: true, alreadyLiked: false };
}

export async function unlikeReel(reelId: string, uid: string): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    // Removing the like, its notification (if any — self-likes never had
    // one), and its postLikes relationship (Step 41.2H.1 — same caveat:
    // self-likes never had one either) all land in the same batch, so
    // neither can ever outlive the like it was for. Allowed even if the
    // two users became blocked after the like was created — unliking must
    // never trap a stale like. The postLikes delete is unconditional and
    // safe even when no such row ever existed (self-like, or a Like
    // created before this Rules change) — firestore.rules explicitly
    // allows deleting an already-absent postLikes doc as a no-op.
    const reelSnapshot = await getDoc(reelRef(reelId));
    const batch = writeBatch(firestore);
    batch.delete(reelLikeRef(reelId, uid));
    batch.delete(postLikeRef(uid, 'reel', reelId));
    if (reelSnapshot.exists() && reelSnapshot.data().authorUid !== uid) {
      batch.delete(notificationRef(buildNotificationId('reel_like', { reelId, actorUid: uid })));
    }
    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't remove your like." };
  }
  return { ok: true };
}

export async function isReelLiked(reelId: string, uid: string): Promise<boolean> {
  if (!firestore) return false;
  const snapshot = await getDoc(reelLikeRef(reelId, uid));
  return snapshot.exists();
}

/** Server-side aggregation count — never fetches every like document just to count them. */
export async function fetchReelLikeCount(reelId: string): Promise<number> {
  if (!firestore) return 0;
  const snapshot = await getCountFromServer(collection(firestore, REELS_COLLECTION, reelId, 'likes'));
  return snapshot.data().count;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export type AddReelCommentResult = EngagementResult<{ comment: ReelComment }>;

export async function addReelComment(reelId: string, uid: string, body: string): Promise<AddReelCommentResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trimmed = body.trim();
  if (!trimmed || trimmed.length > REEL_COMMENT_BODY_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Comment must be 1–${REEL_COMMENT_BODY_MAX_LENGTH} characters.` };
  }

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  const parent = await assertPublishedReel(reelId);
  if (!parent.ok) return { ...parent, message: "Couldn't post your comment." };

  const ref = doc(reelCommentsCollectionRef(reelId));
  const data = {
    commentId: ref.id,
    authorUid: uid,
    authorDisplayName: trusted.fields.displayName,
    authorUsername: trusted.fields.username,
    body: trimmed,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<ReelComment>;

  try {
    // Comment + notification land atomically — see firestore.rules, which
    // requires the comment doc to exist (existsAfter) for the notification
    // create to be valid. Never notify yourself for your own comment.
    const batch = writeBatch(firestore);
    batch.set(ref, data);

    if (parent.reel.authorUid !== uid) {
      const notificationId = buildNotificationId('reel_comment', { commentId: ref.id });
      const previewText = trimmed.length > NOTIFICATION_PREVIEW_MAX_LENGTH ? `${trimmed.slice(0, NOTIFICATION_PREVIEW_MAX_LENGTH)}…` : trimmed;
      batch.set(notificationRef(notificationId), {
        notificationId,
        recipientUid: parent.reel.authorUid,
        actorUid: uid,
        actorDisplayName: trusted.fields.displayName,
        actorUsername: trusted.fields.username,
        type: 'reel_comment',
        contentId: null,
        reelId,
        commentId: ref.id,
        previewText,
        responseStatus: null,
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<Notification>);
    }

    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't post your comment." };
  }

  const created = await getDoc(ref);
  if (!created.exists()) {
    return { ok: false, error: 'unknown', message: 'Comment was posted but could not be read back.' };
  }
  return { ok: true, comment: created.data() as ReelComment };
}

export async function deleteReelComment(
  reelId: string,
  commentId: string,
  uid: string
): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    // Removing the comment and its notification (if any — self-comments
    // never had one) land in the same batch, so a notification can never
    // outlive the comment it was for. Allowed even if the two users became
    // blocked after the comment was created.
    const reelSnapshot = await getDoc(reelRef(reelId));
    const batch = writeBatch(firestore);
    batch.delete(reelCommentRef(reelId, commentId));
    if (reelSnapshot.exists() && reelSnapshot.data().authorUid !== uid) {
      batch.delete(notificationRef(buildNotificationId('reel_comment', { commentId })));
    }
    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't delete your comment." };
  }
  return { ok: true };
}

export type FetchReelCommentsOptions = {
  limitCount?: number;
  // No cursor param yet — fetchReelComments is a one-shot newest-30 read,
  // same as fetchComments in socialEngagement.ts.
};

/** Newest-first, explicitly limited — never an unbounded fetch. */
export async function fetchReelComments(reelId: string, options: FetchReelCommentsOptions = {}): Promise<ReelComment[]> {
  if (!firestore) return [];
  const commentsQuery = query(reelCommentsCollectionRef(reelId), orderBy('createdAt', 'desc'), limit(options.limitCount ?? DEFAULT_REEL_COMMENT_LIMIT));
  const snapshot = await getDocs(commentsQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as ReelComment);
}

/** Server-side aggregation count — never fetches every comment just to count them. */
export async function fetchReelCommentCount(reelId: string): Promise<number> {
  if (!firestore) return 0;
  const snapshot = await getCountFromServer(reelCommentsCollectionRef(reelId));
  return snapshot.data().count;
}
