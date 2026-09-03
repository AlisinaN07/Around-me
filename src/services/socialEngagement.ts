/**
 * Likes and comments — the general social engagement layer shared by Post,
 * Activity, and Event. UI code should only ever import from here, never
 * talk to Firestore directly for likes/comments.
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

import type { Content, ContentComment, ContentLike } from '@/types/content';
import { COMMENT_BODY_MAX_LENGTH } from '@/types/content';
import type { Notification } from '@/types/notification';
import { NOTIFICATION_PREVIEW_MAX_LENGTH } from '@/types/notification';

import { contentDocRef, resolveTrustedFields, type EngagementError, type EngagementResult } from './engagement';
import { firestore } from './firestore';
import { buildNotificationId, notificationRef } from './notifications';

const CONTENT_COLLECTION = 'content';
const DEFAULT_COMMENT_LIMIT = 30;

function likeRef(contentId: string, uid: string) {
  return doc(firestore!, CONTENT_COLLECTION, contentId, 'likes', uid);
}
function commentsCollectionRef(contentId: string) {
  return collection(firestore!, CONTENT_COLLECTION, contentId, 'comments');
}
function commentRef(contentId: string, commentId: string) {
  return doc(firestore!, CONTENT_COLLECTION, contentId, 'comments', commentId);
}

type AssertPublishedContentResult =
  | { ok: true; content: Content }
  | { ok: false; error: EngagementError; message: string };

async function assertPublishedContent(contentId: string): Promise<AssertPublishedContentResult> {
  const snapshot = await getDoc(contentDocRef(contentId));
  if (!snapshot.exists() || snapshot.data().status !== 'published') {
    return { ok: false, error: 'not-found', message: "Couldn't find that." };
  }
  return { ok: true, content: snapshot.data() as Content };
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

export type LikeContentResult = EngagementResult<{ alreadyLiked: boolean }>;

export async function likeContent(contentId: string, uid: string): Promise<LikeContentResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  const parent = await assertPublishedContent(contentId);
  if (!parent.ok) return { ...parent, message: "Couldn't like this." };

  const existing = await getDoc(likeRef(contentId, uid));
  if (existing.exists()) {
    return { ok: true, alreadyLiked: true };
  }

  try {
    // Like + notification land atomically — see firestore.rules, which
    // requires the like doc to exist (existsAfter) for the notification
    // create to be valid. Never notify yourself for your own like.
    const batch = writeBatch(firestore);
    batch.set(likeRef(contentId, uid), {
      uid,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<ContentLike>);

    if (parent.content.authorUid !== uid) {
      const notificationId = buildNotificationId('like', { contentId, actorUid: uid });
      batch.set(notificationRef(notificationId), {
        notificationId,
        recipientUid: parent.content.authorUid,
        actorUid: uid,
        actorDisplayName: trusted.fields.displayName,
        actorUsername: trusted.fields.username,
        type: 'like',
        contentId,
        reelId: null,
        commentId: null,
        previewText: null,
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<Notification>);
    }

    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't like this." };
  }

  return { ok: true, alreadyLiked: false };
}

export async function unlikeContent(contentId: string, uid: string): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    // Removing the like and its notification (if any — self-likes never
    // had one) land in the same batch, so a notification can never outlive
    // the like it was for.
    const contentSnapshot = await getDoc(contentDocRef(contentId));
    const batch = writeBatch(firestore);
    batch.delete(likeRef(contentId, uid));
    if (contentSnapshot.exists() && contentSnapshot.data().authorUid !== uid) {
      batch.delete(notificationRef(buildNotificationId('like', { contentId, actorUid: uid })));
    }
    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't remove your like." };
  }
  return { ok: true };
}

export async function fetchMyLike(contentId: string, uid: string): Promise<ContentLike | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(likeRef(contentId, uid));
  return snapshot.exists() ? (snapshot.data() as ContentLike) : null;
}

/** Server-side aggregation count — never fetches every like document just to count them. */
export async function fetchLikeCount(contentId: string): Promise<number> {
  if (!firestore) return 0;
  const snapshot = await getCountFromServer(collection(firestore, CONTENT_COLLECTION, contentId, 'likes'));
  return snapshot.data().count;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export type CreateCommentResult = EngagementResult<{ comment: ContentComment }>;

export async function createComment(contentId: string, uid: string, body: string): Promise<CreateCommentResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trimmed = body.trim();
  if (!trimmed || trimmed.length > COMMENT_BODY_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Comment must be 1–${COMMENT_BODY_MAX_LENGTH} characters.` };
  }

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  const parent = await assertPublishedContent(contentId);
  if (!parent.ok) return { ...parent, message: "Couldn't post your comment." };

  const ref = doc(commentsCollectionRef(contentId));
  const data = {
    commentId: ref.id,
    authorUid: uid,
    authorDisplayName: trusted.fields.displayName,
    authorUsername: trusted.fields.username,
    body: trimmed,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<ContentComment>;

  try {
    // Comment + notification land atomically — see firestore.rules, which
    // requires the comment doc to exist (existsAfter) for the notification
    // create to be valid. Never notify yourself for your own comment.
    const batch = writeBatch(firestore);
    batch.set(ref, data);

    if (parent.content.authorUid !== uid) {
      const notificationId = buildNotificationId('comment', { commentId: ref.id });
      const previewText = trimmed.length > NOTIFICATION_PREVIEW_MAX_LENGTH ? `${trimmed.slice(0, NOTIFICATION_PREVIEW_MAX_LENGTH)}…` : trimmed;
      batch.set(notificationRef(notificationId), {
        notificationId,
        recipientUid: parent.content.authorUid,
        actorUid: uid,
        actorDisplayName: trusted.fields.displayName,
        actorUsername: trusted.fields.username,
        type: 'comment',
        contentId,
        reelId: null,
        commentId: ref.id,
        previewText,
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
  return { ok: true, comment: created.data() as ContentComment };
}

export async function deleteComment(
  contentId: string,
  commentId: string,
  uid: string
): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    // Removing the comment and its notification (if any — self-comments
    // never had one) land in the same batch, so a notification can never
    // outlive the comment it was for.
    const contentSnapshot = await getDoc(contentDocRef(contentId));
    const batch = writeBatch(firestore);
    batch.delete(commentRef(contentId, commentId));
    if (contentSnapshot.exists() && contentSnapshot.data().authorUid !== uid) {
      batch.delete(notificationRef(buildNotificationId('comment', { commentId })));
    }
    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't delete your comment." };
  }
  return { ok: true };
}

export type FetchCommentsOptions = {
  limitCount?: number;
  // No cursor param yet — fetchComments is a one-shot newest-30 read. A
  // future "load more" could add `after?: QueryDocumentSnapshot` here and
  // pass it to `startAfter()` without changing this function's shape.
};

/** Newest-first, explicitly limited — never an unbounded fetch. */
export async function fetchComments(contentId: string, options: FetchCommentsOptions = {}): Promise<ContentComment[]> {
  if (!firestore) return [];
  const commentsQuery = query(commentsCollectionRef(contentId), orderBy('createdAt', 'desc'), limit(options.limitCount ?? DEFAULT_COMMENT_LIMIT));
  const snapshot = await getDocs(commentsQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as ContentComment);
}

/** Server-side aggregation count — never fetches every comment just to count them. */
export async function fetchCommentCount(contentId: string): Promise<number> {
  if (!firestore) return 0;
  const snapshot = await getCountFromServer(commentsCollectionRef(contentId));
  return snapshot.data().count;
}
