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
  getCountFromServer,
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
import { httpsCallable } from 'firebase/functions';

import { INTERESTS } from '@/constants/interests';
import {
  REEL_CAPTION_MAX_LENGTH,
  REEL_MAX_DURATION_MS,
  REEL_MAX_FILE_SIZE_BYTES,
  type Reel,
} from '@/types/reel';

import { fetchFollowingUids } from './following';
import { firestore } from './firestore';
import { functions } from './functions';
import { storage } from './storage';
import { fetchUserProfile } from './userProfile';

const REELS_COLLECTION = 'reels';
const DEFAULT_FEED_LIMIT = 20;
const DEFAULT_PROFILE_REEL_LIMIT = 30;
const VALID_CATEGORY_IDS = new Set(INTERESTS.map((interest) => interest.id));

// Same MVP caps as fetchFollowingFeed in src/services/content.ts — a page
// covers everyone in the caller's Following list before pagination is
// needed, chunked well under the JS SDK's 30-value `in` limit.
const MAX_FOLLOWED_UIDS_PER_FEED_PAGE = 30;
const FOLLOWING_UID_CHUNK_SIZE = 10;
const DEFAULT_FOLLOWING_FEED_LIMIT = 20;

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
    return { ok: false, error: 'no-profile', message: 'Complete your profile before creating a post.' };
  }

  const caption = input.caption.trim();
  if (caption.length > REEL_CAPTION_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Caption must be ${REEL_CAPTION_MAX_LENGTH} characters or fewer.` };
  }
  if (!isValidCategoryId(input.categoryId)) {
    return { ok: false, error: 'invalid-input', message: 'Choose a valid category.' };
  }
  if (!input.storageContentType.startsWith('video/')) {
    return { ok: false, error: 'invalid-input', message: 'Only video files can be shared as a post.' };
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
    return { ok: false, error: 'unknown', message: "Couldn't start this post upload." };
  }

  const created = await fetchReel(draftRef.id);
  if (!created) {
    return { ok: false, error: 'unknown', message: 'Post draft was created but could not be read back.' };
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
    return { ok: false, error: 'unknown', message: "Couldn't publish this post." };
  }
  const published = await fetchReel(reelId);
  if (!published) {
    return { ok: false, error: 'unknown', message: 'Post was published but could not be read back.' };
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

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export type FetchFollowingReelsInput = {
  currentUid: string;
  /** The city to scope the feed to — Active City, passed explicitly (same pattern as fetchFollowingFeed in content.ts). */
  cityKey: string;
  limit?: number;
};

export type FollowingReelsResult = {
  reels: Reel[];
  /**
   * Whether the caller follows anyone at all — lets the UI distinguish
   * "you don't follow anyone yet" from "you follow people, but none of
   * them have Reels in this city" without a second, duplicate
   * fetchFollowingUids call (this function already makes exactly one).
   */
  followsAnyone: boolean;
};

/**
 * Published Reels, in one city, from people `currentUid` follows —
 * chronological (newest publishedAt first). Mirrors fetchFollowingFeed in
 * src/services/content.ts exactly: resolves followed uids first, then
 * queries Reels directly by those uids in chunks of
 * FOLLOWING_UID_CHUNK_SIZE (10, well under the JS SDK's 30-value `in`
 * cap), each chunk further scoped by cityKey + status so this never
 * fetches a followed author's Reels from OTHER cities only to discard them
 * client-side. Results are merged, deduplicated by reelId, globally
 * re-sorted by publishedAt, and capped to the requested limit. Uses the
 * dedicated (cityKey, status, authorUid, publishedAt DESC) composite index
 * — the only new index this step adds.
 */
export async function fetchFollowingReels({
  currentUid,
  cityKey,
  limit: limitCount = DEFAULT_FOLLOWING_FEED_LIMIT,
}: FetchFollowingReelsInput): Promise<FollowingReelsResult> {
  if (!firestore) return { reels: [], followsAnyone: false };
  const db = firestore;

  const followedUids = await fetchFollowingUids(currentUid, MAX_FOLLOWED_UIDS_PER_FEED_PAGE);
  if (followedUids.length === 0) {
    return { reels: [], followsAnyone: false };
  }

  const chunks = chunkArray(followedUids, FOLLOWING_UID_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      getDocs(
        query(
          collection(db, REELS_COLLECTION),
          where('authorUid', 'in', chunk),
          where('cityKey', '==', cityKey),
          where('status', '==', 'published'),
          orderBy('publishedAt', 'desc'),
          limit(limitCount)
        )
      )
    )
  );

  const seenReelIds = new Set<string>();
  const merged: Reel[] = [];
  for (const snapshot of chunkResults) {
    for (const docSnapshot of snapshot.docs) {
      const reel = docSnapshot.data() as Reel;
      if (seenReelIds.has(reel.reelId)) continue;
      seenReelIds.add(reel.reelId);
      merged.push(reel);
    }
  }

  merged.sort((a, b) => (b.publishedAt?.toMillis() ?? 0) - (a.publishedAt?.toMillis() ?? 0));
  return { reels: merged.slice(0, limitCount), followsAnyone: true };
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

/**
 * The exact number of a user's own published video Posts (technically
 * Reels) — half of the unified Profile "Posts" stat (Step 41.2C; the other
 * half is fetchProfilePostCount's legacy-text-Post count in content.ts).
 * A server-side aggregation, not derived from fetchProfileReels' bounded
 * list — same reasoning as fetchProfilePostCount: a prolific author with
 * more Reels than that list's limit would otherwise be undercounted. Reuses
 * the existing (authorUid, status, publishedAt DESC) composite index —
 * Firestore composite indexes can serve any query using a leading prefix
 * of their fields, and authorUid+status is exactly that prefix, so no new
 * index is needed for this equality-only count.
 */
export async function fetchProfileReelCount(uid: string): Promise<number> {
  if (!firestore) return 0;
  const countQuery = query(collection(firestore, REELS_COLLECTION), where('authorUid', '==', uid), where('status', '==', 'published'));
  const snapshot = await getCountFromServer(countQuery);
  return snapshot.data().count;
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

// ---------------------------------------------------------------------------
// Author self-delete (Step 40.1) — a trusted backend callable, not a client
// Storage/Firestore delete: deleting a published Reel needs the exact
// Storage object removed too, which a client has no permission to do
// directly (see storage.rules — only a still-"uploading" draft is
// client-deletable, via discardReelDraft above, an entirely separate path
// this doesn't touch).
// ---------------------------------------------------------------------------

export type DeleteMyReelResult = { ok: true } | { ok: false; message: string };

/** Deletes exactly the one Reel the caller authored — root, likes, comments, target notifications, and the exact Storage source object. Permanent. */
export async function deleteMyReel(reelId: string): Promise<DeleteMyReelResult> {
  if (!functions) {
    return { ok: false, message: 'This feature is not available right now.' };
  }
  try {
    await httpsCallable(functions, 'deleteMyReel')({ reelId });
  } catch {
    return { ok: false, message: "Couldn't delete this post." };
  }
  return { ok: true };
}
