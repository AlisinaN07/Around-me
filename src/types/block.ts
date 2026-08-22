import type { Timestamp } from 'firebase/firestore';

/**
 * blocks/{blockerUid}_{blockedUid} — a directed "A blocks B" edge (see
 * src/services/blocks.ts). Directional and deterministic, same pattern as
 * follows/{followerUid}_{followingUid} — at most one block per ordered
 * pair, keyed by the ID itself.
 *
 * A block prevents NEW direct interaction between the two users in both
 * directions (follow, like, comment, message) — enforced by Firestore
 * rules, not just this app. It does not retroactively hide existing
 * likes/comments/messages/notifications; see firestore.rules and
 * src/services/blocks.ts for the exact MVP boundary.
 *
 * Only the blocker may ever read their own block doc — the blocked user
 * is never told they were blocked (see firestore.rules).
 *
 * No copied profile data, no email, no reason field.
 */
export type Block = {
  blockId: string;
  blockerUid: string;
  blockedUid: string;
  createdAt: Timestamp;
};
