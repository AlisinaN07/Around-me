/**
 * User profile data layer. UI code should only ever import from here —
 * never talk to Firestore directly for user profile data.
 */

import { doc, getDoc, runTransaction, serverTimestamp, type WithFieldValue } from 'firebase/firestore';

import type { UserProfile, UsernameReservation } from '@/types/user';
import { buildCityKey } from '@/utils/cityKey';
import { normalizeUsername } from '@/utils/username';

import { firestore } from './firestore';

const USERS_COLLECTION = 'users';
const USERNAMES_COLLECTION = 'usernames';

export type UsernameAvailabilityResult =
  | { available: true; usernameLower: string }
  | { available: false; reason: string };

export type CreateInitialProfileInput = {
  uid: string;
  email: string;
  displayName: string;
  username: string;
  cityName: string;
  countryCode: string;
  interests: string[];
};

export type CreateInitialProfileError =
  | 'not-configured'
  | 'invalid-username'
  | 'invalid-city'
  | 'username-taken'
  | 'profile-exists'
  | 'unknown';

export type CreateInitialProfileResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; error: CreateInitialProfileError; message: string };

class ProfileTransactionError extends Error {
  constructor(public code: 'username-taken' | 'profile-exists') {
    super(code);
  }
}

/** Reads the caller's own profile. Returns null if it doesn't exist yet. */
export async function fetchUserProfile(uid: string): Promise<UserProfile | null> {
  if (!firestore) {
    return null;
  }
  const snapshot = await getDoc(doc(firestore, USERS_COLLECTION, uid));
  return snapshot.exists() ? (snapshot.data() as UserProfile) : null;
}

/** Lightweight existence check — does not reserve the username. */
export async function checkUsernameAvailability(username: string): Promise<UsernameAvailabilityResult> {
  if (!firestore) {
    return { available: false, reason: 'Firestore is not available.' };
  }

  const normalized = normalizeUsername(username);
  if (!normalized.valid) {
    return { available: false, reason: normalized.reason };
  }

  const snapshot = await getDoc(doc(firestore, USERNAMES_COLLECTION, normalized.usernameLower));
  if (snapshot.exists()) {
    return { available: false, reason: 'That username is already taken.' };
  }

  return { available: true, usernameLower: normalized.usernameLower };
}

/**
 * Atomically reserves a username and creates the caller's profile.
 * Rejects rather than overwrites if a profile or the username already exists.
 */
export async function createInitialUserProfile(
  input: CreateInitialProfileInput
): Promise<CreateInitialProfileResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }

  const normalizedUsername = normalizeUsername(input.username);
  if (!normalizedUsername.valid) {
    return { ok: false, error: 'invalid-username', message: normalizedUsername.reason };
  }

  const cityName = input.cityName.trim();
  const countryCode = input.countryCode.trim();
  if (!cityName || !countryCode) {
    return { ok: false, error: 'invalid-city', message: 'City and country are required.' };
  }
  const cityKey = buildCityKey(countryCode, cityName);

  const userRef = doc(firestore, USERS_COLLECTION, input.uid);
  const usernameRef = doc(firestore, USERNAMES_COLLECTION, normalizedUsername.usernameLower);

  try {
    await runTransaction(firestore, async (transaction) => {
      const [existingProfile, existingUsername] = await Promise.all([
        transaction.get(userRef),
        transaction.get(usernameRef),
      ]);

      if (existingProfile.exists()) {
        throw new ProfileTransactionError('profile-exists');
      }
      if (existingUsername.exists()) {
        throw new ProfileTransactionError('username-taken');
      }

      transaction.set(usernameRef, {
        uid: input.uid,
        createdAt: serverTimestamp(),
      } satisfies WithFieldValue<UsernameReservation>);

      transaction.set(userRef, {
        uid: input.uid,
        email: input.email,
        displayName: input.displayName.trim(),
        username: normalizedUsername.username,
        usernameLower: normalizedUsername.usernameLower,
        cityName,
        countryCode,
        cityKey,
        interests: input.interests,
        accountType: 'personal',
        onboardingCompleted: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<UserProfile>);
    });
  } catch (error) {
    if (error instanceof ProfileTransactionError) {
      const message =
        error.code === 'profile-exists' ? 'A profile already exists for this account.' : 'That username is already taken.';
      return { ok: false, error: error.code, message };
    }
    return { ok: false, error: 'unknown', message: 'Something went wrong creating your profile.' };
  }

  const profile = await fetchUserProfile(input.uid);
  if (!profile) {
    return { ok: false, error: 'unknown', message: 'Profile was created but could not be read back.' };
  }
  return { ok: true, profile };
}
