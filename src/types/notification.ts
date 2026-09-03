import type { Timestamp } from 'firebase/firestore';

export type NotificationType = 'like' | 'comment' | 'follow' | 'reel_like' | 'reel_comment';

export const NOTIFICATION_PREVIEW_MAX_LENGTH = 120;

/**
 * notifications/{notificationId} — a single social notification for its
 * recipient (Like, Comment, Follow, or their Reel equivalents). Always
 * created atomically with the underlying action (see
 * src/services/socialEngagement.ts, src/services/following.ts, and
 * src/services/reelEngagement.ts) and independently re-validated against it
 * by Firestore rules on create, so a client can never create a fake
 * notification — see firestore.rules.
 *
 * actorDisplayName/actorUsername are a public-safe snapshot of the actor's
 * own profile, same pattern as content authorship. Never store email, GPS,
 * password, or any other private profile data here.
 *
 * Reels are a separate root collection from content/{contentId} (see
 * src/types/reel.ts), so reel_like/reel_comment carry `reelId` instead of
 * `contentId` — exactly one of the two is ever non-null for any given
 * notification; the other is always null. Existing like/comment/follow
 * notifications keep `reelId: null` unchanged — this is a pure additive
 * extension, no migration of old documents.
 *
 * Deterministic IDs (see buildNotificationId in src/services/notifications.ts)
 * are what prevent duplicate notifications for the same underlying action:
 * - like:         like_{contentId}_{actorUid}
 * - comment:      comment_{commentId}
 * - follow:       follow_{actorUid}_{recipientUid}
 * - reel_like:    reel_like_{reelId}_{actorUid}
 * - reel_comment: reel_comment_{commentId}
 */
export type Notification = {
  notificationId: string;
  recipientUid: string;
  actorUid: string;
  actorDisplayName: string;
  actorUsername: string;
  type: NotificationType;
  contentId: string | null;
  /** Reel reference for reel_like/reel_comment — null for every other type. */
  reelId: string | null;
  commentId: string | null;
  /** A short, safe preview (e.g. of a comment body) — never the full raw text if that's long. */
  previewText: string | null;
  read: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
