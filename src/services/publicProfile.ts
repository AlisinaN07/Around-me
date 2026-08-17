/**
 * Public social profiles — the publicProfiles/{uid} collection. UI code
 * should only ever import from here, never talk to Firestore directly for
 * public profile data, and never read another user's private users/{uid}
 * document (that stays owner-only — see firestore.rules).
 */

import { doc, getDoc, serverTimestamp, setDoc, type WithFieldValue } from 'firebase/firestore';

import type { PublicProfile } from '@/types/social';
import type { UsernameReservation } from '@/types/user';
import { normalizeUsername } from '@/utils/username';

import { firestore } from './firestore';
import { fetchUserProfile } from './userProfile';

const PUBLIC_PROFILES_COLLECTION = 'publicProfiles';
const USERNAMES_COLLECTION = 'usernames';

export async function fetchPublicProfile(uid: string): Promise<PublicProfile | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(doc(firestore, PUBLIC_PROFILES_COLLECTION, uid));
  return snapshot.exists() ? (snapshot.data() as PublicProfile) : null;
}

/** Resolves a username to a uid via the existing usernames/{usernameLower} reservation, then reads the public profile — never scans publicProfiles itself. */
export async function fetchPublicProfileByUsername(username: string): Promise<PublicProfile | null> {
  if (!firestore) return null;
  const normalized = normalizeUsername(username);
  if (!normalized.valid) return null;

  const reservationSnapshot = await getDoc(doc(firestore, USERNAMES_COLLECTION, normalized.usernameLower));
  if (!reservationSnapshot.exists()) return null;

  const { uid } = reservationSnapshot.data() as UsernameReservation;
  return fetchPublicProfile(uid);
}

export type EnsurePublicProfileResult =
  | { ok: true; profile: PublicProfile }
  | { ok: false; error: 'not-configured' | 'no-profile' | 'unknown'; message: string };

/**
 * Lazy migration for accounts that completed onboarding before Step 11 (so
 * they have a users/{uid} but no publicProfiles/{uid} yet) — owner-only,
 * never touches anyone else's profile. If a public profile already exists
 * it's returned as-is; this never overwrites one. Values come only from the
 * caller's own private profile, matching exactly what Firestore rules
 * independently require on create.
 */
export async function ensureMyPublicProfile(uid: string): Promise<EnsurePublicProfileResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const existing = await fetchPublicProfile(uid);
  if (existing) {
    return { ok: true, profile: existing };
  }

  const privateProfile = await fetchUserProfile(uid);
  if (!privateProfile || !privateProfile.onboardingCompleted) {
    return { ok: false, error: 'no-profile', message: 'Complete your profile first.' };
  }

  const data = {
    uid,
    displayName: privateProfile.displayName,
    username: privateProfile.username,
    usernameLower: privateProfile.usernameLower,
    cityName: privateProfile.cityName,
    countryCode: privateProfile.countryCode,
    cityKey: privateProfile.cityKey,
    interests: privateProfile.interests,
    accountType: privateProfile.accountType,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<PublicProfile>;

  try {
    await setDoc(doc(firestore, PUBLIC_PROFILES_COLLECTION, uid), data);
  } catch {
    // A concurrent ensure() call may have just created it — Firestore rules
    // deny overwriting an existing public profile (create-only), so a
    // failure here most likely means that race, not a real error.
    const raceProfile = await fetchPublicProfile(uid);
    if (raceProfile) return { ok: true, profile: raceProfile };
    return { ok: false, error: 'unknown', message: "Couldn't set up your public profile." };
  }

  const created = await fetchPublicProfile(uid);
  if (!created) {
    return { ok: false, error: 'unknown', message: 'Public profile was created but could not be read back.' };
  }
  return { ok: true, profile: created };
}
