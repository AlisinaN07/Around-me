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
