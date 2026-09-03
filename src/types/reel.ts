import type { Timestamp } from 'firebase/firestore';

/**
 * reels/{reelId} — a separate root collection from content/{contentId}.
 * Reels have a media upload lifecycle (Storage object + upload state) that
 * Post/Activity/Event never had, so they don't share the content model —
 * see the Step 18 spec's "Product model decision."
 */
export type ReelStatus = 'uploading' | 'published';

/** Only "city" exists in this MVP — same as content visibility. */
export type ReelVisibility = 'city';

export const REEL_CAPTION_MAX_LENGTH = 500;

/** Hard Storage-enforced cap on uploaded file size. */
export const REEL_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Target maximum Reel duration. This is validated client-side and against
 * the declared `durationMs` in Firestore Rules — it is NOT a guarantee
 * about the actual media file, since Firestore/Storage Rules cannot
 * inspect real video duration. See src/services/reels.ts for the full
 * explanation of this limitation.
 */
export const REEL_MAX_DURATION_MS = 60_000;

/**
 * reels/{reelId}. authorDisplayName/authorUsername/cityName/countryCode/
 * cityKey are a PUBLIC-SAFE SNAPSHOT of the author's private users/{uid}
 * profile at creation time, exactly like content/{contentId} — verified
 * against that profile by Firestore Rules on create (see firestore.rules).
 *
 * Never add: author email, precise GPS, auth tokens, Storage download-URL
 * tokens, or any other private account data to this shape.
 *
 * storagePath points at the Cloud Storage object (see
 * src/services/reels.ts for the exact path scheme) — never a
 * getDownloadURL() token URL. Playback URLs are resolved from
 * storagePath at runtime, not persisted.
 */
export type Reel = {
  reelId: string;
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  cityName: string;
  countryCode: string;
  cityKey: string;
  categoryId: string;
  caption: string;
  storagePath: string;
  storageContentType: string;
  fileSizeBytes: number;
  /**
   * Declared duration in milliseconds, taken from the picked asset's own
   * metadata. This is a CLIENT-DECLARED value, re-validated by Firestore
   * Rules to be within bounds — it is not proof of the real media
   * duration. True duration enforcement would require trusted
   * server-side media inspection (e.g. Cloud Functions + a media
   * probing library), which is explicitly out of scope for Step 18.
   */
  durationMs: number;
  width: number;
  height: number;
  status: ReelStatus;
  visibility: ReelVisibility;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  publishedAt: Timestamp | null;
};
