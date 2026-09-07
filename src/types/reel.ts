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

/** Hard Storage-enforced cap on an uploaded device-audio music file — generous relative to REEL_MAX_FILE_SIZE_BYTES since a full song, not just the looped portion actually heard, is uploaded (see ReelMusicSourceType's doc comment — there is no trim step yet). */
export const REEL_MUSIC_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

/** Generous cap on a picked music file's own declared length (most songs are 2-6 minutes) — NOT the Reel's own duration; only the first REEL_MAX_DURATION_MS of it is ever heard per loop (see ReelFeedItem.tsx). */
export const REEL_MUSIC_MAX_DURATION_MS = 600_000;

/** Hard Storage-enforced cap on the uploaded cover-thumbnail image — a single still frame, always far smaller than the video/music caps above. */
export const REEL_THUMBNAIL_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

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
/**
 * Background music attached to a Reel at capture time. 'none' is the
 * overwhelming default — every OTHER music field is always present too
 * (never conditionally omitted, matching this app's existing "always
 * present, neutral sentinel when unused" convention — see e.g. `bio` on
 * users/publicProfiles), just holding empty-string/0 sentinels when
 * `musicSourceType == 'none'`. 'device' is the only real source today —
 * the user's own on-device audio file, picked via a system file picker
 * (see src/app/(app)/create/reel/camera.tsx) — never a licensed catalog,
 * which doesn't exist yet (a future `musicSourceType` value, e.g.
 * 'catalog', is intentionally NOT reserved here — adding one later is an
 * additive Rules/type change, not a breaking one).
 *
 * ARCHITECTURE NOTE — real server-side muxing, not two synced files:
 * recording with music selected mutes the camera's own mic (`CameraView`'s
 * `mute` prop) so the chosen track is the only audio captured for that
 * take. The client uploads the silent video and the raw music file as two
 * separate Storage objects, then calls the trusted `muxReelMusic` Cloud
 * Function (functions/src/index.ts) before publishing — it runs real
 * `ffmpeg` (via `ffmpeg-static`) to merge them into ONE video file whose
 * audio track is the music, looped and cut to exactly the video's own
 * length, and deletes the now-redundant standalone music object. The
 * published Reel's video file therefore DOES carry a real audio track of
 * its own — it travels with the file everywhere (download, share outside
 * the app, etc.), unlike an earlier version of this feature that played
 * two separately-synced files instead (see git history if that's ever
 * relevant again). The only place two separately-synced players still
 * exist is the LOCAL capture/preview screen (camera.tsx), before the merge
 * has happened — see its own `musicPlayer` doc comment.
 */
export type ReelMusicSourceType = 'none' | 'device';

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
  /** See ReelMusicSourceType's own doc comment above for the full music model. */
  musicSourceType: ReelMusicSourceType;
  /** The picked file's display name (e.g. "Song.mp3") — '' when musicSourceType is 'none'. Never a real song/artist title; there is no metadata source for that with a device-picked file. */
  musicTitle: string;
  /** reels/{authorUid}/{reelId}/music — deterministic, mirrors `storagePath`. '' when musicSourceType is 'none'. */
  musicStorageAudioPath: string;
  musicStorageContentType: string;
  musicFileSizeBytes: number;
  /** Declared duration in milliseconds from the picked audio file — same client-declared caveat as `durationMs` above. 0 when musicSourceType is 'none'. */
  musicDurationMs: number;
  /**
   * A real still frame from THIS Reel's own video, chosen by the author
   * at capture time (see camera.tsx's cover-frame picker) — never a
   * generic placeholder or an unrelated image. `reels/{authorUid}/
   * {reelId}/thumbnail`, mirroring `storagePath` exactly. Always present
   * on every Reel created after this field was introduced; a Reel
   * published BEFORE it (if any still exist) simply won't have this key
   * in its stored document at all despite the type here claiming a
   * string — display code must treat a missing/empty value as "no
   * thumbnail available" and fall back gracefully (see
   * ReelPreviewCard.tsx), never assume the field is truly guaranteed at
   * runtime just because the type says so.
   */
  thumbnailStoragePath: string;
  thumbnailStorageContentType: string;
  thumbnailFileSizeBytes: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  publishedAt: Timestamp | null;
};

/**
 * reels/{reelId}/likes/{uid} — one document per user who liked a Reel.
 * Structurally parallel to content/{contentId}/likes/{uid} (see
 * src/types/content.ts's ContentLike) — the document ID (the liker's own
 * uid) is what guarantees at most one Like per user, so there's nothing
 * else to store beyond who and when.
 */
export type ReelLike = {
  uid: string;
  createdAt: Timestamp;
};

export const REEL_COMMENT_BODY_MAX_LENGTH = 500;

/**
 * reels/{reelId}/comments/{commentId} — top-level comments only, no
 * replies/threads, no edit — structurally parallel to
 * content/{contentId}/comments/{commentId} (see src/types/content.ts's
 * ContentComment). authorDisplayName/authorUsername are a public-safe
 * snapshot of the commenter's own profile, verified against it by
 * Firestore rules on create.
 */
export type ReelComment = {
  commentId: string;
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  body: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

/**
 * UI/runtime-only state for a video the user has picked or recorded but not
 * yet published (Step 20). Never persisted anywhere — `source` and `uri`
 * exist purely to drive the Create Reel screen (e.g. "Retake" vs. "Choose
 * another" copy) and are deliberately absent from the `Reel` document
 * itself: there is no product reason for other users (or even the author,
 * later) to know whether a given published Reel originally came from the
 * camera or the library, so nothing here crosses into `createReelDraft`
 * beyond the same category/caption/media fields library-picked videos
 * already provided.
 *
 * Metadata fields are nullable because the two sources populate them
 * differently: `expo-image-picker` returns fileSize/duration/width/height
 * directly from the asset; `expo-camera`'s `recordAsync()` returns only a
 * `uri` (see src/app/(app)/create/reel/camera.tsx), so a camera-sourced
 * value starts with these null and gets them filled in by a real probe
 * (see resolveCameraVideoMetadata) before publish is ever enabled — never
 * fabricated.
 */
export type SelectedReelVideo = {
  uri: string;
  source: 'camera' | 'library';
  fileSizeBytes: number | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
};

/**
 * UI/runtime-only state for a music file the user picked from their own
 * device to record over (see the camera screen's "Music" control and
 * ReelMusicSourceType's own doc comment for the full model). `null` means
 * no music selected — the camera's mic stays on. Cleared whenever the
 * captured/picked video changes, exactly like SelectedReelVideo itself.
 */
export type SelectedReelMusic = {
  uri: string;
  title: string;
  fileSizeBytes: number;
  mimeType: string;
  /** Not always known up front (expo-document-picker returns no duration) — filled in by a real probe, same reasoning as SelectedReelVideo's camera-sourced durationMs. */
  durationMs: number | null;
};

/**
 * The real cover-frame image for a Post, ready to upload. Chosen entirely
 * automatically, never by the user: the camera screen extracts several
 * candidate frames from the recorded/picked video (see
 * src/utils/reelThumbnailCandidates.ts) and always uses the middle one
 * (~50% into the clip) — there is no cover-picker UI shown to the person
 * posting. Generation happens silently in the background as soon as a
 * video is selected, or on demand as a fallback if it hasn't finished yet
 * by the time Next is pressed (see camera.tsx's `handleNext`) — either
 * way, publishing always has a real `SelectedReelThumbnail` by this point.
 */
export type SelectedReelThumbnail = {
  uri: string;
  fileSizeBytes: number;
  mimeType: string;
  width: number;
  height: number;
};
