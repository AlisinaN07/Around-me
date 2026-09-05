import type { Timestamp } from 'firebase/firestore';

import type { AccountType } from '@/types/user';

/**
 * publicProfiles/{uid} — the social-facing counterpart to the private
 * users/{uid} document. Contains ONLY fields that are safe to show to any
 * signed-in Around Me user (never email, GPS, tokens, or other private
 * account data). Every field here must exactly match the corresponding
 * field on the caller's own users/{uid} profile — enforced by Firestore
 * rules on create, not just convention.
 */
export type PublicProfile = {
  uid: string;
  displayName: string;
  username: string;
  usernameLower: string;
  cityName: string;
  countryCode: string;
  cityKey: string;
  interests: string[];
  /** Mirrors users/{uid}.bio exactly — see types/user.ts. Always a string, never missing. */
  bio: string;
  accountType: AccountType;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

/**
 * follows/{followId} — a directed edge in the social graph, keyed by the
 * deterministic ID `{followerUid}_{followingUid}` (see
 * src/services/following.ts), which is itself what guarantees at most one
 * follow per (follower, following) pair. No copied profile data — resolve
 * to publicProfiles/{uid} for display.
 */
export type Follow = {
  followerUid: string;
  followingUid: string;
  createdAt: Timestamp;
};
