/**
 * Reels data layer — the separate reels/{reelId} root collection (see
 * src/types/reel.ts for why this is not part of content/{contentId}) plus
 * its paired Cloud Storage object at reels/{authorUid}/{reelId}/source.
 * UI code should only ever import from here, never talk to
 * Firestore/Storage directly for Reels.
 *
 * Two-phase lifecycle (see firestore.rules and storage.rules):
 *   1. createReelDraft — Firestore doc, status "uploading", publishedAt null.
 *   2. uploadReelVideo — Cloud Storage upload to the exact reserved path.
 *   3. publishReel — status "uploading" -> "published" (the only allowed
 *      update once the draft exists).
 * A Reel is never created directly as "published" — Storage Rules require
 * an existing "uploading" draft naming that exact path before any upload
 * to it is accepted, and Firestore Rules require the same before publish.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type WithFieldValue,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';

import { INTERESTS } from '@/constants/interests';
import {
  REEL_CAPTION_MAX_LENGTH,
  REEL_MAX_DURATION_MS,
  REEL_MAX_FILE_SIZE_BYTES,
  type Reel,
} from '@/types/reel';

import { firestore } from './firestore';
import { storage } from './storage';
import { fetchUserProfile } from './userProfile';

const REELS_COLLECTION = 'reels';
const DEFAULT_FEED_LIMIT = 20;
const DEFAULT_PROFILE_REEL_LIMIT = 30;
const VALID_CATEGORY_IDS = new Set(INTERESTS.map((interest) => interest.id));

/** Exported so reelEngagement.ts can reference the same document without a second constant. */
export function reelRef(reelId: string) {
  return doc(firestore!, REELS_COLLECTION, reelId);
}

/** reels/{authorUid}/{reelId}/source — deterministic, ownership-aware. Never derived from a user-supplied filename. */
export function reelStoragePath(authorUid: string, reelId: string): string {
  return `reels/${authorUid}/${reelId}/source`;
}

function isValidCategoryId(categoryId: string): boolean {
  return VALID_CATEGORY_IDS.has(categoryId);
}

export async function fetchReel(reelId: string): Promise<Reel | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(reelRef(reelId));
  return snapshot.exists() ? (snapshot.data() as Reel) : null;
}

// ---------------------------------------------------------------------------
// Phase 1 — create the Firestore draft
// ---------------------------------------------------------------------------

export type CreateReelDraftInput = {
  uid: string;
  categoryId: string;
  caption: string;
  storageContentType: string;
  fileSizeBytes: number;
  /**
   * Declared duration in milliseconds from the picked asset's own metadata
   * — see src/types/reel.ts's Reel.durationMs doc comment for why this is
   * a client-declared value, not a verified one.
   */
  durationMs: number;
  width: number;
  height: number;
};

export type ReelDraftError = 'not-configured' | 'no-profile' | 'invalid-input' | 'unknown';
export type CreateReelDraftResult = { ok: true; reel: Reel } | { ok: false; error: ReelDraftError; message: string };

export async function createReelDraft(input: CreateReelDraftInput): Promise<CreateReelDraftResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }

  const profile = await fetchUserProfile(input.uid);
  if (!profile || !profile.onboardingCompleted) {
    return { ok: false, error: 'no-profile', message: 'Complete your profile before creating a Reel.' };
  }

  const caption = input.caption.trim();
  if (caption.length > REEL_CAPTION_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Caption must be ${REEL_CAPTION_MAX_LENGTH} characters or fewer.` };
  }
  if (!isValidCategoryId(input.categoryId)) {
    return { ok: false, error: 'invalid-input', message: 'Choose a valid category.' };
  }
  if (!input.storageContentType.startsWith('video/')) {
    return { ok: false, error: 'invalid-input', message: 'Only video files can be shared as a Reel.' };
  }
  if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0 || input.fileSizeBytes > REEL_MAX_FILE_SIZE_BYTES) {
    return { ok: false, error: 'invalid-input', message: 'Video must be under 50 MB.' };
  }
  if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > REEL_MAX_DURATION_MS) {
    return { ok: false, error: 'invalid-input', message: 'Video must be 60 seconds or shorter.' };
  }
  if (!Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) {
    return { ok: false, error: 'invalid-input', message: "Couldn't read this video's dimensions." };
  }

  const draftRef = doc(collection(firestore, REELS_COLLECTION));
  const data = {
    reelId: draftRef.id,
    authorUid: profile.uid,
    authorDisplayName: profile.displayName,
    authorUsername: profile.username,
    cityName: profile.cityName,
    countryCode: profile.countryCode,
    cityKey: profile.cityKey,
    categoryId: input.categoryId,
    caption,
    storagePath: reelStoragePath(profile.uid, draftRef.id),
    storageContentType: input.storageContentType,
    fileSizeBytes: input.fileSizeBytes,
    durationMs: input.durationMs,
    width: input.width,
    height: input.height,
    status: 'uploading',
    visibility: 'city',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    publishedAt: null,
  } satisfies WithFieldValue<Reel>;

  try {
    await setDoc(draftRef, data);
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't start this Reel upload." };
  }

  const created = await fetchReel(draftRef.id);
  if (!created) {
    return { ok: false, error: 'unknown', message: 'Reel draft was created but could not be read back.' };
  }
  return { ok: true, reel: created };
}

// ---------------------------------------------------------------------------
// Phase 2 — upload the video to Cloud Storage
// ---------------------------------------------------------------------------

export type UploadReelVideoHandle = {
  /** Aborts the in-flight upload. Safe to call even if the upload hasn't started transferring yet. */
  cancel: () => void;
};

/**
 * Starts a resumable upload of `localUri` to the Reel's reserved Storage
 * path. Call `.cancel()` on the returned handle to abort — the caller is
 * responsible for then calling discardReelDraft to clean up the Firestore
 * draft and any partial Storage object (see discardReelDraft below).
 *
 * The Firebase JS SDK's Storage upload functions take a real Blob/
 * ArrayBuffer/Uint8Array, not a `{ uri }` reference (that shape only
 * exists for the separate React Native Firebase native-module SDK, which
 * this project does not use) — so the local file URI from the picker is
 * first read into a Blob via `fetch()`, which works uniformly across iOS,
 * Android, and web with the Firebase JS SDK.
 */
export function uploadReelVideo(
  reel: Reel,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadReelVideoHandle {
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
      onComplete({ ok: false, message: "Couldn't read this video file." });
      return;
    }
    if (cancelled) return;

    const objectRef = ref(storage, reel.storagePath);
    task = uploadBytesResumable(objectRef, blob, { contentType: reel.storageContentType });

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
        onComplete({ ok: false, message: "Couldn't upload this video." });
      },
      () => {
        onComplete({ ok: true });
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

// ---------------------------------------------------------------------------
// Phase 3 — publish (the only allowed update on a Reel)
// ---------------------------------------------------------------------------

export type PublishReelResult = { ok: true; reel: Reel } | { ok: false; error: ReelDraftError; message: string };

export async function publishReel(reelId: string): Promise<PublishReelResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }
  try {
    await updateDoc(reelRef(reelId), {
      status: 'published',
      publishedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't publish this Reel." };
  }
  const published = await fetchReel(reelId);
  if (!published) {
    return { ok: false, error: 'unknown', message: 'Reel was published but could not be read back.' };
  }
  return { ok: true, reel: published };
}

// ---------------------------------------------------------------------------
// Discard — failed/cancelled upload cleanup. Only valid while the Reel is
// still "uploading" — storage.rules independently cross-checks this same
// condition against Firestore before allowing the delete below, so a
// published Reel's media can never be discarded this way even if this
// function were called on one. If the delete still fails for some other
// reason (e.g. the object never finished uploading in the first place),
// that's logged rather than silently swallowed, so orphaned objects stay
// visible for cleanup via trusted CLI tooling (see
// scripts/delete-test-documents.cjs's pattern) rather than hidden.
// ---------------------------------------------------------------------------

export async function discardReelDraft(reelId: string, storagePath: string): Promise<void> {
  if (storage) {
    try {
      await deleteObject(ref(storage, storagePath));
    } catch (error) {
      if (__DEV__) {
        console.warn(
          `[reels] Could not delete Storage object at "${storagePath}" while discarding Reel "${reelId}" — ` +
            'it may be left orphaned and require cleanup via trusted CLI tooling. Error:',
          error
        );
      }
    }
  }
  if (firestore) {
    try {
      await deleteDoc(reelRef(reelId));
    } catch (error) {
      if (__DEV__) {
        console.warn(`[reels] Could not delete Reel draft "${reelId}" while discarding it. Error:`, error);
      }
      // Best-effort: if this also fails, an orphaned "uploading" draft is
      // left behind rather than a corrupted app state. It is never shown
      // in the published feed (see fetchCityReels), and remains
      // discardable later by the same author.
    }
  }
}

// ---------------------------------------------------------------------------
// Read — one-shot reads only, no realtime listener (see Step 18 spec).
// ---------------------------------------------------------------------------

/** Newest published Reels for one city. Never fetches all Reels then filters client-side. */
export async function fetchCityReels(cityKey: string, limitCount = DEFAULT_FEED_LIMIT): Promise<Reel[]> {
  if (!firestore) return [];
  const feedQuery = query(
    collection(firestore, REELS_COLLECTION),
    where('cityKey', '==', cityKey),
    where('status', '==', 'published'),
    orderBy('publishedAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(feedQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Reel);
}

/**
 * Newest published Reels by one author, for the public profile Reels tab.
 * Never fetches the whole reels collection then filters client-side — same
 * pattern as fetchPublicUserContent in src/services/content.ts.
 */
export async function fetchProfileReels(uid: string, limitCount = DEFAULT_PROFILE_REEL_LIMIT): Promise<Reel[]> {
  if (!firestore) return [];
  const profileReelsQuery = query(
    collection(firestore, REELS_COLLECTION),
    where('authorUid', '==', uid),
    where('status', '==', 'published'),
    orderBy('publishedAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(profileReelsQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Reel);
}

// ---------------------------------------------------------------------------
// Playback URL resolution — storagePath is what's persisted; a playable
// URL is resolved from it at runtime and cached in-memory for this
// session only (never written back to Firestore).
// ---------------------------------------------------------------------------

const playbackUrlCache = new Map<string, string>();

export async function resolveReelPlaybackUrl(storagePath: string): Promise<string | null> {
  const cached = playbackUrlCache.get(storagePath);
  if (cached) return cached;
  if (!storage) return null;
  try {
    const url = await getDownloadURL(ref(storage, storagePath));
    playbackUrlCache.set(storagePath, url);
    return url;
  } catch {
    return null;
  }
}
