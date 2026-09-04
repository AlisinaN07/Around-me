import type { Timestamp } from 'firebase/firestore';

/**
 * Step 30 — Around Me supports two account types from signup, deliberately
 * almost identical: `business` is `personal` plus the ability to create
 * Events (see canCreateEvent in src/utils/accountCapabilities.ts). No
 * separate business application, verification, subscription, or dashboard
 * exists — see README "Personal and Business accounts".
 */
export type AccountType = 'personal' | 'business';

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
