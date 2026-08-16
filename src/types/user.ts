import type { Timestamp } from 'firebase/firestore';

export type AccountType = 'personal';

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
