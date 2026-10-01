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
  startAfter,
  updateDoc,
  where,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  type WithFieldValue,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';

import { INTERESTS } from '@/constants/interests';
import type { BrowseScope } from '@/types/browseScope';
import { EMPTY_ENGAGEMENT_STATS } from '@/types/engagementStats';
import {
  REEL_CAPTION_MAX_LENGTH,
  REEL_MAX_DURATION_MS,
  REEL_MAX_FILE_SIZE_BYTES,
  REEL_MUSIC_MAX_DURATION_MS,
  REEL_MUSIC_MAX_FILE_SIZE_BYTES,
  REEL_PHOTO_DURATION_MS,
  REEL_PHOTO_MAX_FILE_SIZE_BYTES,
  REEL_THUMBNAIL_MAX_FILE_SIZE_BYTES,
  type Reel,
  type ReelMediaType,
  type ReelStorageProvider,
  type ReelThumbnailStorageProvider,
} from '@/types/reel';

import { fetchFollowingUids } from './following';
import { firestore } from './firestore';
import { functions } from './functions';
import { extractHashtags, incrementHashtagCounts } from './hashtags';
import { getMediaStorageProvider } from './media';
import { pickProviderUrl } from './media/providerAwareUrl';
import { isReelEligibleForR2VideoUpload } from './media/reelVideoEligibility';
import { uploadReelMusicToR2, uploadReelThumbnailToR2, uploadReelVideoToR2 } from './media/r2Provider';
import { fetchEngagementStatsBatch } from './recommendations/engagementStats';
import { scoreContentQuality } from './recommendations/ranking';
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

/** reels/{authorUid}/{reelId}/music — deterministic, mirrors reelStoragePath exactly (see ReelMusicSourceType's doc comment in src/types/reel.ts). */
export function reelMusicStoragePath(authorUid: string, reelId: string): string {
  return `reels/${authorUid}/${reelId}/music`;
}

/** reels/{authorUid}/{reelId}/thumbnail — deterministic, mirrors reelStoragePath exactly (see Reel.thumbnailStoragePath's doc comment in src/types/reel.ts). */
export function reelThumbnailStoragePath(authorUid: string, reelId: string): string {
  return `reels/${authorUid}/${reelId}/thumbnail`;
}

function isValidCategoryId(categoryId: string): boolean {
  return VALID_CATEGORY_IDS.has(categoryId);
}

/**
 * Normalizes a missing `mediaType` (every Reel published before this field
 * existed) to 'video' — the only kind of Reel there was until "FOTO" mode
 * — so every read site returns a real `ReelMediaType`, never a missing key
 * call sites have to special-case. Same convention as `bio ?? ''` on
 * UserProfile.
 */
export function normalizeReel(data: Reel): Reel {
  return {
    ...data,
    mediaType: data.mediaType ?? 'video',
    needsPhotoVideoRender: data.needsPhotoVideoRender ?? false,
    // A Reel published before hashtags existed simply has no such key at
    // all — see Reel.hashtags' own doc comment.
    hashtags: data.hashtags ?? [],
    musicHash: data.musicHash ?? '',
    soundOriginAuthorUid: data.soundOriginAuthorUid ?? '',
    soundOriginReelId: data.soundOriginReelId ?? '',
    // Step 5E — a Reel published before this field existed has its
    // thumbnail on Firebase, same defaulting convention as musicHash
    // above. See ReelThumbnailStorageProvider's own doc comment.
    thumbnailStorageProvider: data.thumbnailStorageProvider ?? 'firebase',
    thumbnailUrl: data.thumbnailUrl ?? '',
    // Step 9A — same defaulting convention, for the Reel's own video
    // source this time. See ReelStorageProvider's own doc comment.
    storageProvider: data.storageProvider ?? 'firebase',
    sourceUrl: data.sourceUrl ?? '',
  };
}

// ---------------------------------------------------------------------------
// Swipe-to-next-post handoff — mirrors setEventFeedHandoff/
// peekEventFeedHandoff (src/services/content.ts) for Events, applied to
// Reels: a screen that already has a real, ordered list of Reels in
// memory (e.g. the hashtag page's own Top/Recent results) calls
// setReelFeedHandoff right before navigating into one of them, so
// src/app/(app)/reel/[reelId].tsx can swipe through that EXACT list
// instead of falling back to its own author/sound-based lookup. Same
// short TTL and "read once" semantics as the Event version — see
// content.ts's own doc comment for the full reasoning (avoids
// serializing Timestamp-bearing Reel objects through a URL param, and
// avoids a duplicate Firestore read for a list the caller already has in
// memory).
// ---------------------------------------------------------------------------
const REEL_FEED_HANDOFF_TTL_MS = 20_000;
let reelFeedHandoff: { reels: Reel[]; fetchedAt: number } | null = null;

/** Call right before navigating into one of `reels`' own items — see this handoff's own doc comment above. */
export function setReelFeedHandoff(reels: Reel[]): void {
  reelFeedHandoff = { reels, fetchedAt: Date.now() };
}

/** `undefined` on a miss or a stale entry — see this handoff's own doc comment above for what the caller should do then (fall back to the author/sound Reel list). */
export function peekReelFeedHandoff(): Reel[] | undefined {
  if (!reelFeedHandoff || Date.now() - reelFeedHandoff.fetchedAt >= REEL_FEED_HANDOFF_TTL_MS) return undefined;
  return reelFeedHandoff.reels;
}

// ---------------------------------------------------------------------------
// Feed invalidation signal — a plain, session-local (never persisted)
// version counter, bumped exactly once whenever THIS device's own
// publishReel call below actually succeeds. This exists for Home's own
// stale-while-revalidate memoization (src/app/(app)/(tabs)/index.tsx),
// which otherwise only reloads the active feed when its own load key
// (account + Active Scope + Home City) changes — a mere tab refocus is
// deliberately a no-op there, to avoid a real Firestore read on every
// ordinary tab switch. Publishing a Reel changes none of those three
// things, so without this signal, returning to Home right after
// publishing looked identical to "nothing happened" and the newly
// published Reel simply wasn't there until an unrelated scope change
// forced a real reload anyway.
//
// Deliberately a plain read at the CALL SITE's own focus-time, not
// something folded into a React state value or into feedLoadKey itself:
// Home stays mounted (just unfocused) while the create-Reel flow runs on
// top of it, so nothing here needs to re-render Home while it's not even
// visible — the version only needs to be read fresh at the moment Home
// actually regains focus, which is exactly when a focus-effect callback
// body (not a render) runs. See getReelFeedDirtyVersion's own callers in
// index.tsx.
//
// Deliberately NOT scoped to a specific reelId/city/scope — a freshly
// published Reel could legitimately become visible in more than just its
// own home scope (e.g. it's also eligible under Global), so this simply
// says "something new might exist, worth one fresh check," regardless of
// which scope/mode the viewer happens to be looking at when they return.
// ---------------------------------------------------------------------------
let reelFeedDirtyVersion = 0;

/** Current value of the feed-invalidation counter — see its own doc comment above. Callers should capture this at the time they last (re)loaded a feed and compare against a fresh read of this function at focus time, never store it in React state (that would just reintroduce the "does this force a render" problem this exists to avoid). */
export function getReelFeedDirtyVersion(): number {
  return reelFeedDirtyVersion;
}

export async function fetchReel(reelId: string): Promise<Reel | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(reelRef(reelId));
  return snapshot.exists() ? normalizeReel(snapshot.data() as Reel) : null;
}

// ---------------------------------------------------------------------------
// Phase 1 — create the Firestore draft
// ---------------------------------------------------------------------------

export type CreateReelDraftInput = {
  uid: string;
  categoryId: string;
  caption: string;
  /** 'video' (the original, still overwhelmingly common case, and also a "FOTO"-mode photo taken WITH music — see `photoRenderPending` below) or 'photo' ("FOTO" mode WITHOUT music — see ReelMediaType's own doc comment in src/types/reel.ts). */
  mediaType: ReelMediaType;
  /**
   * True ONLY for a "FOTO"-mode photo taken WITH music: `mediaType` is
   * 'video' (this draft WILL publish as a real video), but
   * `storageContentType`/`fileSizeBytes`/`width`/`height` below still
   * describe the PHOTO itself — createReelDraft validates them as an
   * image (same bounds as mediaType 'photo'), stores `durationMs` as the
   * fixed REEL_PHOTO_DURATION_MS, and sets `needsPhotoVideoRender: true`
   * on the created Reel. The caller must then upload that photo to
   * `reel.storagePath` (via uploadReelVideo — it just uploads bytes,
   * despite its name), a real chosen `thumbnail` (required, same as any
   * other video — see below), and music, then call renderPhotoToVideo
   * BEFORE publishReel. Omit/false for every other case, including a
   * plain photo with no music (`mediaType: 'photo'`) and an ordinary
   * video.
   */
  photoRenderPending?: boolean;
  storageContentType: string;
  fileSizeBytes: number;
  /**
   * Declared duration in milliseconds from the picked asset's own metadata
   * — see src/types/reel.ts's Reel.durationMs doc comment for why this is
   * a client-declared value, not a verified one. Ignored (always stored as
   * 0) when mediaType is 'photo', or as REEL_PHOTO_DURATION_MS when
   * `photoRenderPending` is true.
   */
  durationMs: number;
  width: number;
  height: number;
  /**
   * The device-audio file picked alongside the camera recording (see
   * camera.tsx's "Music" control) — `undefined`/omitted for the ordinary
   * case (no music, a library-picked video, or a plain photo with no
   * music). REQUIRED in practice whenever `photoRenderPending` is true —
   * that's the only reason a "FOTO"-mode capture ever reaches this input
   * at all (no music means the plain `mediaType: 'photo'` path instead,
   * which never sets `photoRenderPending`). See ReelMusicSourceType's doc
   * comment in src/types/reel.ts for the full model this maps onto.
   */
  music?: {
    title: string;
    storageContentType: string;
    fileSizeBytes: number;
    durationMs: number;
  };
  /**
   * The real cover image for this Reel — REQUIRED whenever this draft will
   * actually publish as a video, i.e. whenever `mediaType` is 'video',
   * which includes `photoRenderPending: true` (see camera.tsx's cover-
   * frame picker for an ordinary video, and its resized-photo-as-thumbnail
   * step for the photoRenderPending case) and Reel.thumbnailStoragePath's
   * own doc comment in src/types/reel.ts. Ignored when `mediaType` is
   * 'photo': that photo already IS its own cover image, automatically
   * derived from storageContentType/fileSizeBytes/width/height above
   * instead — see Reel.thumbnailStoragePath's own doc comment for why
   * there's no separate object to upload for it in that case.
   */
  thumbnail?: {
    storageContentType: string;
    fileSizeBytes: number;
    width: number;
    height: number;
  };
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

  const isPhoto = input.mediaType === 'photo';
  // "FOTO" mode with music — a real video from the moment this draft
  // exists (mediaType is already 'video'), but the bytes about to be
  // uploaded to storagePath are still the photo itself until
  // renderPhotoToVideo runs — see CreateReelDraftInput.photoRenderPending's
  // own doc comment.
  const isPhotoPendingRender = !isPhoto && input.photoRenderPending === true;
  // Everywhere below that needs "this upload is actually an image, not a
  // real video" (content-type/size bounds, dimension requirement) cares
  // about isPhoto OR isPhotoPendingRender equally — only durationMs and
  // the thumbnail requirement (further down) tell the two apart.
  const isImageUpload = isPhoto || isPhotoPendingRender;

  const caption = input.caption.trim();
  if (caption.length > REEL_CAPTION_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Caption must be ${REEL_CAPTION_MAX_LENGTH} characters or fewer.` };
  }
  // Computed once, here, from the exact caption this draft is about to
  // store — never re-derived later (captions are immutable — see
  // Reel.hashtags' own doc comment). `caption` itself is stored unchanged
  // right below; this is a separate, derived field.
  const hashtags = extractHashtags(caption);
  if (!isValidCategoryId(input.categoryId)) {
    return { ok: false, error: 'invalid-input', message: 'Choose a valid category.' };
  }

  if (isImageUpload) {
    if (!input.storageContentType.startsWith('image/')) {
      return { ok: false, error: 'invalid-input', message: 'Only image files can be shared as a photo post.' };
    }
    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0 || input.fileSizeBytes > REEL_PHOTO_MAX_FILE_SIZE_BYTES) {
      return { ok: false, error: 'invalid-input', message: 'Photo must be under 10 MB.' };
    }
  } else {
    if (!input.storageContentType.startsWith('video/')) {
      return { ok: false, error: 'invalid-input', message: 'Only video files can be shared as a post.' };
    }
    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0 || input.fileSizeBytes > REEL_MAX_FILE_SIZE_BYTES) {
      return { ok: false, error: 'invalid-input', message: 'Video must be under 50 MB.' };
    }
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > REEL_MAX_DURATION_MS) {
      return { ok: false, error: 'invalid-input', message: 'Video must be 60 seconds or shorter.' };
    }
  }
  if (!Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) {
    return { ok: false, error: 'invalid-input', message: isImageUpload ? "Couldn't read this photo's dimensions." : "Couldn't read this video's dimensions." };
  }
  if (input.music) {
    if (!input.music.storageContentType.startsWith('audio/')) {
      return { ok: false, error: 'invalid-input', message: 'Music must be an audio file.' };
    }
    if (!Number.isFinite(input.music.fileSizeBytes) || input.music.fileSizeBytes <= 0 || input.music.fileSizeBytes > REEL_MUSIC_MAX_FILE_SIZE_BYTES) {
      return { ok: false, error: 'invalid-input', message: 'Music file must be under 20 MB.' };
    }
    if (!Number.isFinite(input.music.durationMs) || input.music.durationMs <= 0 || input.music.durationMs > REEL_MUSIC_MAX_DURATION_MS) {
      return { ok: false, error: 'invalid-input', message: 'Music file must be 10 minutes or shorter.' };
    }
  }
  // Every 'video'-mediaType draft needs a real chosen cover image —
  // including isPhotoPendingRender, which publishes as a real video too.
  // Only a plain 'photo' (no music) skips this, since it's its own cover.
  if (!isPhoto) {
    if (!input.thumbnail) {
      return { ok: false, error: 'invalid-input', message: "Couldn't prepare this post's cover image — try again." };
    }
    if (!input.thumbnail.storageContentType.startsWith('image/')) {
      return { ok: false, error: 'invalid-input', message: 'Cover image must be a real image file.' };
    }
    if (
      !Number.isFinite(input.thumbnail.fileSizeBytes) ||
      input.thumbnail.fileSizeBytes <= 0 ||
      input.thumbnail.fileSizeBytes > REEL_THUMBNAIL_MAX_FILE_SIZE_BYTES
    ) {
      return { ok: false, error: 'invalid-input', message: 'Cover image must be under 5 MB.' };
    }
    if (!Number.isFinite(input.thumbnail.width) || input.thumbnail.width <= 0 || !Number.isFinite(input.thumbnail.height) || input.thumbnail.height <= 0) {
      return { ok: false, error: 'invalid-input', message: "Couldn't read the cover image's dimensions." };
    }
  }

  const draftRef = doc(collection(firestore, REELS_COLLECTION));
  // A plain photo (no music) IS its own cover — see
  // Reel.thumbnailStoragePath's own doc comment — so thumbnailStoragePath
  // just points at the exact same object as storagePath instead of a
  // separate uploaded one. isPhotoPendingRender does NOT qualify for this
  // shortcut even though its upload is also an image right now: storagePath
  // is about to be OVERWRITTEN by renderPhotoToVideo with the rendered
  // video, so its thumbnail must be a real, separately-uploaded, permanent
  // copy — same as any other video Reel.
  const thumbnail = isPhoto
    ? { storagePath: reelStoragePath(profile.uid, draftRef.id), storageContentType: input.storageContentType, fileSizeBytes: input.fileSizeBytes, width: input.width, height: input.height }
    : {
        storagePath: reelThumbnailStoragePath(profile.uid, draftRef.id),
        storageContentType: input.thumbnail!.storageContentType,
        fileSizeBytes: input.thumbnail!.fileSizeBytes,
        width: input.thumbnail!.width,
        height: input.thumbnail!.height,
      };
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
    hashtags,
    mediaType: input.mediaType,
    needsPhotoVideoRender: isPhotoPendingRender,
    storagePath: reelStoragePath(profile.uid, draftRef.id),
    storageContentType: input.storageContentType,
    fileSizeBytes: input.fileSizeBytes,
    // Step 9A — every draft is created with its video source still on
    // Firebase, same "required field, fixed default at create" pattern as
    // thumbnailStorageProvider below. Only a trusted, one-time
    // server-authorized update (see confirmReelVideoProvider below) can
    // ever flip this to 'r2' — enforced server-side by firestore.rules'
    // isValidReelSourceProviderUpdate, not just by this client code.
    storageProvider: 'firebase',
    sourceUrl: '',
    durationMs: isPhoto ? 0 : isPhotoPendingRender ? REEL_PHOTO_DURATION_MS : input.durationMs,
    width: input.width,
    height: input.height,
    status: 'uploading',
    visibility: 'city',
    // See ReelMusicSourceType's doc comment (src/types/reel.ts) — always
    // present, 'none'/empty/0 sentinels when no music was picked, exactly
    // like every other Reel field (never conditionally omitted).
    musicSourceType: input.music ? 'device' : 'none',
    musicTitle: input.music?.title ?? '',
    musicStorageAudioPath: input.music ? reelMusicStoragePath(profile.uid, draftRef.id) : '',
    // Step 10B — same "required field, fixed default at create" pattern
    // as storageProvider/thumbnailStorageProvider above — only a
    // trusted, one-time server-authorized update (see
    // confirmReelMusicProvider below) can ever flip this to 'r2'.
    musicStorageProvider: 'firebase',
    musicStorageContentType: input.music?.storageContentType ?? '',
    musicFileSizeBytes: input.music?.fileSizeBytes ?? 0,
    musicDurationMs: input.music?.durationMs ?? 0,
    // Always empty at creation — only a trusted Cloud Function
    // (muxReelMusic/renderPhotoToVideo, via the Admin SDK) ever stamps a
    // real value, later, once the picked music file's actual bytes have
    // been hashed. See Reel.musicHash's own doc comment in
    // src/types/reel.ts.
    musicHash: '',
    soundOriginAuthorUid: '',
    soundOriginReelId: '',
    thumbnailStoragePath: thumbnail.storagePath,
    thumbnailStorageContentType: thumbnail.storageContentType,
    thumbnailFileSizeBytes: thumbnail.fileSizeBytes,
    thumbnailWidth: thumbnail.width,
    thumbnailHeight: thumbnail.height,
    // Step 5E — every draft is created with its thumbnail still on
    // Firebase, same "required field, fixed default at create" pattern as
    // musicHash etc. above. Only a trusted, one-time server-authorized
    // update (see confirmReelThumbnailProvider below) can ever flip this
    // to 'r2' — enforced server-side by firestore.rules'
    // isValidReelThumbnailProviderUpdate, not just by this client code.
    thumbnailStorageProvider: 'firebase',
    thumbnailUrl: '',
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
 *
 * Step 9A/9B — dispatches to uploadReelVideoViaR2 (below) ONLY when
 * getMediaStorageProvider() is 'r2' AND isReelEligibleForR2VideoUpload(reel)
 * (see that function's own doc comment in reelVideoEligibility.ts): a
 * video Reel with no pending photo-to-video render, and with either no
 * music (Step 9A) or device-picked music (Step 9B — muxReelMusic is now
 * provider-aware, see reelMuxOrchestration.ts). Despite its name this
 * function is also the plain-photo upload path (`mediaType === 'photo'`,
 * no separate thumbnail step — see createReelDraft's own doc comment) —
 * a photo Reel and a "FOTO"-with-music render-pending Reel still take
 * this exact same, unmodified Firebase path below, regardless of the
 * configured provider — see checkReelVideoEligibility's own doc comment
 * in functions/src/media/reelEligibility.ts for exactly why those two
 * variants stay excluded from R2. This function's own default,
 * production behavior is otherwise completely untouched — the exact same
 * code that existed before Step 9A.
 */
export function uploadReelVideo(
  reel: Reel,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadReelVideoHandle {
  if (getMediaStorageProvider() === 'r2' && isReelEligibleForR2VideoUpload(reel)) {
    return uploadReelVideoViaR2(reel, localUri, onProgress, onComplete);
  }

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

/**
 * Step 9A — the one-time, server-authorized Firestore write that flips a
 * still-"uploading" plain video Reel's source from Firebase to R2, once
 * (and only once) the direct client PUT to R2 has actually succeeded —
 * see firestore.rules' own isValidReelSourceProviderUpdate for the exact
 * narrow shape this write must take (every field besides
 * storageProvider/sourceUrl/updatedAt must stay byte-identical, and this
 * can never fire a second time against the same Reel). The ONLY caller
 * is uploadReelVideoViaR2 below — this is not a general-purpose
 * Reel-editing function. Exact structural mirror of
 * confirmReelThumbnailProvider above, for the video source instead of
 * the thumbnail — the two are deliberately independent writes (a Reel's
 * video and thumbnail providers never change together in one call), same
 * "do not couple them" reasoning as ReelStorageProvider's own doc
 * comment in src/types/reel.ts.
 */
async function confirmReelVideoProvider(reelId: string, sourceUrl: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) {
    return { ok: false, message: 'Firestore is not available.' };
  }
  try {
    await updateDoc(reelRef(reelId), {
      storageProvider: 'r2',
      sourceUrl,
      updatedAt: serverTimestamp(),
    });
  } catch {
    return { ok: false, message: "Couldn't finish saving this post's video." };
  }
  return { ok: true };
}

/**
 * Step 9C — the lockstep counterpart of confirmReelVideoProvider/
 * confirmReelThumbnailProvider above, ONLY for a plain PHOTO Reel
 * (`mediaType === 'photo'`). A photo Reel has no separate thumbnail
 * object at all — `thumbnailStoragePath === storagePath` from
 * createReelDraft onward (see that function's own doc comment) — but
 * `storageProvider`/`sourceUrl` and `thumbnailStorageProvider`/
 * `thumbnailUrl` are still tracked as two INDEPENDENT field pairs (kept
 * decoupled on purpose for video Reels, whose source and thumbnail
 * really are two different objects — see ReelStorageProvider's own doc
 * comment in src/types/reel.ts). Left as two independent writes for a
 * photo Reel, a plain R2 upload would confirm `storageProvider: 'r2'`
 * while `thumbnailStorageProvider` stayed stuck at its default
 * `'firebase'` forever — ReelPreviewCard.tsx's own thumbnail resolver
 * would then try to fetch a Firebase Storage object that was never
 * written, since the real bytes went straight to R2 (see this file's own
 * resolveReelThumbnailUrl above). This function fixes that by writing
 * BOTH pairs together, to the SAME url, in ONE atomic update — see
 * firestore.rules' own new isValidReelPhotoSourceProviderUpdate, which
 * is the only Rule that permits this exact dual-field transition (and
 * only for `mediaType == 'photo'` on both sides of the write).
 */
async function confirmReelPhotoSourceProvider(reelId: string, url: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) {
    return { ok: false, message: 'Firestore is not available.' };
  }
  try {
    await updateDoc(reelRef(reelId), {
      storageProvider: 'r2',
      sourceUrl: url,
      thumbnailStorageProvider: 'r2',
      thumbnailUrl: url,
      updatedAt: serverTimestamp(),
    });
  } catch {
    return { ok: false, message: "Couldn't finish saving this post's photo." };
  }
  return { ok: true };
}

/**
 * Step 9A's real, end-to-end R2 upload path for a plain video Reel's own
 * source — reached ONLY from uploadReelVideo above, when the provider is
 * 'r2' and this exact Reel is eligible (see that function's own doc
 * comment). Mirrors uploadReelThumbnailViaR2's own "upload, then confirm,
 * both must succeed" structure — uploadReelVideo's existing
 * `{ok:true}|{ok:false}` contract exposes no URL to its own caller
 * either, so this function performs the follow-up
 * confirmReelVideoProvider write itself before ever reporting success.
 *
 * Unlike uploadReelThumbnailViaR2, this wires up REAL cancellation: video
 * uploads can run for a meaningful amount of time (up to
 * REEL_VIDEO_MAX_SIZE_BYTES), so a user backing out mid-upload should
 * actually stop the transfer, not just have this function ignore its
 * eventual result — see uploadReelVideoToR2's own `onUploadTaskReady`
 * parameter in r2Provider.ts.
 *
 * Same orphan-risk note as uploadReelThumbnailViaR2: if the R2 PUT
 * succeeds but the follow-up Firestore write then fails, the R2 object
 * is left behind with nothing in Firestore pointing at it yet — a real
 * user retry re-PUTs to the exact same deterministic key, overwriting it
 * in place, so this never accumulates unbounded orphans. A genuinely
 * abandoned draft (the user discards instead of retrying) is cleaned up
 * server-side by discardReelDraft's own call to the discardReelSource
 * callable below.
 */
function uploadReelVideoViaR2(
  reel: Reel,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadReelVideoHandle {
  let cancelled = false;
  let cancelUpload: (() => void) | null = null;

  (async () => {
    const uploadResult = await uploadReelVideoToR2(
      reel.reelId,
      localUri,
      reel.storageContentType,
      onProgress,
      (cancel) => {
        cancelUpload = cancel;
      }
    );
    if (cancelled) return;

    if (!uploadResult.ok) {
      onComplete(uploadResult);
      return;
    }

    // Step 9C — a plain photo Reel's source and thumbnail are the SAME
    // object (see confirmReelPhotoSourceProvider's own doc comment) and
    // must be confirmed together, in one write; every other Reel
    // variant this function ever reaches (plain video, video+music) uses
    // the original, independent-fields confirm.
    const confirmResult =
      reel.mediaType === 'photo'
        ? await confirmReelPhotoSourceProvider(reel.reelId, uploadResult.sourceUrl)
        : await confirmReelVideoProvider(reel.reelId, uploadResult.sourceUrl);
    if (cancelled) return;

    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[reels] R2 video upload for', reel.reelId, '->', uploadResult, confirmResult);
    }
    onComplete(confirmResult);
  })();

  return {
    cancel: () => {
      cancelled = true;
      cancelUpload?.();
    },
  };
}

/**
 * Resolves the URL a Reel's own video should actually play from — the
 * provider-aware counterpart to resolveReelThumbnailUrl above, for the
 * main source instead of the cover image. Branches on the Reel's OWN
 * persisted `storageProvider` (never on getMediaStorageProvider() — the
 * CURRENT app config has nothing to do with where an EXISTING Reel's
 * source actually was uploaded), so a mixed feed of some Firebase-source
 * and some R2-source Reels resolves each one correctly regardless of the
 * currently-configured provider.
 *
 * 'r2': `sourceUrl` was already resolved and persisted — returned
 * directly, no network round-trip needed, and (unlike the Firebase
 * branch) never cached in playbackUrlCache below — there is nothing to
 * cache a second time for a value that's already a plain field read.
 * Step 9B — for a music Reel specifically, this is NOT necessarily the
 * same URL the original (pre-mux) upload confirmed: muxReelMusic
 * persists a FRESH, re-versioned URL once it actually replaces the
 * bytes (see reelMuxOrchestration.ts's own `buildVersionedSourceUrl`),
 * and this Reel can never publish before that happens — so by the time
 * any consumer ever calls this function for a published Reel, `sourceUrl`
 * already reflects the muxed bytes' own final URL, never the transient
 * un-muxed one.
 * 'firebase' (including every legacy Reel missing the field entirely,
 * already defaulted by normalizeReel): unchanged, existing behavior —
 * lazily resolved from `storagePath` via resolveReelPlaybackUrl, same as
 * before Step 9A.
 */
export async function resolveReelVideoPlaybackUrl(reel: Reel): Promise<string | null> {
  const resolution = pickProviderUrl(reel.storageProvider, reel.sourceUrl);
  if (resolution.mode === 'r2') return resolution.url;
  if (resolution.mode === 'r2-malformed') return null;
  return resolveReelPlaybackUrl(reel.storagePath);
}

/**
 * Same shape/pattern as uploadReelVideo, for the separate music object at
 * `reel.musicStorageAudioPath` — only ever called when
 * `reel.musicSourceType === 'device'` (an empty path otherwise; see
 * createReelDraft). This is a SEPARATE Storage object from the video, not
 * muxed into it — see ReelMusicSourceType's doc comment in
 * src/types/reel.ts for why.
 *
 * Step 10B — dispatches to uploadReelMusicAudioViaR2 (below) ONLY when
 * getMediaStorageProvider() is 'r2' — unlike Reel video/thumbnail, there
 * is no per-Reel eligibility predicate to check: this function is only
 * EVER called for a Reel already confirmed to have device-picked music
 * (see this function's own doc comment above), so the only real decision
 * is "is R2 currently enabled," no exclusion needed. This function's own
 * default, Firebase-mode behavior is otherwise completely untouched.
 */
export function uploadReelMusicAudio(
  reel: Reel,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadReelVideoHandle {
  if (getMediaStorageProvider() === 'r2') {
    return uploadReelMusicAudioViaR2(reel, localUri, onProgress, onComplete);
  }

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
      onComplete({ ok: false, message: "Couldn't read this audio file." });
      return;
    }
    if (cancelled) return;

    const objectRef = ref(storage, reel.musicStorageAudioPath);
    task = uploadBytesResumable(objectRef, blob, { contentType: reel.musicStorageContentType });

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
        onComplete({ ok: false, message: "Couldn't upload this audio file." });
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

/**
 * Step 10B — the one-time, server-authorized Firestore write that flips a
 * still-"uploading" Reel's own standalone music from Firebase to R2, once
 * (and only once) the direct client PUT to R2 has actually succeeded —
 * see firestore.rules' own isValidReelMusicProviderUpdate for the exact
 * narrow shape this write must take. Unlike confirmReelVideoProvider/
 * confirmReelThumbnailProvider, this persists NO url field at all — see
 * Reel.musicStorageProvider's own doc comment (src/types/reel.ts) for why
 * a Reel's music object has no public-URL concept to begin with. The
 * ONLY caller is uploadReelMusicAudioViaR2 below.
 */
async function confirmReelMusicProvider(reelId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) {
    return { ok: false, message: 'Firestore is not available.' };
  }
  try {
    await updateDoc(reelRef(reelId), {
      musicStorageProvider: 'r2',
      updatedAt: serverTimestamp(),
    });
  } catch {
    return { ok: false, message: "Couldn't finish saving this post's music." };
  }
  return { ok: true };
}

/**
 * Step 10B's real, end-to-end R2 upload path for a Reel's own standalone
 * music — reached ONLY from uploadReelMusicAudio above, when the provider
 * is 'r2'. Reuses the native file-based upload architecture (same as
 * uploadReelVideoToR2/uploadStoryVideoToR2), not the Blob-based path —
 * see uploadReelMusicToR2's own doc comment (r2Provider.ts) for why.
 * Mirrors uploadReelVideoViaR2's own "upload, then confirm, both must
 * succeed" structure — this function performs the follow-up
 * confirmReelMusicProvider write itself, since uploadReelMusicAudio's
 * existing `{ok:true}|{ok:false}` contract exposes nothing else to its
 * own caller.
 *
 * Same orphan-risk note as uploadReelVideoViaR2: if the R2 PUT succeeds
 * but the follow-up Firestore write then fails, the R2 object is left
 * behind with nothing in Firestore pointing at it yet — a real user
 * retry re-PUTs to the exact same deterministic key, overwriting it in
 * place. A genuinely abandoned draft is cleaned up server-side by
 * discardReelDraft's own call to the discardReelSource callable.
 */
function uploadReelMusicAudioViaR2(
  reel: Reel,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadReelVideoHandle {
  let cancelled = false;
  let cancelUpload: (() => void) | null = null;

  (async () => {
    const uploadResult = await uploadReelMusicToR2(
      reel.reelId,
      localUri,
      reel.musicStorageContentType,
      onProgress,
      (cancel) => {
        cancelUpload = cancel;
      }
    );
    if (cancelled) return;

    if (!uploadResult.ok) {
      onComplete(uploadResult);
      return;
    }

    const confirmResult = await confirmReelMusicProvider(reel.reelId);
    if (cancelled) return;

    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[reels] R2 music upload for', reel.reelId, '->', uploadResult, confirmResult);
    }
    onComplete(confirmResult);
  })();

  return {
    cancel: () => {
      cancelled = true;
      cancelUpload?.();
    },
  };
}

/**
 * Same shape/pattern as uploadReelVideo/uploadReelMusicAudio, for the
 * cover-frame image at `reel.thumbnailStoragePath` — always uploaded,
 * unlike music.
 *
 * Step 5E — dispatches to uploadReelThumbnailViaR2 (below) ONLY when
 * BOTH getMediaStorageProvider() is 'r2' AND `reel.mediaType === 'video'`
 * — a 'photo' Reel's thumbnail IS its own primary storagePath (see
 * Reel.thumbnailStoragePath's own doc comment in src/types/reel.ts), so
 * there is no separate thumbnail object to ever migrate for one; it
 * always takes this exact same, unmodified Firebase path below,
 * regardless of the configured provider. This function's own default,
 * production behavior (Firebase, or an R2 build's own photo Reels) is
 * otherwise completely untouched — the exact same code that existed
 * before Step 5E.
 */
export function uploadReelThumbnail(
  reel: Reel,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadReelVideoHandle {
  if (getMediaStorageProvider() === 'r2' && reel.mediaType === 'video') {
    return uploadReelThumbnailViaR2(reel, localUri, onProgress, onComplete);
  }

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
      onComplete({ ok: false, message: "Couldn't read the cover image." });
      return;
    }
    if (cancelled) return;

    const objectRef = ref(storage, reel.thumbnailStoragePath);
    task = uploadBytesResumable(objectRef, blob, { contentType: reel.thumbnailStorageContentType });

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
        onComplete({ ok: false, message: "Couldn't upload the cover image." });
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

/**
 * Step 5E — the one-time, server-authorized Firestore write that flips a
 * still-"uploading" video Reel's thumbnail from Firebase to R2, once (and
 * only once) the direct client PUT to R2 has actually succeeded — see
 * firestore.rules' own isValidReelThumbnailProviderUpdate for the exact
 * narrow shape this write must take (every field besides
 * thumbnailStorageProvider/thumbnailUrl/updatedAt must stay
 * byte-identical, and this can never fire a second time against the same
 * Reel). The ONLY caller is uploadReelThumbnailViaR2 below — this is not
 * a general-purpose Reel-editing function.
 *
 * `thumbnailUrl` must be the exact, already-resolved, cache-busted R2
 * delivery URL returned by uploadReelThumbnailToR2 — never fabricated or
 * reconstructed here (same "server is the one source of truth for this
 * URL" principle as every other R2-backed media kind — see
 * r2Provider.ts's own doc comments).
 */
async function confirmReelThumbnailProvider(reelId: string, thumbnailUrl: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) {
    return { ok: false, message: 'Firestore is not available.' };
  }
  try {
    await updateDoc(reelRef(reelId), {
      thumbnailStorageProvider: 'r2',
      thumbnailUrl,
      updatedAt: serverTimestamp(),
    });
  } catch {
    return { ok: false, message: "Couldn't finish saving this post's cover image." };
  }
  return { ok: true };
}

/**
 * Step 5E's real, end-to-end R2 upload path for a video Reel's
 * thumbnail — reached ONLY from uploadReelThumbnail above, when both
 * getMediaStorageProvider() is 'r2' and `reel.mediaType === 'video'`
 * (never for a 'photo' Reel — see uploadReelThumbnail's own doc
 * comment). Unlike profile photo/cover/event cover — whose own callers
 * persist the returned URL themselves — this function ALSO performs the
 * follow-up confirmReelThumbnailProvider write itself, since
 * uploadReelThumbnail's existing `{ok:true}|{ok:false}` contract exposes
 * no URL to ITS OWN caller at all (unlike edit.tsx's profile-photo flow,
 * which receives `photoURL` directly). A failure at EITHER step — the R2
 * PUT itself, or the follow-up Firestore write — surfaces as
 * `onComplete({ok:false,...})`, preserving the existing guarantee that
 * the caller (camera.tsx's publish flow) never proceeds to publish a
 * Reel whose thumbnail isn't genuinely ready.
 *
 * A note on the resulting orphan risk: if the R2 PUT succeeds but the
 * follow-up Firestore write then fails, the R2 object itself is left
 * behind with nothing in Firestore ever pointing at it — same
 * "documented, not fixed" gap as discardReelDraft's own lack of an R2
 * equivalent (see that function's own doc comment) — a real user retry
 * simply re-PUTs to the exact same deterministic key, overwriting it in
 * place, so this never accumulates unbounded orphans, just an occasional
 * harmless overwrite.
 */
function uploadReelThumbnailViaR2(
  reel: Reel,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadReelVideoHandle {
  let cancelled = false;

  (async () => {
    const uploadResult = await uploadReelThumbnailToR2(reel.reelId, localUri, onProgress);
    if (cancelled) return;

    if (!uploadResult.ok) {
      onComplete(uploadResult);
      return;
    }

    const confirmResult = await confirmReelThumbnailProvider(reel.reelId, uploadResult.photoURL);
    if (cancelled) return;

    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[reels] R2 thumbnail upload for', reel.reelId, '->', uploadResult, confirmResult);
    }
    onComplete(confirmResult);
  })();

  return {
    cancel: () => {
      cancelled = true;
    },
  };
}

/**
 * Resolves the URL a video Reel's thumbnail should actually render from
 * — the ONE call site (ReelFeedItem.tsx) that needs to know which of the
 * two provider paths a given Reel's thumbnail lives behind. Branches on
 * the Reel's OWN persisted `thumbnailStorageProvider` (never on
 * getMediaStorageProvider() — the CURRENT app config has nothing to do
 * with where an EXISTING Reel's thumbnail actually was uploaded), so a
 * mixed feed of some Firebase-thumbnail and some R2-thumbnail Reels
 * resolves each one correctly regardless of the currently-configured
 * provider — see src/types/reel.ts's ReelThumbnailStorageProvider doc
 * comment for the full model.
 *
 * 'r2': `thumbnailUrl` was already resolved once, at upload time, and
 * persisted — returned directly, no network round-trip needed.
 * 'firebase' (including every legacy Reel missing the field entirely,
 * already defaulted by normalizeReel): unchanged, existing behavior —
 * lazily resolved from `thumbnailStoragePath` via resolveReelPlaybackUrl,
 * same as before Step 5E.
 */
export async function resolveReelThumbnailUrl(reel: Reel): Promise<string | null> {
  const resolution = pickProviderUrl(reel.thumbnailStorageProvider, reel.thumbnailUrl);
  if (resolution.mode === 'r2') return resolution.url;
  if (resolution.mode === 'r2-malformed') return null;
  return resolveReelPlaybackUrl(reel.thumbnailStoragePath);
}

// ---------------------------------------------------------------------------
// Phase 2.5 — merge the uploaded music into the video itself (only when
// musicSourceType === 'device') — a trusted backend callable, not a client
// operation: overwriting the video's own Storage object in place needs
// real server-side video processing (ffmpeg), which no client SDK/library
// available to this project can do. See functions/src/index.ts's
// muxReelMusic for the full explanation — this is what actually turns
// "silent video + separate music file" into one real merged file, so it
// must run, and succeed, before publishReel.
// ---------------------------------------------------------------------------

export type MuxReelMusicResult = { ok: true } | { ok: false; message: string };

export async function muxReelMusic(reelId: string): Promise<MuxReelMusicResult> {
  if (!functions) {
    return { ok: false, message: 'This feature is not available right now.' };
  }
  try {
    await httpsCallable(functions, 'muxReelMusic')({ reelId });
  } catch {
    return { ok: false, message: "Couldn't add music to this post." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Phase 2.5 (photo variant) — render a "FOTO" mode photo taken WITH music
// into a real video. Same trusted-backend-only reasoning as muxReelMusic
// above (real ffmpeg processing, no client SDK can do this), but this is a
// DIFFERENT operation: muxReelMusic merges an audio track into an EXISTING
// video; this one generates the video itself from a still image plus music
// (see Reel.needsPhotoVideoRender's own doc comment and
// functions/src/index.ts's renderPhotoToVideo). Only ever called — instead
// of muxReelMusic, never alongside it — between the photo/thumbnail/music
// uploads finishing and publishReel, for a draft created with
// CreateReelDraftInput's `photoRenderPending: true`.
// ---------------------------------------------------------------------------

export type RenderPhotoToVideoResult = { ok: true } | { ok: false; message: string };

export async function renderPhotoToVideo(reelId: string): Promise<RenderPhotoToVideoResult> {
  if (!functions) {
    return { ok: false, message: 'This feature is not available right now.' };
  }
  try {
    await httpsCallable(functions, 'renderPhotoToVideo')({ reelId });
  } catch {
    return { ok: false, message: "Couldn't finish processing this post." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Own captured audio (a plain video with no picked music, musicSourceType
// 'none') made saveable/reusable ON DEMAND — see
// SoundSheet.tsx's own doc comment for why this is deliberately lazy
// rather than run on every ordinary video publish: extracting and hashing
// an audio track costs real server compute, and the overwhelming majority
// of videos never have anyone open their sound sheet at all, let alone
// try to save/reuse it. Idempotent — safe to call again for a Reel this
// has already resolved (returns the existing values without redoing any
// work), and safe for two different viewers to call around the same time
// (functions/src/index.ts's resolveSoundOrigin handles that race with a
// transaction, exactly like a real device-picked sound would).
// ---------------------------------------------------------------------------

export type ResolveOwnSoundOriginResult =
  | { ok: true; musicHash: string; originAuthorUid: string; originReelId: string }
  | { ok: false; message: string };

export async function resolveOwnSoundOrigin(reelId: string): Promise<ResolveOwnSoundOriginResult> {
  if (!functions) {
    return { ok: false, message: 'This feature is not available right now.' };
  }
  try {
    const result = await httpsCallable(functions, 'resolveOwnSoundOrigin')({ reelId });
    const data = result.data as { musicHash: string; originAuthorUid: string; originReelId: string };
    return { ok: true, musicHash: data.musicHash, originAuthorUid: data.originAuthorUid, originReelId: data.originReelId };
  } catch (error) {
    if (__DEV__) {
      console.warn('[reels] resolveOwnSoundOrigin failed:', error);
    }
    return { ok: false, message: "Couldn't process this post's sound." };
  }
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
  // The Reel is genuinely published in Firestore from this point on, even
  // if the read-back or hashtag-count step below somehow fails — so the
  // feed-invalidation signal fires here, not after either of those. See
  // getReelFeedDirtyVersion's own doc comment above for the full reasoning.
  reelFeedDirtyVersion += 1;
  const published = await fetchReel(reelId);
  if (!published) {
    return { ok: false, error: 'unknown', message: 'Post was published but could not be read back.' };
  }

  // Best-effort — this Reel is already genuinely published at this point
  // (the update above succeeded); a hashtag-count hiccup shouldn't turn a
  // successful publish into a reported failure. See incrementHashtagCounts'
  // own doc comment for why this is deliberately a separate transaction
  // from the publish write itself.
  try {
    await incrementHashtagCounts(published.hashtags ?? []);
  } catch {
    if (__DEV__) {
      console.warn(`[reels] Couldn't update hashtag counts for Reel "${reelId}" — publish itself still succeeded.`);
    }
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

export async function discardReelDraft(
  reelId: string,
  storagePath: string,
  thumbnailStoragePath: string,
  musicStoragePath?: string,
  // Step 9A — optional, and only ever 'r2' for a Reel whose video source
  // and/or thumbnail actually moved there (see uploadReelVideoViaR2/
  // uploadReelThumbnailViaR2 above) — undefined/'firebase' means "nothing
  // to clean up beyond the Firebase attempts above," matching every
  // pre-Step-9A draft's own real behavior exactly. Passed by the one
  // caller (create/reel/index.tsx's handleDiscard) straight from the
  // draft Reel's own `storageProvider`/`thumbnailStorageProvider` fields.
  storageProvider?: ReelStorageProvider,
  thumbnailStorageProvider?: ReelThumbnailStorageProvider,
  // Step 10B — same convention as storageProvider/thumbnailStorageProvider
  // above, for the Reel's own standalone music object (see
  // uploadReelMusicAudioViaR2 above).
  musicStorageProvider?: ReelStorageProvider
): Promise<void> {
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
    // Unlike music, the thumbnail path always exists on the draft (see
    // createReelDraft) — but the actual upload may not have happened yet
    // by the time discard runs, so a "not found" here is expected and
    // harmless, same as the video's own delete above.
    try {
      await deleteObject(ref(storage, thumbnailStoragePath));
    } catch (error) {
      if (__DEV__) {
        console.warn(
          `[reels] Could not delete thumbnail Storage object at "${thumbnailStoragePath}" while discarding Reel "${reelId}" — ` +
            'it may be left orphaned and require cleanup via trusted CLI tooling. Error:',
          error
        );
      }
    }
    // The music object only ever exists if musicSourceType was 'device'
    // (see createReelDraft) — an empty/absent path here means there is
    // nothing to delete, not an error.
    if (musicStoragePath) {
      try {
        await deleteObject(ref(storage, musicStoragePath));
      } catch (error) {
        if (__DEV__) {
          console.warn(
            `[reels] Could not delete music Storage object at "${musicStoragePath}" while discarding Reel "${reelId}" — ` +
              'it may be left orphaned and require cleanup via trusted CLI tooling. Error:',
            error
          );
        }
      }
    }
  }
  // Step 9A/10B — a Firebase Storage object this draft never actually
  // held (because its video/thumbnail/music went to R2 instead) has no
  // equivalent client-reachable delete path — R2 credentials never leave
  // the backend (see r2Config.ts's own doc comment) — so this asks the
  // trusted discardReelSource callable to clean up whichever of the
  // three objects actually exist there. Best-effort, same reasoning as
  // every Firebase delete attempt above: a cleanup failure here must
  // never block the draft's own Firestore deletion just below.
  if ((storageProvider === 'r2' || thumbnailStorageProvider === 'r2' || musicStorageProvider === 'r2') && functions) {
    try {
      await httpsCallable(functions, 'discardReelSource')({ reelId });
    } catch (error) {
      if (__DEV__) {
        console.warn(
          `[reels] Could not clean up R2 media while discarding Reel "${reelId}" — it may be left orphaned and require cleanup via trusted CLI tooling. Error:`,
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

/**
 * The equality/`in` clause a scoped query filters on — `cityKey`
 * (`==` for one City, `in` for several Cities), `countryCode` for Country
 * scope, or none at all for World (every published Reel, everywhere).
 * See src/types/browseScope.ts's own doc comment for why this never
 * affects what a new Reel is created with, only what a query reads back.
 *
 * NEVER use this for a query that already has its own `in`/
 * `array-contains-any` clause (fetchFollowingReels below already filters
 * `authorUid in [...]`) — Firestore allows only ONE such clause per
 * query. Use scopeVariants for that instead.
 */
function scopeWhereClause(scope: BrowseScope): QueryConstraint[] {
  if (scope.kind === 'city') return [where('cityKey', '==', scope.cityKey)];
  if (scope.kind === 'cities') return [where('cityKey', 'in', scope.cityKeys)];
  if (scope.kind === 'country') return [where('countryCode', '==', scope.countryCode)];
  return [];
}

/**
 * Every scope kind EXCEPT 'cities' already reads as a single query variant
 * (one equality clause, or none). 'cities' scope expands into one variant
 * per city (`cityKey == that city`) instead of the `in` clause
 * scopeWhereClause would build for it, because fetchFollowingReels
 * already has its OWN `in` clause (`authorUid in [...]`) — Firestore
 * permits only one per query — so it runs one query per (authorUid
 * chunk × variant) pair and merges everything. Every other scope kind
 * still reuses the exact same composite index it always has (see
 * firestore.indexes.json) since each variant here is structurally
 * identical to scopeWhereClause's own single-variant output.
 */
function scopeVariants(scope: BrowseScope): QueryConstraint[][] {
  if (scope.kind === 'cities') return scope.cityKeys.map((cityKey) => [where('cityKey', '==', cityKey)]);
  return [scopeWhereClause(scope)];
}

/** Newest published Reels in one scope (city/country/world). Never fetches all Reels then filters client-side. */
export async function fetchCityReels(scope: BrowseScope, limitCount = DEFAULT_FEED_LIMIT): Promise<Reel[]> {
  if (!firestore) return [];
  const feedQuery = query(
    collection(firestore, REELS_COLLECTION),
    ...scopeWhereClause(scope),
    where('status', '==', 'published'),
    orderBy('publishedAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(feedQuery);
  return snapshot.docs.map((docSnapshot) => normalizeReel(docSnapshot.data() as Reel));
}

export type ReelScopePage = {
  items: Reel[];
  /** Pass back as `cursor` on the next call to keep paging through this SAME scope — `null` once this scope has no more results (a page shorter than requested — the same "no more results" signal getRecentPostsForHashtag below already uses, never an extra read just to check). */
  cursor: QueryDocumentSnapshot<DocumentData> | null;
};

/**
 * Cursor-paginated counterpart to fetchCityReels above, for the Reels
 * "For You" candidate generator only (candidateGenerator.ts). Identical
 * WHERE/orderBy shape (same eligible-candidate SET for a given scope,
 * same composite index) — a real `startAfter` cursor is the only
 * difference, so "load more" advances through a scope's own Reels
 * instead of re-running the same bounded top-N query from the start
 * every page. This changes HOW candidates already eligible for a scope
 * are fetched, never WHICH ones are eligible (scopeWhereClause is
 * untouched and shared with fetchCityReels) or how they're later ranked.
 *
 * `fetchCityReels` itself is left completely unchanged and still used
 * as-is by the standalone Reels browser screen (src/app/(app)/reels.tsx)
 * and by 'cities' (multi-city) scope in candidateGenerator.ts — see that
 * file's own doc comment for why 'cities' scope doesn't route through
 * this cursor-paginated path at all.
 */
export async function fetchCityReelsPage(
  scope: BrowseScope,
  cursor: QueryDocumentSnapshot<DocumentData> | null,
  limitCount: number
): Promise<ReelScopePage> {
  if (!firestore) return { items: [], cursor: null };
  const snapshot = await getDocs(
    query(
      collection(firestore, REELS_COLLECTION),
      ...scopeWhereClause(scope),
      where('status', '==', 'published'),
      orderBy('publishedAt', 'desc'),
      ...(cursor ? [startAfter(cursor)] : []),
      limit(limitCount)
    )
  );
  const items = snapshot.docs.map((docSnapshot) => normalizeReel(docSnapshot.data() as Reel));
  const nextCursor = snapshot.docs.length === limitCount ? snapshot.docs[snapshot.docs.length - 1] : null;
  return { items, cursor: nextCursor };
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
  /** The scope to filter the feed to — Active Scope, passed explicitly (same pattern as fetchFollowingFeed in content.ts). */
  scope: BrowseScope;
  limit?: number;
};

export type FollowingReelsResult = {
  reels: Reel[];
  /**
   * Whether the caller follows anyone at all — lets the UI distinguish
   * "you don't follow anyone yet" from "you follow people, but none of
   * them have Reels in this scope" without a second, duplicate
   * fetchFollowingUids call (this function already makes exactly one).
   */
  followsAnyone: boolean;
};

/**
 * Published Reels, in one scope (city/country/world), from people
 * `currentUid` follows — chronological (newest publishedAt first). Mirrors
 * fetchFollowingFeed in src/services/content.ts exactly: resolves followed
 * uids first, then queries Reels directly by those uids in chunks of
 * FOLLOWING_UID_CHUNK_SIZE (10, well under the JS SDK's 30-value `in`
 * cap), each chunk further scoped by the same clause + status so this
 * never fetches a followed author's Reels outside the current scope only
 * to discard them client-side. Results are merged, deduplicated by
 * reelId, globally re-sorted by publishedAt, and capped to the requested
 * limit. Uses one dedicated (scope clause, status, authorUid,
 * publishedAt DESC) composite index per BrowseScope kind — see
 * firestore.indexes.json.
 */
export async function fetchFollowingReels({
  currentUid,
  scope,
  limit: limitCount = DEFAULT_FOLLOWING_FEED_LIMIT,
}: FetchFollowingReelsInput): Promise<FollowingReelsResult> {
  if (!firestore) return { reels: [], followsAnyone: false };
  const db = firestore;

  const followedUids = await fetchFollowingUids(currentUid, MAX_FOLLOWED_UIDS_PER_FEED_PAGE);
  if (followedUids.length === 0) {
    return { reels: [], followsAnyone: false };
  }

  const chunks = chunkArray(followedUids, FOLLOWING_UID_CHUNK_SIZE);
  // Cross-product of author chunks × scope variants — see scopeVariants'
  // own doc comment for why a multi-city scope can't just fold into a
  // single `in` clause here (authorUid already owns this query's one
  // allowed `in`).
  const variants = scopeVariants(scope);
  const chunkResults = await Promise.all(
    chunks.flatMap((chunk) =>
      variants.map((variant) =>
        getDocs(
          query(
            collection(db, REELS_COLLECTION),
            where('authorUid', 'in', chunk),
            ...variant,
            where('status', '==', 'published'),
            orderBy('publishedAt', 'desc'),
            limit(limitCount)
          )
        )
      )
    )
  );

  const seenReelIds = new Set<string>();
  const merged: Reel[] = [];
  for (const snapshot of chunkResults) {
    for (const docSnapshot of snapshot.docs) {
      const reel = normalizeReel(docSnapshot.data() as Reel);
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
  return snapshot.docs.map((docSnapshot) => normalizeReel(docSnapshot.data() as Reel));
}

const DEFAULT_SOUND_REEL_LIMIT = 30;

/**
 * Every currently-published Reel sharing one exact sound (see
 * Reel.musicHash's own doc comment in src/types/reel.ts), OLDEST first —
 * the first entry is always the real origin (soundOriginAuthorUid/
 * soundOriginReelId on every result in this list point back to that same
 * first entry's authorUid/reelId). Powers SoundSheet's post grid and
 * fetchSavedPosts' 'sound' resolution (src/services/saved.ts) — there is
 * no separate client-readable "sound" document to show details from
 * (soundOrigins/{musicHash} is server-only), so the origin Reel itself is
 * always what's actually displayed.
 */
export async function fetchReelsByMusicHash(musicHash: string, limitCount = DEFAULT_SOUND_REEL_LIMIT): Promise<Reel[]> {
  if (!firestore || !musicHash) return [];
  const soundReelsQuery = query(
    collection(firestore, REELS_COLLECTION),
    where('musicHash', '==', musicHash),
    where('status', '==', 'published'),
    orderBy('publishedAt', 'asc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(soundReelsQuery);
  return snapshot.docs.map((docSnapshot) => normalizeReel(docSnapshot.data() as Reel));
}

// ---------------------------------------------------------------------------
// Hashtag page (Step: hashtag discovery) — Recent/Top. Live here, not in
// src/services/hashtags.ts, for the same reason fetchReelsByMusicHash
// above lives here rather than in a hypothetical "music service": both
// are Reel QUERIES filtered by some other dimension a Reel carries, and
// this file already owns every other Reel query. hashtags.ts owns the
// hashtags/{hashtagId} COLLECTION itself (getHashtag/searchHashtags/
// incrementHashtagCounts) and the pure text utilities — not Reel
// querying. Importing normalizeReel/REELS_COLLECTION from hashtags.ts
// instead (the other direction) would create a real import cycle, since
// reels.ts already imports extractHashtags/incrementHashtagCounts FROM
// hashtags.ts.
// ---------------------------------------------------------------------------

const HASHTAG_PAGE_SIZE = 15;
// The bounded pool Top ranks locally within — see getTopPostsForHashtag's
// own doc comment for why this is a single fetch, not a query per page.
const HASHTAG_TOP_CANDIDATE_POOL_LIMIT = 60;

export type HashtagRecentPage = {
  items: Reel[];
  /** Pass back as `options.cursor` to fetch the next page — `undefined` once there's nothing more to fetch (this page came back shorter than the requested limit). */
  cursor: QueryDocumentSnapshot<DocumentData> | undefined;
};

/**
 * Recent tab — every currently-published Reel carrying this exact
 * (already-normalized) hashtag, newest-published-first, cursor-paginated
 * exactly like a real Firestore "load more" (see HashtagRecentPage) —
 * the first genuine cursor-paginated query in this codebase (every
 * existing Reel query so far has been a single bounded page — see e.g.
 * fetchReelsByMusicHash above), added because Recent specifically needs
 * to keep going arbitrarily far back in time without ever re-fetching
 * pages already seen.
 *
 * Ordered by `publishedAt`, not `createdAt` — matching every other Reel
 * query in this file (fetchCityReels, fetchFollowingReels,
 * fetchProfileReels, fetchReelsByMusicHash all order by `publishedAt`),
 * since that's when a Reel actually became a real, visible post; an
 * "uploading" draft's own `createdAt` could be long before it ever
 * publishes, or it may never publish at all. Needs its own composite
 * index (`hashtags` array-contains + `status` + `publishedAt` desc) — see
 * firestore.indexes.json.
 */
export async function getRecentPostsForHashtag(
  hashtag: string,
  options: { limitCount?: number; cursor?: QueryDocumentSnapshot<DocumentData> } = {}
): Promise<HashtagRecentPage> {
  if (!firestore || !hashtag) return { items: [], cursor: undefined };
  const limitCount = options.limitCount ?? HASHTAG_PAGE_SIZE;

  const constraints = [
    where('hashtags', 'array-contains', hashtag),
    where('status', '==', 'published'),
    orderBy('publishedAt', 'desc'),
    ...(options.cursor ? [startAfter(options.cursor)] : []),
    limit(limitCount),
  ];
  const snapshot = await getDocs(query(collection(firestore, REELS_COLLECTION), ...constraints));

  return {
    items: snapshot.docs.map((docSnapshot) => normalizeReel(docSnapshot.data() as Reel)),
    // A page shorter than what was asked for is the standard "no more
    // results" signal — never an extra read just to check.
    cursor: snapshot.docs.length === limitCount ? snapshot.docs[snapshot.docs.length - 1] : undefined,
  };
}

/**
 * Top tab — per explicit design constraint, NOT a second Firestore query
 * per page: a single bounded candidate pool (the
 * HASHTAG_TOP_CANDIDATE_POOL_LIMIT most recently published Reels carrying
 * this hashtag — the exact same query/index getRecentPostsForHashtag
 * itself uses, just without a cursor) is fetched ONCE, its engagement
 * stats are read in one batch (fetchEngagementStatsBatch — the same
 * trusted `stats/engagement` reads the For You feed itself is built on,
 * see src/types/engagementStats.ts), and every candidate is scored with
 * the SAME scoreContentQuality the For You ranking pipeline already uses
 * (src/services/recommendations/ranking.ts) — no separate/invented
 * "hashtag ranking formula", no per-post extra reads beyond the one
 * batch. The full ranked list is returned in one call; the caller (the
 * hashtag screen) pages through it by slicing this already-computed
 * array in memory — "Show more" reveals more of the SAME fetch, never a
 * repeated download of the same underlying data.
 *
 * A Reel with no stats doc yet scores using EMPTY_ENGAGEMENT_STATS —
 * scoreContentQuality's own design (Bayesian-shrunk toward a neutral
 * prior) already treats that as "no data yet", never a penalty.
 */
export async function getTopPostsForHashtag(hashtag: string, poolLimit = HASHTAG_TOP_CANDIDATE_POOL_LIMIT): Promise<Reel[]> {
  if (!firestore || !hashtag) return [];

  const snapshot = await getDocs(
    query(
      collection(firestore, REELS_COLLECTION),
      where('hashtags', 'array-contains', hashtag),
      where('status', '==', 'published'),
      orderBy('publishedAt', 'desc'),
      limit(poolLimit)
    )
  );
  const candidates = snapshot.docs.map((docSnapshot) => normalizeReel(docSnapshot.data() as Reel));
  if (candidates.length === 0) return [];

  const statsById = await fetchEngagementStatsBatch(
    'reel',
    candidates.map((reel) => reel.reelId)
  );
  const scored = candidates.map((reel) => ({
    reel,
    // hasVideo/videoDurationMs — same convention recommendationEngine.ts's
    // own Reel scoring call already uses (`mediaType !== 'photo'`).
    score: scoreContentQuality(statsById.get(reel.reelId) ?? EMPTY_ENGAGEMENT_STATS, reel.mediaType !== 'photo', reel.durationMs),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.reel);
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
