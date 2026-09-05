import type { Timestamp } from 'firebase/firestore';

/**
 * Step 30 — Around Me supports two account types from signup, deliberately
 * almost identical: `business` is `personal` plus the ability to create
 * Events (see canCreateEvent in src/utils/accountCapabilities.ts). No
 * separate business application, verification, subscription, or dashboard
 * exists — see README "Personal and Business accounts".
 */
export type AccountType = 'personal' | 'business';

/** Same bounds used at onboarding (src/app/(onboarding)/name.tsx) and Edit Profile (Step 33) — one shared rule, not two. */
export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 50;

/**
 * Step 33 — optional free-text bio. Always stored as a string, never null/
 * undefined: existing accounts created before this field existed simply
 * have it read back as '' (see fetchUserProfile/fetchPublicProfile), never
 * a missing key that call sites have to special-case.
 */
export const BIO_MAX_LENGTH = 160;

/** users/{uid} — private to its owner. */
export type UserProfile = {
  uid: string;
  email: string;
  displayName: string;
  /** Display casing as chosen by the user. */
  username: string;
  /** Canonical lowercase form used for uniqueness — matches usernames/{usernameLower}. */
  usernameLower: string;
  cityName: string;
  countryCode: string;
  /** Normalized "{countryCode}:{cityName}" key used for city-based filtering. */
  cityKey: string;
  interests: string[];
  /** Optional, plain text only — no links/hashtags system. See BIO_MAX_LENGTH. */
  bio: string;
  accountType: AccountType;
  onboardingCompleted: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

/** usernames/{usernameLower} — reserves a username for exactly one uid. */
export type UsernameReservation = {
  uid: string;
  createdAt: Timestamp;
};
