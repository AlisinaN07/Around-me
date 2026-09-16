/**
 * Public social profiles — the publicProfiles/{uid} collection. UI code
 * should only ever import from here, never talk to Firestore directly for
 * public profile data, and never read another user's private users/{uid}
 * document (that stays owner-only — see firestore.rules).
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type WithFieldValue,
} from 'firebase/firestore';

import type { PublicProfile } from '@/types/social';
import type { UsernameReservation } from '@/types/user';
import { normalizeUsername } from '@/utils/username';
import { TtlCache } from '@/utils/requestCache';

import { firestore } from './firestore';
import { fetchUserProfile } from './userProfile';

const PUBLIC_PROFILES_COLLECTION = 'publicProfiles';
const USERNAMES_COLLECTION = 'usernames';
const SEARCH_RESULT_LIMIT = 20;

// Phase 2 perf pass — fetchPublicProfile is called from ~20 call sites
// across the app (every feed item's author, Inbox's rows and following
// row, chat, SoundSheet, Event detail's author row, ...) with no sharing
// between them today; this is the single highest-leverage cache in the
// app (see the Phase 0 audit). Keyed by `uid` alone — a public profile is
// the same document for every viewer, nothing account-specific to worry
// about here (unlike isFollowing/isPostSaved below). 60s TTL: profiles
// change rarely enough that a full minute of staleness is unnoticeable,
// but see invalidatePublicProfile below for the cases that can't wait
// even that long.
const PUBLIC_PROFILE_CACHE_TTL_MS = 60_000;
const profileCache = new TtlCache<PublicProfile>(PUBLIC_PROFILE_CACHE_TTL_MS);

/**
 * Call after any write that changes the CURRENT user's own
 * publicProfiles/{uid} document (photo, cover photo, display name/
 * username/bio, interests, Business conversion — see userProfile.ts's own
 * updateMyProfile/updateMyProfilePhoto/updateMyProfileCoverPhoto/
 * upgradeToBusinessAccount, each of which calls this on success) so the
 * next fetchPublicProfile for this uid — anywhere in the app — does a
 * real read instead of serving up to 60s of stale data. Exported rather
 * than folded into fetchPublicProfile's own file-private cache object so
 * userProfile.ts (which owns every actual public-profile write) can call
 * it without reaching into this module's internals.
 */
export function invalidatePublicProfile(uid: string): void {
  profileCache.delete(uid);
}

/** Normalizes a missing `bio`/`photoURL` (public profiles created before those fields existed) to '' — see fetchUserProfile's identical rule. */
export async function fetchPublicProfile(uid: string): Promise<PublicProfile | null> {
  const cached = profileCache.getFresh(uid);
  if (cached) return cached;
  if (!firestore) return null;
  // Narrowed local binding — the null-check above doesn't carry into the
  // closure passed to dedupe() below (same reasoning as every
  // runTransaction callback elsewhere in this codebase, e.g.
  // userProfile.ts's own `const db = firestore`).
  const db = firestore;
  // Dedupe first, cache after: a "not found" result (a genuinely missing
  // profile, or the exact instant before ensureMyPublicProfile's own
  // create commits — see its read-after-write) is deliberately never
  // written to the cache, so it can never keep reporting "not found"
  // after the profile actually starts existing. Concurrent callers for
  // the SAME uid (e.g. several ReelFeedItems by the same author mounting
  // at once) still only ever trigger one real Firestore read either way.
  const profile = await profileCache.dedupe(uid, async () => {
    const snapshot = await getDoc(doc(db, PUBLIC_PROFILES_COLLECTION, uid));
    if (!snapshot.exists()) return null;
    const data = snapshot.data() as PublicProfile;
    return { ...data, bio: data.bio ?? '', photoURL: data.photoURL ?? '', coverPhotoURL: data.coverPhotoURL ?? '' };
  });
  if (profile) profileCache.set(uid, profile);
  return profile;
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
    // privateProfile.bio/photoURL/coverPhotoURL are already normalized to
    // '' by fetchUserProfile above when missing (pre-existing accounts) —
    // never omitted here.
    bio: privateProfile.bio,
    photoURL: privateProfile.photoURL,
    coverPhotoURL: privateProfile.coverPhotoURL,
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

/**
 * Global people search (Step 37) — a `usernameLower` prefix range query
 * directly against `publicProfiles`, the same collection every other
 * profile lookup here already reads from. There is no separate search
 * index: a deleted account's `publicProfiles/{uid}` is gone (see the
 * account-deletion backend), so it naturally stops appearing here with no
 * stale-index cleanup ever required; a changed username is read from this
 * same live document, so the old prefix stops matching and the new one
 * starts matching immediately, atomically with the rename itself.
 *
 * `normalizedQuery` must already be lower-cased (see
 * `normalizeUsernameSearchQuery`) — this function does not re-normalize,
 * so callers control exactly what's queried. Deliberately does not filter
 * by `accountType`: Personal and Business accounts are equally
 * discoverable by username (Step 37 locked scope).
 */
export async function searchPublicProfilesByUsername(normalizedQuery: string): Promise<PublicProfile[]> {
  if (!firestore) return [];
  if (!normalizedQuery) return [];

  const snapshot = await getDocs(
    query(
      collection(firestore, PUBLIC_PROFILES_COLLECTION),
      orderBy('usernameLower'),
      where('usernameLower', '>=', normalizedQuery),
      where('usernameLower', '<=', `${normalizedQuery}`),
      limit(SEARCH_RESULT_LIMIT)
    )
  );
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as PublicProfile);
}
