import type { Timestamp } from 'firebase/firestore';

/**
 * reposts/{repostId} — Step 41.2F. A PUBLIC relationship: a user
 * republishing another account's Post (video or legacy text) onto their
 * own Profile's Reposts tab. `repostId` is always the deterministic
 * `${userUid}_${targetType}_${targetId}` (see src/services/reposts.ts), so
 * one repost relationship can ever exist per user/Post pair.
 *
 * Deliberately a public ROOT collection, unlike the private
 * users/{uid}/saved subcollection (Step 41.2E) — a public Profile needs to
 * query "everything this uid has reposted" without ever touching anyone's
 * private users/{uid} subtree.
 *
 * `targetAuthorUid` is redundant with the real target document's
 * `authorUid` (Firestore Rules verify they match on create — see
 * firestore.rules' isValidRepostCreate), but is still stored so a public
 * Profile listing never has to fetch a Reel/Post just to know who not to
 * misattribute a repost to.
 */
export type RepostTargetType = 'reel' | 'post';

export type Repost = {
  userUid: string;
  targetType: RepostTargetType;
  targetId: string;
  targetAuthorUid: string;
  createdAt: Timestamp;
};
