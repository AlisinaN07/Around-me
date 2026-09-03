/**
 * Social notifications — the notifications/{notificationId} collection.
 * UI code should only ever import from here for reading/marking read.
 * Notifications are CREATED and DELETED by the action that causes them —
 * see src/services/socialEngagement.ts (likes, comments) and
 * src/services/following.ts (follows) — never independently from here.
 */

import { collection, doc, getDocs, limit, orderBy, query, serverTimestamp, updateDoc, where, writeBatch } from 'firebase/firestore';

import type { Notification, NotificationType } from '@/types/notification';

import { firestore } from './firestore';

const NOTIFICATIONS_COLLECTION = 'notifications';
const DEFAULT_NOTIFICATIONS_LIMIT = 50;

/**
 * Deterministic notification IDs — this is what prevents duplicate
 * notifications for the same underlying action (a second like from the
 * same user lands on the same doc; Firestore rules treat re-creating an
 * existing doc as an "update," denied — same pattern as Likes themselves).
 */
export function buildNotificationId(
  type: NotificationType,
  params: { contentId?: string; actorUid?: string; commentId?: string; recipientUid?: string; reelId?: string }
): string {
  switch (type) {
    case 'like':
      return `like_${params.contentId}_${params.actorUid}`;
    case 'comment':
      return `comment_${params.commentId}`;
    case 'follow':
      return `follow_${params.actorUid}_${params.recipientUid}`;
    case 'reel_like':
      return `reel_like_${params.reelId}_${params.actorUid}`;
    case 'reel_comment':
      return `reel_comment_${params.commentId}`;
  }
}

export function notificationRef(notificationId: string) {
  return doc(firestore!, NOTIFICATIONS_COLLECTION, notificationId);
}

/** Newest-first, explicitly limited, one-shot read — no realtime listener. */
export async function fetchNotifications(uid: string, limitCount = DEFAULT_NOTIFICATIONS_LIMIT): Promise<Notification[]> {
  if (!firestore) return [];
  const notificationsQuery = query(
    collection(firestore, NOTIFICATIONS_COLLECTION),
    where('recipientUid', '==', uid),
    orderBy('createdAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(notificationsQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Notification);
}

export async function markNotificationRead(notificationId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) return { ok: false, message: 'Firestore is not available.' };
  try {
    await updateDoc(notificationRef(notificationId), { read: true, updatedAt: serverTimestamp() });
  } catch {
    return { ok: false, message: "Couldn't update this notification." };
  }
  return { ok: true };
}

/**
 * Marks the given, already-fetched notification IDs as read in one batch —
 * deliberately takes IDs from the caller's already-loaded, capped list
 * (see fetchNotifications) rather than running a separate "unread" query,
 * so this never touches more documents than the current page already has.
 */
export async function markAllNotificationsRead(notificationIds: string[]): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) return { ok: false, message: 'Firestore is not available.' };
  if (notificationIds.length === 0) return { ok: true };
  try {
    const batch = writeBatch(firestore);
    for (const id of notificationIds) {
      batch.update(notificationRef(id), { read: true, updatedAt: serverTimestamp() });
    }
    await batch.commit();
  } catch {
    return { ok: false, message: "Couldn't mark all as read." };
  }
  return { ok: true };
}
