import type { Timestamp } from 'firebase/firestore';

export type NotificationType = 'like' | 'comment' | 'follow';

export const NOTIFICATION_PREVIEW_MAX_LENGTH = 120;

/**
 * notifications/{notificationId} — a single social notification for its
 * recipient (Like, Comment, or Follow). Always created atomically with the
 * underlying action (see src/services/socialEngagement.ts and
 * src/services/following.ts) and independently re-validated against it by
 * Firestore rules on create, so a client can never create a fake
 * notification — see firestore.rules.
 *
 * actorDisplayName/actorUsername are a public-safe snapshot of the actor's
 * own profile, same pattern as content authorship. Never store email, GPS,
 * password, or any other private profile data here.
 *
 * Deterministic IDs (see buildNotificationId in src/services/notifications.ts)
 * are what prevent duplicate notifications for the same underlying action:
 * - like:    like_{contentId}_{actorUid}
 * - comment: comment_{commentId}
 * - follow:  follow_{actorUid}_{recipientUid}
 */
export type Notification = {
  notificationId: string;
  recipientUid: string;
  actorUid: string;
  actorDisplayName: string;
  actorUsername: string;
  type: NotificationType;
  contentId: string | null;
  commentId: string | null;
  /** A short, safe preview (e.g. of a comment body) — never the full raw text if that's long. */
  previewText: string | null;
  read: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
