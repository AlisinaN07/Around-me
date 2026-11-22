import type { Timestamp } from 'firebase/firestore';

import type { ReelMediaType, ReelStorageProvider } from '@/types/reel';

/**
 * stories/{storyId} — a separate root collection from reels/{reelId}
 * (see src/types/reel.ts). A Story is a Reel's simpler, EPHEMERAL sibling:
 * no caption, no category, no music, no likes/comments/thumbnail, no
 * feed algorithm — just one photo or video, visible for 24 hours to the
 * author's followers, then gone. Created from the exact same capture
 * screen as a Reel (src/app/(app)/create/reel/camera.tsx's "Story" button,
 * right next to "Next") but published through this completely separate,
 * much smaller pipeline — reusing Reel's own file-size/duration caps
 * (REEL_MAX_FILE_SIZE_BYTES / REEL_PHOTO_MAX_FILE_SIZE_BYTES /
 * REEL_MAX_DURATION_MS in src/types/reel.ts) rather than duplicating them,
 * since it's the exact same camera output either way.
 *
 * VISIBILITY: followers-only (checked via the deterministic
 * follows/{followerUid}_{followingUid} doc — see firestore.rules), unlike
 * Reels' city-wide visibility. The author can always read their own Story
 * regardless of the follow graph.
 *
 * EXPIRY: `expiresAt` is set at publish time to roughly `publishedAt +
 * STORY_EXPIRY_MS`, computed CLIENT-SIDE (see publishStory in
 * src/services/stories.ts) — there is no server-stamped authoritative
 * value — so Firestore Rules instead bound it to a narrow window around
 * `request.time + 24h` so a client can't fabricate a much longer-lived
 * Story. Every read query filters `expiresAt > now` (see
 * fetchActiveStoriesForFollowing) so an expired Story stops appearing
 * anywhere in the app the INSTANT it lapses, well before physical
 * cleanup ever runs.
 *
 * Step 10A.1 — physical cleanup: a Story's Firestore document and its
 * own Storage media (Firebase or R2 — see `storageProvider` below) are
 * NOT deleted the moment `expiresAt` passes; they're removed by
 * `cleanupExpiredStories`, an hourly scheduled Cloud Function (see
 * functions/src/index.ts and its own pure orchestration,
 * functions/src/media/storyExpiryCleanup.ts) — a deliberate,
 * provider-aware, failure-safe design (a genuine storage-provider error
 * retains the Firestore document for the next run rather than ever
 * orphaning media with no remaining record of where it lives), not a
 * same-instant delete. A Story can therefore be visibly gone from every
 * query for up to roughly an hour before its underlying records are
 * actually removed — an accepted, documented lag, not a bug.
 */
export type StoryStatus = 'uploading' | 'published';

/** 24 hours, in milliseconds — see `expiresAt`'s own doc comment above. */
export const STORY_EXPIRY_MS = 24 * 60 * 60 * 1000;

export type Story = {
  storyId: string;
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  /** 'video' or 'photo' — see ReelMediaType's own doc comment in src/types/reel.ts. No "FOTO"-with-music/needsPhotoVideoRender concept here: a Story is always exactly the raw camera output, nothing rendered server-side. */
  mediaType: ReelMediaType;
  storagePath: string;
  storageContentType: string;
  fileSizeBytes: number;
  /** 0 for a photo Story. For a video Story, the actual recorded length — same client-declared caveat as Reel.durationMs. */
  durationMs: number;
  width: number;
  height: number;
  status: StoryStatus;
  /**
   * Step 10A — which backend this Story's own `storagePath` object
   * actually lives on. 'firebase' (the fixed default at create — see
   * isValidStoryCreate, firestore.rules) until a client-side R2 upload
   * confirms otherwise via confirmStoryMediaProvider (src/services/stories.ts),
   * a narrow, one-time, server-authorized Firestore transition
   * (isValidStoryProviderUpdate) — exactly mirroring Reel.storageProvider's
   * own model (src/types/reel.ts). A legacy Story predating this field
   * entirely reads as missing here, defaulted to 'firebase' at every
   * READ site via pickProviderUrl (src/services/media/providerAwareUrl.ts),
   * never inferred from `storagePath`/`mediaUrl`'s own shape.
   */
  storageProvider?: ReelStorageProvider;
  /**
   * Step 10A — the resolved, cache-busted R2 delivery URL, set ONLY once
   * `storageProvider` is 'r2' — `''` otherwise (the fixed create-time
   * default, same empty-string-sentinel convention as Reel.sourceUrl).
   * Never read directly by UI code — see resolveStoryPlaybackUrl, which
   * branches on `storageProvider` via the shared pickProviderUrl, exactly
   * like resolveReelVideoPlaybackUrl already does for Reels.
   */
  mediaUrl?: string;
  /**
   * Step 11C — whether this Story's OWN video source object (at
   * `storagePath`) has already been through server-side normalization
   * (see functions/src/media/videoNormalizationProfile.ts's own
   * VIDEO_DELIVERY_PROFILE — the exact same target a Reel's video
   * normalizes to: max 1920x1080 bounding box, H.264/yuv420p, CRF 23,
   * capped at 30fps, AAC 128k, faststart). Always `false` at create,
   * regardless of mediaType (same uniform-default convention as every
   * other Story field — see isValidStoryCreate). For a PHOTO Story stays
   * `false` forever — a photo is never transcoded at all (Part 4 of the
   * Step 11C spec) and isValidStoryPublish exempts photo Stories from
   * requiring this entirely. For a DIRECT video Story, flips to `true`
   * exactly once via finalizeStoryVideo (a trusted Admin SDK write,
   * never client-writable directly — there is no Firestore Rules
   * transition for this field at all, since every write to it bypasses
   * Rules already). For a Story copied from an already-published Reel
   * (addReelToMyStory), this is set directly from that Reel's OWN
   * `sourceNormalized` value at creation time — a video Reel can only
   * ever be `published` once its own source is normalized (see
   * firestore.rules' own isValidReelPublish), so copying that already-
   * trusted value forward is correct without re-touching storage
   * metadata or running ffmpeg a second time. isValidStoryPublish
   * independently REQUIRES this to already be `true` before a video
   * Story can reach `status: 'published'` through the normal client
   * publish path — a real server-enforced invariant.
   */
  sourceNormalized: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  publishedAt: Timestamp | null;
  /** See this file's own header doc comment for the full expiry model. `null` while `status` is still 'uploading'. */
  expiresAt: Timestamp | null;
};

/**
 * One author's currently-active Stories, oldest first (the standard
 * tap-through viewing order) — the shape fetchActiveStoriesForFollowing
 * groups its flat query results into, and what the Stories tray/viewer
 * actually render one ring/session per.
 */
export type StoryGroup = {
  authorUid: string;
  authorDisplayName: string;
  authorUsername: string;
  stories: Story[];
};
