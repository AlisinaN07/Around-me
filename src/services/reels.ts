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
  REEL_MUSIC_MAX_DURATION_MS,
  REEL_MUSIC_MAX_FILE_SIZE_BYTES,
  REEL_PHOTO_DURATION_MS,
  REEL_PHOTO_MAX_FILE_SIZE_BYTES,
  REEL_THUMBNAIL_MAX_FILE_SIZE_BYTES,
  type Reel,
  type ReelMediaType,
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
    musicHash: data.musicHash ?? '',
    soundOriginAuthorUid: data.soundOriginAuthorUid ?? '',
    soundOriginReelId: data.soundOriginReelId ?? '',
  };
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
    mediaType: input.mediaType,
    needsPhotoVideoRender: isPhotoPendingRender,
    storagePath: reelStoragePath(profile.uid, draftRef.id),
    storageContentType: input.storageContentType,
    fileSizeBytes: input.fileSizeBytes,
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

/**
 * Same shape/pattern as uploadReelVideo, for the separate music object at
 * `reel.musicStorageAudioPath` — only ever called when
 * `reel.musicSourceType === 'device'` (an empty path otherwise; see
 * createReelDraft). This is a SEPARATE Storage object from the video, not
 * muxed into it — see ReelMusicSourceType's doc comment in
 * src/types/reel.ts for why.
 */
export function uploadReelMusicAudio(
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

/** Same shape/pattern as uploadReelVideo/uploadReelMusicAudio, for the cover-frame image at `reel.thumbnailStoragePath` — always uploaded, unlike music. */
export function uploadReelThumbnail(
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

export async function discardReelDraft(
  reelId: string,
  storagePath: string,
  thumbnailStoragePath: string,
  musicStoragePath?: string
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
  return snapshot.docs.map((docSnapshot) => normalizeReel(docSnapshot.data() as Reel));
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
