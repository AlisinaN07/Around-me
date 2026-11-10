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
  /**
   * A known places/{placeId} this content is linked to, or null for a
   * manually-typed place (see placeName below) or no place at all.
   * Firestore rules independently verify — on create — that the place
   * exists, is active, is in the same city as this content, and that
   * placeName matches the place's real name (see firestore.rules); a
   * modified client can't link Karlstad content to a Stockholm place, or
   * attach a spoofed placeName to a real place.
   */
  placeId: string | null;
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
  /**
   * Step 36 — an OPTIONAL background/cover photo, omitted entirely (never
   * an empty string) when the organizer doesn't add one — same "absent
   * key, not a blank value" convention placeName already uses on
   * PostContent above. A real, already-resolved HTTPS download URL (see
   * uploadEventCoverPhoto/createEvent in src/services/content.ts), never a
   * bare Storage path. Content documents are immutable after publish (no
   * edit UI exists — see the content/{contentId} `allow update: if false`
   * in firestore.rules), so unlike a profile photo this is set once, at
   * creation, and never changed afterward.
   */
  coverPhotoURL?: string;
  /**
   * The real storage object `coverPhotoURL` was resolved from — ALWAYS
   * exactly `eventCovers/{authorUid}/{contentId}/photo`, where
   * `contentId` is THIS SAME document's own id (see generateEventId's own
   * doc comment in src/services/content.ts). Set together with
   * `coverStorageProvider`, NEVER independently, and NEVER accepted as a
   * free-form caller-supplied string — `createEvent`'s own single writer
   * (resolveEventCoverStorageFields, src/utils/eventCoverStorageFields.ts)
   * always DERIVES this from `authorUid` + `contentId`, never trusts a
   * reported path. This exact-contentId tie is what stops a client from
   * ever claiming a DIFFERENT Event's cover (even its own, earlier Event)
   * — a bare "same uid" namespace check alone is NOT sufficient for that,
   * since two Events by the same author share the same uid; `contentId`
   * is what's actually unique per Event. Exists purely so server-side
   * deletion (functions/src/media/eventMediaCleanup.ts) has a reliable,
   * Event-scoped key to delete on removal — it is never read for
   * display; `coverPhotoURL` remains the only field any UI uses.
   *
   * OPTIONAL and omitted for: an Event with no cover at all, AND every
   * Event created before this field existed (which includes every Event
   * created under the brief prior scheme that tied this to an
   * independently-generated `draftId` rather than `contentId` — that
   * value can essentially never equal this document's own `contentId` by
   * chance, so it is correctly treated as untrusted/legacy too, never
   * guessed at). See eventMediaCleanup.ts's own doc comment for why a
   * legacy Event's cover, if it has one, is simply never cleaned up
   * rather than guessed.
   */
  coverStoragePath?: string;
  /** Which backend `coverStoragePath` lives in. Always present together with `coverStoragePath` — see that field's own doc comment. */
  coverStorageProvider?: 'firebase' | 'r2';
  /**
   * Step 12D — every "#token" this Event's own `description` contains at
   * creation time, normalized (see src/utils/hashtags.ts's
   * extractHashtags — the exact same function/semantics a Reel's caption
   * already uses; no second hashtag system). OPTIONAL, not required like
   * Reel.hashtags, specifically because every Event created BEFORE this
   * step has no such field at all — every read site must treat a missing
   * value as `[]` (never `undefined` propagating into a ranking/learning
   * call), same "absent key, not a blank value" convention
   * coverPhotoURL above already established for exactly this "added
   * later, old docs don't have it" reason. Content documents are
   * immutable after publish for every OTHER field (no edit UI — see this
   * type's own coverPhotoURL doc comment), so this is set once, at
   * creation, from the description as originally typed, and never
   * changed afterward either.
   */
  hashtags?: string[];
};

/** content/{contentId} — the unified root collection for all city content. */
export type Content = PostContent | ActivityContent | EventContent;

export const BODY_MAX_LENGTH = 1000;
export const TITLE_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 1000;
export const PLACE_NAME_MAX_LENGTH = 200;
export const MAX_PARTICIPANTS_LIMIT = 500;
/** Step 36 — same cap as PROFILE_COVER_PHOTO_MAX_SIZE_BYTES (src/types/user.ts): a banner-shaped image, not a single still like a profile photo. */
export const EVENT_COVER_PHOTO_MAX_SIZE_BYTES = 8 * 1024 * 1024;

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
