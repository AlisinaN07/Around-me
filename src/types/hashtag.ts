import type { Timestamp } from 'firebase/firestore';

/**
 * hashtags/{hashtagId} — one document per unique, normalized hashtag seen
 * anywhere on Around Me (today: only Reel captions — see
 * src/services/reels.ts's createReelDraft). `hashtagId` IS `name` itself
 * (see src/utils/hashtags.ts's normalizeHashtag) — there is no separate
 * generated ID, so a direct doc read by name never needs a query, and a
 * prefix search (Step: hashtag search preparation) can range-query the
 * collection's own document IDs with no extra indexed field.
 *
 * `postCount` is a trusted aggregate, not something a client can set to
 * an arbitrary value — Firestore Rules only ever allow a client to
 * increment it by exactly 1 (one real Reel just published with this
 * hashtag); it can only ever go DOWN via the trusted Cloud Functions
 * delete backend (Admin SDK, bypassing Rules — see
 * functions/src/index.ts's decrementHashtagCounts), which also floors it
 * at 0. See firestore.rules' `match /hashtags/{hashtagId}` for the exact
 * enforcement.
 */
export type Hashtag = {
  /** Canonical lowercase form — always equal to this document's own ID. */
  name: string;
  postCount: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
