import type { Timestamp } from 'firebase/firestore';

import type { EventResponseStatus } from '@/types/content';

export type NotificationType = 'like' | 'comment' | 'follow' | 'reel_like' | 'reel_comment' | 'event_response' | 'activity_join';

export const NOTIFICATION_PREVIEW_MAX_LENGTH = 120;

/**
 * notifications/{notificationId} — a single social notification for its
 * recipient (Like, Comment, Follow, their Reel equivalents, or an Event
 * response / Activity join — see src/services/engagement.ts for the latter
 * two). Always created atomically with the underlying action and
 * independently re-validated against it by Firestore rules on create, so a
 * client can never create a fake notification — see firestore.rules.
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
 * `responseStatus` exists only for `event_response` (Interested/Going) —
 * null for every other type, same always-present-but-often-null pattern as
 * `reelId`/`commentId`/`previewText`. Pre-Step-38 stored documents predate
 * this field entirely and simply lack the key (see the update rule's
 * `.get('responseStatus', null)` in firestore.rules, mirroring how `reelId`
 * was already handled for pre-Step-19 documents).
 *
 * event_response is deliberately ONE logical notification per (actor,
 * event) representing the actor's CURRENT response, not one notification
 * per response event — switching Interested <-> Going updates the same
 * document (see setEventResponse) rather than creating a second one.
 * activity_join is one notification per (actor, activity) that exists only
 * while the actor is joined — leaveActivity deletes it.
 *
 * Deterministic IDs (see buildNotificationId in src/services/notifications.ts)
 * are what prevent duplicate notifications for the same underlying action:
 * - like:           like_{contentId}_{actorUid}
 * - comment:        comment_{commentId}
 * - follow:         follow_{actorUid}_{recipientUid}
 * - reel_like:      reel_like_{reelId}_{actorUid}
 * - reel_comment:   reel_comment_{commentId}
 * - event_response: event_response_{contentId}_{actorUid}
 * - activity_join:  activity_join_{contentId}_{actorUid}
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
  /** The actor's current Event response — set only for event_response, null for every other type. */
  responseStatus: EventResponseStatus | null;
  read: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
