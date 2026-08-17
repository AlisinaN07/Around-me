import type { Timestamp } from 'firebase/firestore';

export type ContentType = 'post' | 'activity' | 'event';

/** Only "published" exists in this MVP — no draft/removed states yet. */
export type ContentStatus = 'published';

/** Only "city" exists in this MVP — no private/followers-only visibility yet. */
export type ContentVisibility = 'city';

/**
 * Fields every content/{contentId} document shares, regardless of type.
 *
 * authorDisplayName/authorUsername/cityName/countryCode/cityKey are a
 * PUBLIC-SAFE SNAPSHOT of the author's private users/{uid} profile at
 * creation time — copied so the feed never has to read another user's
 * private profile document. Firestore rules verify this snapshot matches
 * the author's actual profile at write time (see firestore.rules).
 *
 * Never add: author email, precise GPS coordinates, home address, auth
 * tokens, or any other private account data to this shape.
 */
export type ContentBase = {
  contentId: string;
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  cityName: string;
  countryCode: string;
  cityKey: string;
  categoryId: string;
  status: ContentStatus;
  visibility: ContentVisibility;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type PostContent = ContentBase & {
  type: 'post';
  body: string;
  placeName?: string;
};

export type ActivityContent = ContentBase & {
  type: 'activity';
  title: string;
  description: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  placeName: string;
  maxParticipants?: number;
};

export type EventContent = ContentBase & {
  type: 'event';
  title: string;
  description: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  placeName: string;
};

/** content/{contentId} — the unified root collection for all city content. */
export type Content = PostContent | ActivityContent | EventContent;

export const BODY_MAX_LENGTH = 1000;
export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 1000;
export const PLACE_NAME_MAX_LENGTH = 200;
export const MAX_PARTICIPANTS_LIMIT = 500;

/**
 * content/{activityId}/participants/{uid} — one document per joined user.
 * displayName/username are a public-safe snapshot of the participant's own
 * profile, verified against it by Firestore rules on create. Never store
 * email, location, or other private profile fields here.
 */
export type ActivityParticipant = {
  uid: string;
  displayName: string;
  username: string;
  joinedAt: Timestamp;
};

/**
 * content/{activityId}/stats/activity — a single document holding the
 * participant count, so `maxParticipants` can be enforced without reading
 * every participant document. Kept separate from the root content document
 * so the existing content schema stays stable (see src/services/content.ts).
 */
export type ActivityStats = {
  participantCount: number;
  updatedAt: Timestamp;
};

export type EventResponseStatus = 'interested' | 'going';

/**
 * content/{eventId}/responses/{uid} — one document per user, holding their
 * current status. Switching between "interested" and "going" updates this
 * same document rather than creating a second one. displayName/username are
 * a public-safe snapshot, verified against the responder's own profile by
 * Firestore rules.
 */
export type EventResponse = {
  uid: string;
  displayName: string;
  username: string;
  status: EventResponseStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

/**
 * content/{contentId}/likes/{uid} — one document per user who liked a Post,
 * Activity, or Event. The document ID (the liker's own uid) is what
 * guarantees at most one Like per user; there is nothing else to store, so
 * unlike participants/responses this carries no public-safe profile
 * snapshot at all — just enough to prove who liked and when.
 */
export type ContentLike = {
  uid: string;
  createdAt: Timestamp;
};

export const COMMENT_BODY_MAX_LENGTH = 500;

/**
 * content/{contentId}/comments/{commentId} — top-level comments only for
 * Step 10, no replies/threads. authorDisplayName/authorUsername are a
 * public-safe snapshot of the commenter's own profile, verified against it
 * by Firestore rules on create — same pattern as content authorship itself.
 */
export type ContentComment = {
  commentId: string;
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  body: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
