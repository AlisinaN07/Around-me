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

/**
 * Profile-picture upload cap (Edit Profile) — mirrors the Reel thumbnail's
 * own Storage Rules size cap in storage.rules, just smaller since this is a
 * single still image, not a video cover frame.
 */
export const PROFILE_PHOTO_MAX_SIZE_BYTES = 5 * 1024 * 1024;

/** Same idea as PROFILE_PHOTO_MAX_SIZE_BYTES, just a bit larger since a cover banner is a wider image. */
export const PROFILE_COVER_PHOTO_MAX_SIZE_BYTES = 8 * 1024 * 1024;

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
  /**
   * A resolved, ready-to-render download URL for the Storage object at
   * profilePhotos/{uid}/photo (see uploadProfilePhoto/updateMyProfilePhoto
   * in src/services/userProfile.ts) — never a bare Storage path, so every
   * call site (Avatar) can render it directly with no async resolution
   * step. Always a string, never null/undefined: no picture set yet (or an
   * account created before this field existed) simply reads back as ''
   * (see fetchUserProfile/fetchPublicProfile), and Avatar falls back to
   * initials whenever it's empty.
   */
  photoURL: string;
  /**
   * Same shape/convention as photoURL, for the Storage object at
   * profileCovers/{uid}/photo — the banner shown behind the avatar on the
   * Profile header (see ProfileHeader.tsx). Always a string, '' when no
   * cover is set; ProfileHeader simply renders no banner at all when empty,
   * same as Avatar falling back to initials.
   */
  coverPhotoURL: string;
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
