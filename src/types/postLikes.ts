import type { Timestamp } from 'firebase/firestore';

/**
 * postLikes/{likeId} — Step 41.2H.1. The authoritative, NORMALIZED
 * relationship behind Profile's future "Liked" stat: exactly one non-self
 * Like on one current, published, original social Post (video Post or
 * legacy text Post — never Event, never legacy Activity). `likeId` is
 * always the deterministic `${likerUid}_${targetType}_${targetId}` (see
 * src/services/postLikes.ts), so one relationship can ever exist per
 * liker/target pair.
 *
 * NOT publicly readable, and not even owner-readable via the client SDK
 * (firestore.rules: `allow read: if false`) — the app only ever needs the
 * AGGREGATE COUNT of a profile's received Likes, never a browsable list of
 * who liked what. Written atomically alongside the existing per-target
 * Like document (reels/{reelId}/likes/{uid} or
 * content/{contentId}/likes/{uid}) in the same batch; Firestore Rules
 * enforce that pairing symmetrically in both directions — see
 * firestore.rules' isValidPostLikeCreate/isValidPostLikeDelete.
 *
 * Self-Likes never produce a row here (targetAuthorUid != likerUid is
 * enforced by Rules), and Event/legacy Activity Likes never do either
 * (targetType is only ever 'reel' or 'post', and a 'post' row is only
 * ever valid when the real content document's type is 'post').
 */
export type PostLikeTargetType = 'reel' | 'post';

export type PostLike = {
  likerUid: string;
  targetAuthorUid: string;
  targetType: PostLikeTargetType;
  targetId: string;
  createdAt: Timestamp;
};
