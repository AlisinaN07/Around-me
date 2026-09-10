import type { Timestamp } from 'firebase/firestore';

import type { ReelMediaType } from '@/types/reel';

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
 * src/services/stories.ts) since there is no scheduled Cloud Function in
 * this pass to stamp it authoritatively — Firestore Rules instead bound it
 * to a narrow window around `request.time + 24h` so a client can't
 * fabricate a much longer-lived Story. Every read query filters
 * `expiresAt > now` (see fetchActiveStoriesForFollowing) so an expired
 * Story simply stops appearing anywhere in the app the moment it lapses —
 * its Firestore document and Storage object are NOT actively deleted yet;
 * real cleanup (a scheduled Cloud Function, mirroring this project's other
 * trusted backend callables in functions/src/index.ts) is a deliberate
 * follow-up, not part of this pass.
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
