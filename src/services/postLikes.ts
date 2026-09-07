/**
 * postLikes/{likeId} — internal write-path helper only (Step 41.2H.1).
 * Deliberately NOT a user-facing service: the app never lists or browses
 * these rows (Firestore Rules deny all client reads — see firestore.rules),
 * it only ever writes them atomically alongside a real Like/Unlike. Used
 * by src/services/reelEngagement.ts and src/services/socialEngagement.ts;
 * nothing else should import from here.
 */

import { doc } from 'firebase/firestore';

import type { PostLikeTargetType } from '@/types/postLikes';

import { firestore } from './firestore';

const POST_LIKES_COLLECTION = 'postLikes';

export function postLikeId(likerUid: string, targetType: PostLikeTargetType, targetId: string): string {
  return `${likerUid}_${targetType}_${targetId}`;
}

export function postLikeRef(likerUid: string, targetType: PostLikeTargetType, targetId: string) {
  return doc(firestore!, POST_LIKES_COLLECTION, postLikeId(likerUid, targetType, targetId));
}
