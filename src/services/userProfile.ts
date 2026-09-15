/**
 * User profile data layer. UI code should only ever import from here —
 * never talk to Firestore directly for user profile data.
 */

import { doc, getDoc, runTransaction, serverTimestamp, type WithFieldValue } from 'firebase/firestore';
import { getDownloadURL, ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';

import type { PublicProfile } from '@/types/social';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  PROFILE_COVER_PHOTO_MAX_SIZE_BYTES,
  PROFILE_PHOTO_MAX_SIZE_BYTES,
  type AccountType,
  type UserProfile,
  type UsernameReservation,
} from '@/types/user';
import { MAX_INTERESTS, MIN_INTERESTS } from '@/constants/interests';
import { buildCityKey } from '@/utils/cityKey';
import { normalizeUsername } from '@/utils/username';

import { firestore } from './firestore';
import { storage } from './storage';

const USERS_COLLECTION = 'users';
const USERNAMES_COLLECTION = 'usernames';
const PUBLIC_PROFILES_COLLECTION = 'publicProfiles';

export type UsernameAvailabilityResult =
  | { available: true; usernameLower: string }
  | { available: false; reason: string };

export type CreateInitialProfileInput = {
  uid: string;
  email: string;
  /** Chosen on the first onboarding screen (Step 30) — 'personal' or 'business', never anything else. */
  accountType: AccountType;
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

/**
 * Reads the caller's own profile. Returns null if it doesn't exist yet.
 * Normalizes a missing `bio` (accounts created before Step 33) to '' —
 * every call site can treat profile.bio as always a real string.
 */
export async function fetchUserProfile(uid: string): Promise<UserProfile | null> {
  if (!firestore) {
    return null;
  }
  const snapshot = await getDoc(doc(firestore, USERS_COLLECTION, uid));
  if (!snapshot.exists()) return null;
  const data = snapshot.data() as UserProfile;
  return { ...data, bio: data.bio ?? '', photoURL: data.photoURL ?? '', coverPhotoURL: data.coverPhotoURL ?? '' };
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
  const publicProfileRef = doc(firestore, PUBLIC_PROFILES_COLLECTION, input.uid);

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

      const displayName = input.displayName.trim();

      transaction.set(usernameRef, {
        uid: input.uid,
        createdAt: serverTimestamp(),
      } satisfies WithFieldValue<UsernameReservation>);

      transaction.set(userRef, {
        uid: input.uid,
        email: input.email,
        displayName,
        username: normalizedUsername.username,
        usernameLower: normalizedUsername.usernameLower,
        cityName,
        countryCode,
        cityKey,
        interests: input.interests,
        // Step 33 — canonical empty-string representation, never omitted
        // and never null. Onboarding itself doesn't collect a bio yet
        // (Edit Profile is the only place that sets a real one).
        bio: '',
        // Same canonical empty-string convention as bio — onboarding
        // doesn't collect a photo either (Edit Profile is the only place
        // that sets a real one, via updateMyProfilePhoto below).
        photoURL: '',
        coverPhotoURL: '',
        accountType: input.accountType,
        onboardingCompleted: true,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<UserProfile>);

      // Public-safe snapshot of the same profile, created atomically with it
      // — see src/types/social.ts. Never partially committed: this is the
      // same transaction as the private profile + username reservation
      // above, so either all three documents exist or none do.
      transaction.set(publicProfileRef, {
        uid: input.uid,
        displayName,
        username: normalizedUsername.username,
        usernameLower: normalizedUsername.usernameLower,
        cityName,
        countryCode,
        cityKey,
        interests: input.interests,
        bio: '',
        photoURL: '',
        coverPhotoURL: '',
        accountType: input.accountType,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<PublicProfile>);
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

export type UpdateProfileInput = {
  uid: string;
  displayName: string;
  username: string;
  bio: string;
  interests: string[];
};

export type UpdateProfileError =
  | 'not-configured'
  | 'no-profile'
  | 'invalid-display-name'
  | 'invalid-username'
  | 'username-taken'
  | 'invalid-bio'
  | 'invalid-interests'
  | 'unknown';

export type UpdateProfileResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; error: UpdateProfileError; message: string };

class UpdateProfileTransactionError extends Error {
  constructor(public code: 'no-profile' | 'username-taken') {
    super(code);
  }
}

/**
 * Step 33 — Edit Profile. Atomically updates displayName/username/bio/
 * interests on both users/{uid} and publicProfiles/{uid}, and — only when
 * the normalized username actually changes — reserves the new
 * usernames/{newUsernameLower} doc and releases the old one, all in the
 * same transaction. Never touches email/cityName/countryCode/cityKey/
 * accountType/onboardingCompleted/createdAt (firestore.rules independently
 * enforces the same immutability — this is defense in depth, not the only
 * guarantee).
 */
export async function updateMyProfile(input: UpdateProfileInput): Promise<UpdateProfileResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }
  // Narrowed local binding — TypeScript's null-check on the module-level
  // `firestore` doesn't carry into the transaction callback closure below.
  const db = firestore;

  const trimmedDisplayName = input.displayName.trim();
  if (trimmedDisplayName.length < DISPLAY_NAME_MIN_LENGTH || trimmedDisplayName.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      ok: false,
      error: 'invalid-display-name',
      message: `Enter a name between ${DISPLAY_NAME_MIN_LENGTH} and ${DISPLAY_NAME_MAX_LENGTH} characters.`,
    };
  }

  const normalizedUsername = normalizeUsername(input.username);
  if (!normalizedUsername.valid) {
    return { ok: false, error: 'invalid-username', message: normalizedUsername.reason };
  }

  // Trimmed, not otherwise sanitized — plain text only, no HTML/link/
  // hashtag parsing exists or is planned for bio (Step 33 Section 12).
  const trimmedBio = input.bio.trim();
  if (trimmedBio.length > BIO_MAX_LENGTH) {
    return { ok: false, error: 'invalid-bio', message: `Bio must be ${BIO_MAX_LENGTH} characters or fewer.` };
  }

  if (input.interests.length < MIN_INTERESTS || input.interests.length > MAX_INTERESTS) {
    return {
      ok: false,
      error: 'invalid-interests',
      message: `Choose between ${MIN_INTERESTS} and ${MAX_INTERESTS} interests.`,
    };
  }

  const userRef = doc(db, USERS_COLLECTION, input.uid);
  const publicProfileRef = doc(db, PUBLIC_PROFILES_COLLECTION, input.uid);

  try {
    await runTransaction(db, async (transaction) => {
      // All reads before any write, per Firestore transaction rules.
      const userSnapshot = await transaction.get(userRef);
      if (!userSnapshot.exists()) {
        throw new UpdateProfileTransactionError('no-profile');
      }
      const current = userSnapshot.data() as UserProfile;

      const usernameChanged = normalizedUsername.usernameLower !== current.usernameLower;
      const newUsernameRef = usernameChanged
        ? doc(db, USERNAMES_COLLECTION, normalizedUsername.usernameLower)
        : null;

      if (newUsernameRef) {
        const newUsernameSnapshot = await transaction.get(newUsernameRef);
        if (newUsernameSnapshot.exists()) {
          throw new UpdateProfileTransactionError('username-taken');
        }
      }

      const sharedUpdate = {
        displayName: trimmedDisplayName,
        username: normalizedUsername.username,
        usernameLower: normalizedUsername.usernameLower,
        bio: trimmedBio,
        interests: input.interests,
        updatedAt: serverTimestamp(),
      };

      transaction.update(userRef, sharedUpdate);
      transaction.update(publicProfileRef, sharedUpdate);

      // Reserve the new username and release the old one only when it's
      // actually changing (Section 11) — keeping the same username never
      // touches the usernames/{...} collection at all.
      if (newUsernameRef) {
        transaction.set(newUsernameRef, {
          uid: input.uid,
          createdAt: serverTimestamp(),
        } satisfies WithFieldValue<UsernameReservation>);
        transaction.delete(doc(db, USERNAMES_COLLECTION, current.usernameLower));
      }
    });
  } catch (error) {
    if (error instanceof UpdateProfileTransactionError) {
      const message = error.code === 'no-profile' ? 'Profile not found.' : 'That username is already taken.';
      return { ok: false, error: error.code, message };
    }
    return { ok: false, error: 'unknown', message: "Couldn't save your profile." };
  }

  const profile = await fetchUserProfile(input.uid);
  if (!profile) {
    return { ok: false, error: 'unknown', message: 'Profile was updated but could not be read back.' };
  }
  return { ok: true, profile };
}

export type UpdateProfilePhotoResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; error: 'not-configured' | 'no-profile' | 'unknown'; message: string };

class UpdateProfilePhotoTransactionError extends Error {
  constructor() {
    super('no-profile');
  }
}

/**
 * Edit Profile's picture upload, second half — call this only after
 * uploadProfilePhoto below has finished. Writes the resolved download URL
 * to both users/{uid}.photoURL and publicProfiles/{uid}.photoURL in one
 * transaction, exactly like updateMyProfile keeps the two documents in
 * lockstep for displayName/username/bio/interests. `photoURL` is a real,
 * already-resolved HTTPS download URL (from getDownloadURL), never a bare
 * Storage path — see UserProfile.photoURL's own doc comment.
 */
export async function updateMyProfilePhoto(uid: string, photoURL: string): Promise<UpdateProfilePhotoResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }
  const db = firestore;

  const userRef = doc(db, USERS_COLLECTION, uid);
  const publicProfileRef = doc(db, PUBLIC_PROFILES_COLLECTION, uid);

  try {
    await runTransaction(db, async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      if (!userSnapshot.exists()) {
        throw new UpdateProfilePhotoTransactionError();
      }
      const update = { photoURL, updatedAt: serverTimestamp() };
      transaction.update(userRef, update);
      transaction.update(publicProfileRef, update);
    });
  } catch (error) {
    if (error instanceof UpdateProfilePhotoTransactionError) {
      return { ok: false, error: 'no-profile', message: 'Profile not found.' };
    }
    return { ok: false, error: 'unknown', message: "Couldn't save your profile photo." };
  }

  const profile = await fetchUserProfile(uid);
  if (!profile) {
    return { ok: false, error: 'unknown', message: 'Photo was saved but could not be read back.' };
  }
  return { ok: true, profile };
}

export type UpgradeToBusinessAccountResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; error: 'not-configured' | 'no-profile' | 'already-business' | 'unknown'; message: string };

class UpgradeToBusinessAccountTransactionError extends Error {
  constructor(public code: 'no-profile' | 'already-business') {
    super(code);
  }
}

/**
 * Settings -> Switch to Business account. A DELIBERATELY ONE-WAY
 * transition — firestore.rules only ever permits accountType to move
 * personal -> business, never the reverse (see the dedicated second
 * `allow update` on users/{uid}, Step 35); the `already-business` guard
 * here just gives a friendlier error than letting a redundant call hit
 * that rule and fail as 'unknown'. Updates users/{uid} and
 * publicProfiles/{uid} together in one transaction, touching ONLY
 * accountType/updatedAt on each — same dual-document-in-lockstep pattern
 * as updateMyProfile above, just narrower.
 */
export async function upgradeToBusinessAccount(uid: string): Promise<UpgradeToBusinessAccountResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }
  const db = firestore;

  const userRef = doc(db, USERS_COLLECTION, uid);
  const publicProfileRef = doc(db, PUBLIC_PROFILES_COLLECTION, uid);

  try {
    await runTransaction(db, async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      if (!userSnapshot.exists()) {
        throw new UpgradeToBusinessAccountTransactionError('no-profile');
      }
      const current = userSnapshot.data() as UserProfile;
      if (current.accountType === 'business') {
        throw new UpgradeToBusinessAccountTransactionError('already-business');
      }
      const update = { accountType: 'business' as const, updatedAt: serverTimestamp() };
      transaction.update(userRef, update);
      transaction.update(publicProfileRef, update);
    });
  } catch (error) {
    if (error instanceof UpgradeToBusinessAccountTransactionError) {
      const message = error.code === 'no-profile' ? 'Profile not found.' : 'Your account is already a Business account.';
      return { ok: false, error: error.code, message };
    }
    return { ok: false, error: 'unknown', message: "Couldn't switch your account type." };
  }

  const profile = await fetchUserProfile(uid);
  if (!profile) {
    return { ok: false, error: 'unknown', message: 'Account type was updated but could not be read back.' };
  }
  return { ok: true, profile };
}

export type UploadProfilePhotoHandle = { cancel: () => void };

/**
 * Uploads a locally-picked image to the deterministic Storage object at
 * profilePhotos/{uid}/photo (see storage.rules — unlike Reel media this
 * path allows `update`, so re-uploading simply replaces the old photo in
 * place). Same progress/cancel shape as uploadReelThumbnail in
 * src/services/reels.ts. Does NOT touch Firestore itself — call
 * updateMyProfilePhoto with the resolved download URL once onComplete
 * reports success.
 */
export function uploadProfilePhoto(
  uid: string,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true; photoURL: string } | { ok: false; message: string }) => void
): UploadProfilePhotoHandle {
  let cancelled = false;
  let task: UploadTask | null = null;

  (async () => {
    if (!storage) {
      onComplete({ ok: false, message: 'Storage is not available.' });
      return;
    }

    let blob: Blob;
    try {
      const response = await fetch(localUri);
      blob = await response.blob();
    } catch {
      onComplete({ ok: false, message: "Couldn't read the selected photo." });
      return;
    }
    if (cancelled) return;

    if (blob.size > PROFILE_PHOTO_MAX_SIZE_BYTES) {
      onComplete({ ok: false, message: 'That photo is too large. Choose one under 5 MB.' });
      return;
    }

    const objectRef = ref(storage, `profilePhotos/${uid}/photo`);
    task = uploadBytesResumable(objectRef, blob, { contentType: blob.type || 'image/jpeg' });

    task.on(
      'state_changed',
      (snapshot) => {
        const percent = snapshot.totalBytes > 0 ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0;
        onProgress(percent);
      },
      (error) => {
        if (error.code === 'storage/canceled') {
          onComplete({ ok: false, message: 'Upload cancelled.' });
          return;
        }
        onComplete({ ok: false, message: "Couldn't upload your photo." });
      },
      async () => {
        try {
          const photoURL = await getDownloadURL(objectRef);
          onComplete({ ok: true, photoURL });
        } catch {
          onComplete({ ok: false, message: "Uploaded, but couldn't finish saving your photo." });
        }
      }
    );
  })();

  return {
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}

export type UpdateProfileCoverPhotoResult =
  | { ok: true; profile: UserProfile }
  | { ok: false; error: 'not-configured' | 'no-profile' | 'unknown'; message: string };

class UpdateProfileCoverPhotoTransactionError extends Error {
  constructor() {
    super('no-profile');
  }
}

/**
 * Cover/banner counterpart to updateMyProfilePhoto — exact same shape,
 * just writing coverPhotoURL instead of photoURL. Call this only after
 * uploadProfileCoverPhoto below has finished.
 */
export async function updateMyProfileCoverPhoto(uid: string, coverPhotoURL: string): Promise<UpdateProfileCoverPhotoResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }
  const db = firestore;

  const userRef = doc(db, USERS_COLLECTION, uid);
  const publicProfileRef = doc(db, PUBLIC_PROFILES_COLLECTION, uid);

  try {
    await runTransaction(db, async (transaction) => {
      const userSnapshot = await transaction.get(userRef);
      if (!userSnapshot.exists()) {
        throw new UpdateProfileCoverPhotoTransactionError();
      }
      const update = { coverPhotoURL, updatedAt: serverTimestamp() };
      transaction.update(userRef, update);
      transaction.update(publicProfileRef, update);
    });
  } catch (error) {
    if (error instanceof UpdateProfileCoverPhotoTransactionError) {
      return { ok: false, error: 'no-profile', message: 'Profile not found.' };
    }
    return { ok: false, error: 'unknown', message: "Couldn't save your cover photo." };
  }

  const profile = await fetchUserProfile(uid);
  if (!profile) {
    return { ok: false, error: 'unknown', message: 'Cover photo was saved but could not be read back.' };
  }
  return { ok: true, profile };
}

export type UploadProfileCoverPhotoHandle = { cancel: () => void };

/**
 * Cover/banner counterpart to uploadProfilePhoto — exact same shape,
 * uploading to profileCovers/{uid}/photo instead (see storage.rules, same
 * create-or-update-in-place path), just with the larger
 * PROFILE_COVER_PHOTO_MAX_SIZE_BYTES cap.
 */
export function uploadProfileCoverPhoto(
  uid: string,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true; coverPhotoURL: string } | { ok: false; message: string }) => void
): UploadProfileCoverPhotoHandle {
  let cancelled = false;
  let task: UploadTask | null = null;

  (async () => {
    if (!storage) {
      onComplete({ ok: false, message: 'Storage is not available.' });
      return;
    }

    let blob: Blob;
    try {
      const response = await fetch(localUri);
      blob = await response.blob();
    } catch {
      onComplete({ ok: false, message: "Couldn't read the selected photo." });
      return;
    }
    if (cancelled) return;

    if (blob.size > PROFILE_COVER_PHOTO_MAX_SIZE_BYTES) {
      onComplete({ ok: false, message: 'That photo is too large. Choose one under 8 MB.' });
      return;
    }

    const objectRef = ref(storage, `profileCovers/${uid}/photo`);
    task = uploadBytesResumable(objectRef, blob, { contentType: blob.type || 'image/jpeg' });

    task.on(
      'state_changed',
      (snapshot) => {
        const percent = snapshot.totalBytes > 0 ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0;
        onProgress(percent);
      },
      (error) => {
        if (error.code === 'storage/canceled') {
          onComplete({ ok: false, message: 'Upload cancelled.' });
          return;
        }
        onComplete({ ok: false, message: "Couldn't upload your cover photo." });
      },
      async () => {
        try {
          const coverPhotoURL = await getDownloadURL(objectRef);
          onComplete({ ok: true, coverPhotoURL });
        } catch {
          onComplete({ ok: false, message: "Uploaded, but couldn't finish saving your cover photo." });
        }
      }
    );
  })();

  return {
    cancel: () => {
      cancelled = true;
      task?.cancel();
    },
  };
}
