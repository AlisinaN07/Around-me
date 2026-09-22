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

/** Also enforced server-side — see isValidReelCreate's `data.caption.size() <= 5000` in firestore.rules, which must be kept in sync with this. */
export const REEL_CAPTION_MAX_LENGTH = 5000;

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

/** Hard Storage-enforced cap on a "FOTO" mode Reel's own image (mediaType == 'photo', or a 'video' Reel with needsPhotoVideoRender == true before it's rendered — see that field's own doc comment) — bigger than the derived thumbnail cap above since this is the actual full-resolution Post, not a small cover crop. */
export const REEL_PHOTO_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * Fixed display length for a "FOTO" mode photo posted WITH music — rendered
 * server-side (see renderPhotoToVideo in functions/src/index.ts) into a
 * real 15-second MP4 (the still image held for the whole clip, the chosen
 * track as its audio track) and published as an ordinary `mediaType:
 * 'video'` Reel. Deliberately NOT one of REEL_MAX_DURATION_MS's two
 * user-selectable video lengths — a photo-with-music post always renders
 * to exactly this length, never 60s, never user-adjustable. A photo posted
 * WITHOUT music is unaffected by this constant at all — it stays
 * `mediaType: 'photo'` with `durationMs: 0`, exactly as before.
 */
export const REEL_PHOTO_DURATION_MS = 15_000;

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

/**
 * 'video' is every Reel published before this field existed and the
 * overwhelming majority since (see normalizeReel in src/services/reels.ts
 * for how a legacy document missing this key entirely is read back as
 * 'video', never a missing key call sites have to special-case). 'photo'
 * is a single still image captured via the camera screen's "FOTO" mode
 * WITHOUT music — it reuses `storagePath`/`storageContentType`/
 * `fileSizeBytes`/`width`/`height` for the photo itself (there's no
 * separate video to describe), `durationMs` is the sentinel `0` (a photo
 * has no duration), and `thumbnailStoragePath` etc. are set to the EXACT
 * SAME values as the main `storagePath` fields — the photo IS its own
 * cover image, so there is no separate thumbnail object to upload (see
 * createReelDraft). Every other field (caption, category, likes, comments,
 * follow, report, save, repost...) is identical either way; ReelFeedItem/
 * ReelPreviewCard are the only two places that need to know which kind of
 * media they're showing.
 *
 * A "FOTO" mode photo taken WITH music is deliberately NOT this 'photo'
 * type at all — see `needsPhotoVideoRender`'s own doc comment below for
 * why it's a real 'video' Reel from the moment its draft is created.
 */
export type ReelMediaType = 'video' | 'photo';

/**
 * Which backend a video Reel's `thumbnailStoragePath`/`thumbnailUrl`
 * actually live in — Step 5E's hybrid-media step. 'firebase' is every
 * Reel published before this field existed (see normalizeReel in
 * src/services/reels.ts) and every Reel published while
 * EXPO_PUBLIC_MEDIA_STORAGE_PROVIDER stays unset/'firebase' — for these,
 * `thumbnailUrl` is '' and the thumbnail is resolved the existing way,
 * lazily from `thumbnailStoragePath` via resolveReelPlaybackUrl. 'r2' is
 * set exactly once, by a trusted server write (see firestore.rules'
 * isValidReelThumbnailProviderUpdate and functions/src/media/
 * requestMediaUploadAuthorization.ts), the moment an R2 thumbnail upload
 * succeeds — never client-writable directly. Meaningless for a 'photo'
 * mediaType Reel (whose thumbnail IS its own primary storagePath, never
 * migrated by Step 5E) — see resolveReelThumbnailUrl in reels.ts.
 */
export type ReelThumbnailStorageProvider = 'firebase' | 'r2';

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
  /**
   * Every "#token" found in `caption` at creation time — normalized
   * lowercase, deduplicated, never re-derived later (see
   * src/utils/hashtags.ts's extractHashtags and src/services/reels.ts's
   * createReelDraft, the only place this is ever computed). `caption`
   * itself is always stored exactly as the author typed it; this is a
   * separate, derived field purely for lookup/counting — never the
   * source of truth for what the caption says.
   *
   * Always `[]` on a legacy Reel published before this field existed —
   * see normalizeReel. Immutable after creation, same as `caption` itself
   * (there is no caption-editing flow — see isValidReelPublish in
   * firestore.rules, which requires `hashtags` stay byte-identical
   * through publish).
   */
  hashtags: string[];
  mediaType: ReelMediaType;
  /**
   * True ONLY during the brief window between a "FOTO"-mode-with-music
   * draft's creation and the renderPhotoToVideo Cloud Function
   * (functions/src/index.ts) finishing — false for every other Reel,
   * including this one once rendering completes. While true, `mediaType`
   * is already `'video'` (so this Reel publishes and plays back through
   * the exact same code as any other video, once rendering is done), but
   * the Storage object at `storagePath` STILL actually holds the
   * originally-captured PHOTO (image/*, up to REEL_PHOTO_MAX_FILE_SIZE_BYTES)
   * rather than a real video — renderPhotoToVideo downloads that photo
   * plus the music at `musicStorageAudioPath`, renders a real
   * REEL_PHOTO_DURATION_MS-long MP4 (the image held static, the music as
   * its audio track) via ffmpeg, and overwrites `storagePath` with the
   * result in place — the same "overwrite in place, update
   * storageContentType/fileSizeBytes" pattern muxReelMusic already uses
   * for a video+music merge — before flipping this back to `false`.
   * Firestore Rules (isValidReelPublish) refuse to publish a Reel while
   * this is still `true`, specifically to prevent an un-rendered photo
   * from ever being published as if it were a real video. Always `false`
   * on a legacy document missing this key — see normalizeReel.
   */
  needsPhotoVideoRender: boolean;
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
   * Always `0` when mediaType is 'photo'. Always exactly
   * REEL_PHOTO_DURATION_MS for a "FOTO"-with-music Reel (mediaType
   * 'video' with needsPhotoVideoRender true, or already rendered) — see
   * that field's own doc comment.
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
   * Sound attribution — who this exact device-picked audio file traces
   * back to on Around Me, so the feed can show a "whose sound is this"
   * avatar (see ReelFeedItem.tsx's own doc comment) instead of only the
   * Reel's own author. ALWAYS `''` when musicSourceType is 'none' — a
   * Reel with no picked music has no sound to attribute at all (its own
   * captured audio belongs to its own author, trivially, with no lookup
   * needed).
   *
   * These three fields are NEVER set by the client — createReelDraft
   * always writes them as `''`, and only a trusted Cloud Function
   * (muxReelMusic or renderPhotoToVideo in functions/src/index.ts, both
   * already downloading the picked music file locally before this step)
   * computes musicHash (a SHA-256 of the audio file's actual bytes — the
   * only way to recognize "the same sound" across two unrelated
   * uploads, since a device-picked file carries no catalog/track ID of
   * its own) and looks it up against soundOrigins/{musicHash} — a
   * server-only collection (no client Firestore rule at all; it falls
   * under the default-deny catch-all) recording, per unique sound, the
   * FIRST Reel/author on Around Me ever traced to it, first-write-wins
   * via a Firestore transaction. isValidReelPublish (firestore.rules)
   * requires these three stay byte-identical from whatever the trusted
   * function already stamped — a client can never fabricate its own
   * attribution.
   *
   * Always `''` on a legacy Reel missing these keys — see normalizeReel.
   */
  musicHash: string;
  /** The uid this Reel's picked sound is attributed to (itself, if this Reel is the first on Around Me traced to that exact audio) — see musicDurationMs's neighboring doc comment above for the full model. `''` whenever musicSourceType is 'none', or on any legacy Reel predating this feature. */
  soundOriginAuthorUid: string;
  /** The reelId of the very first Reel traced to this exact sound (may be this Reel's own reelId) — paired with soundOriginAuthorUid above, same doc comment. */
  soundOriginReelId: string;
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
   *
   * When mediaType is 'photo', this (and the four fields below it) are set
   * to the EXACT SAME values as `storagePath`/`storageContentType`/
   * `fileSizeBytes`/`width`/`height` — the photo already IS its own cover
   * image, so there's no separate object uploaded for it (see
   * createReelDraft) — but the field is still always genuinely present,
   * same as for a video Reel.
   */
  thumbnailStoragePath: string;
  thumbnailStorageContentType: string;
  thumbnailFileSizeBytes: number;
  thumbnailWidth: number;
  thumbnailHeight: number;
  /**
   * Step 5E — which backend this Reel's thumbnail actually lives in. See
   * ReelThumbnailStorageProvider's own doc comment for the full model.
   * Always `'firebase'` on a legacy Reel missing this key — see
   * normalizeReel, same "required-field-with-default" convention as
   * `musicHash` etc. above. Never client-writable to `'r2'` directly —
   * only a trusted server write can flip it (see firestore.rules'
   * isValidReelThumbnailProviderUpdate).
   */
  thumbnailStorageProvider: ReelThumbnailStorageProvider;
  /**
   * Step 5E — the resolved, cache-busted R2 delivery URL for this Reel's
   * thumbnail, persisted at upload time (never derived from
   * `thumbnailStoragePath` the way a Firebase-backed thumbnail's URL is
   * resolved lazily at render time — see resolveReelThumbnailUrl in
   * reels.ts). `''` whenever `thumbnailStorageProvider` is `'firebase'`
   * (including every legacy Reel) — meaningful ONLY when
   * `thumbnailStorageProvider === 'r2'`. Set exactly once by a trusted
   * server write, never client-writable directly (same rule as
   * `thumbnailStorageProvider` above).
   */
  thumbnailUrl: string;
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
 * reels/{reelId}/comments/{commentId} — one flat subcollection holding
 * both top-level comments AND their replies (no edit either way) —
 * structurally parallel to content/{contentId}/comments/{commentId} (see
 * src/types/content.ts's ContentComment), just with one extra field.
 * authorDisplayName/authorUsername are a public-safe snapshot of the
 * commenter's own profile, verified against it by Firestore rules on
 * create.
 *
 * `parentCommentId` is `null` for an ordinary top-level comment, or the
 * `commentId` of the comment being replied to — anyone may reply to any
 * top-level comment. Deliberately capped at one level: a reply's own
 * `parentCommentId` must point to a comment that is ITSELF top-level (see
 * firestore.rules' isValidReelCommentCreate) — there is no reply-to-a-
 * reply nesting, matching the simple "comment + its replies" UI this
 * feeds (src/components/ReelCommentsSheet.tsx), not a full thread tree.
 * Always present, never conditionally omitted, same convention as every
 * other Reel-adjacent field in this app.
 */
export type ReelComment = {
  commentId: string;
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  body: string;
  parentCommentId: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export type ReelCommentReactionType = 'like' | 'dislike';

/**
 * reels/{reelId}/comments/{commentId}/reactions/{uid} — one document per
 * user per comment, exclusive (a user has either a 'like' or a 'dislike'
 * on a given comment, never both): switching from one to the other simply
 * overwrites `type` on the same doc rather than needing two separate
 * subcollections kept in sync. Deliberately separate from ReelLike (Reel-
 * level likes) — a comment reaction never feeds the lifetime "Liked"
 * profile stat (that's specifically for social Posts, see
 * postLikes/{likeId}'s own doc comment) and never generates a
 * notification; it's a lightweight, purely-informational reaction count.
 */
export type ReelCommentReaction = {
  uid: string;
  type: ReelCommentReactionType;
  createdAt: Timestamp;
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
 * UI/runtime-only state for a "FOTO" mode photo the user has captured or
 * picked but not yet published — the mediaType == 'photo' counterpart to
 * SelectedReelVideo above, with no `durationMs` (a photo has none).
 * `source` mirrors SelectedReelVideo's own — the Library "Choose from
 * library" button can hand back either a video OR a photo (expo-image-
 * picker's `mediaTypes: ['images', 'videos']`), so a photo is no longer
 * camera-only. `expo-camera`'s `takePictureAsync()` returns width/height/
 * uri directly (unlike `recordAsync()`, nothing here needs a post-capture
 * probe) — every field besides `mimeType`, which the camera doesn't
 * report at all, is non-null from the moment a photo is taken; a library
 * pick already reports all of these directly, same as a library video.
 */
export type SelectedReelPhoto = {
  uri: string;
  source: 'camera' | 'library';
  fileSizeBytes: number | null;
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
