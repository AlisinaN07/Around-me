/**
 * Stories data layer — the separate stories/{storyId} root collection (see
 * src/types/story.ts for why this is not part of reels/{reelId}) plus its
 * paired Cloud Storage object at stories/{authorUid}/{storyId}/source. UI
 * code should only ever import from here, never talk to Firestore/Storage
 * directly for Stories.
 *
 * Same two-phase lifecycle as Reels (see reels.ts's own file header):
 *   1. createStoryDraft — Firestore doc, status "uploading", publishedAt/
 *      expiresAt null.
 *   2. uploadStoryMedia — Cloud Storage upload to the exact reserved path.
 *   3. publishStory — status "uploading" -> "published", stamping
 *      publishedAt and expiresAt.
 * A Story is never created directly as "published" — Storage Rules require
 * an existing "uploading" draft naming that exact path before any upload to
 * it is accepted, and Firestore Rules require the same before publish.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type WithFieldValue,
} from 'firebase/firestore';
import { deleteObject, getDownloadURL, ref, uploadBytesResumable, type UploadTask } from 'firebase/storage';
import { httpsCallable } from 'firebase/functions';

import { REEL_MAX_DURATION_MS, REEL_MAX_FILE_SIZE_BYTES, REEL_PHOTO_MAX_FILE_SIZE_BYTES, type ReelMediaType } from '@/types/reel';
import { STORY_EXPIRY_MS, type Story, type StoryGroup } from '@/types/story';
import { TtlCache } from '@/utils/requestCache';

import { fetchFollowingUids } from './following';
import { firestore } from './firestore';
import { functions } from './functions';
import { storage } from './storage';
import { fetchUserProfile } from './userProfile';

const STORIES_COLLECTION = 'stories';
// Same 'in'-query chunk size Reels' own following feed uses (reels.ts) —
// the Firestore JS SDK's own limit for an 'in' filter's value list.
const FOLLOWED_UID_CHUNK_SIZE = 10;
const MAX_FOLLOWED_UIDS_FOR_STORIES = 30;

// Phase 2 perf pass — fetchActiveStoriesForAuthor is the one canonical
// per-author fetch path here (fetchActiveStoriesForFollowing below is a
// separate, bulk, multi-author query with a different shape — left
// uncached this phase, see this file's own Phase 2 notes at its call
// sites) — called once per Reel by ReelFeedItem's own story ring AND by
// the Story viewer screen, so the same author's active Stories are
// re-queried independently by every one of their Reels visible at once.
// Keyed by `authorUid` alone — "does this author currently have an
// active Story" is the same fact for every viewer, nothing account-
// specific (unlike isFollowing/isPostSaved). 60s TTL, per the suggested
// range. publishStory/deleteMyStory invalidate this on success (see their
// own bodies below) — markStoryViewed deliberately does NOT, since a
// story's active/expired status never depends on who's viewed it.
const ACTIVE_STORIES_CACHE_TTL_MS = 60_000;
const activeStoriesCache = new TtlCache<Story[]>(ACTIVE_STORIES_CACHE_TTL_MS);

export function storyRef(storyId: string) {
  return doc(firestore!, STORIES_COLLECTION, storyId);
}

/** stories/{authorUid}/{storyId}/source — deterministic, ownership-aware, mirrors reelStoragePath exactly (see src/services/reels.ts). */
export function storyStoragePath(authorUid: string, storyId: string): string {
  return `stories/${authorUid}/${storyId}/source`;
}

// ---------------------------------------------------------------------------
// Phase 1 — create the Firestore draft
// ---------------------------------------------------------------------------

export type CreateStoryDraftInput = {
  uid: string;
  mediaType: ReelMediaType;
  storageContentType: string;
  fileSizeBytes: number;
  /** Ignored (always stored as 0) when mediaType is 'photo' — same convention as Reel.durationMs. */
  durationMs: number;
  width: number;
  height: number;
};

export type StoryDraftError = 'not-configured' | 'no-profile' | 'invalid-input' | 'unknown';
export type CreateStoryDraftResult = { ok: true; story: Story } | { ok: false; error: StoryDraftError; message: string };

export async function createStoryDraft(input: CreateStoryDraftInput): Promise<CreateStoryDraftResult> {
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }

  const profile = await fetchUserProfile(input.uid);
  if (!profile || !profile.onboardingCompleted) {
    return { ok: false, error: 'no-profile', message: 'Complete your profile before sharing a Story.' };
  }

  const isPhoto = input.mediaType === 'photo';

  if (isPhoto) {
    if (!input.storageContentType.startsWith('image/')) {
      return { ok: false, error: 'invalid-input', message: 'Only image files can be shared as a photo Story.' };
    }
    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0 || input.fileSizeBytes > REEL_PHOTO_MAX_FILE_SIZE_BYTES) {
      return { ok: false, error: 'invalid-input', message: 'Photo must be under 10 MB.' };
    }
  } else {
    if (!input.storageContentType.startsWith('video/')) {
      return { ok: false, error: 'invalid-input', message: 'Only video files can be shared as a Story.' };
    }
    if (!Number.isFinite(input.fileSizeBytes) || input.fileSizeBytes <= 0 || input.fileSizeBytes > REEL_MAX_FILE_SIZE_BYTES) {
      return { ok: false, error: 'invalid-input', message: 'Video must be under 50 MB.' };
    }
    if (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > REEL_MAX_DURATION_MS) {
      return { ok: false, error: 'invalid-input', message: 'Video must be 60 seconds or shorter.' };
    }
  }
  if (!Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) {
    return { ok: false, error: 'invalid-input', message: isPhoto ? "Couldn't read this photo's dimensions." : "Couldn't read this video's dimensions." };
  }

  const draftRef = doc(collection(firestore, STORIES_COLLECTION));
  const data = {
    storyId: draftRef.id,
    authorUid: profile.uid,
    authorDisplayName: profile.displayName,
    authorUsername: profile.username,
    mediaType: input.mediaType,
    storagePath: storyStoragePath(profile.uid, draftRef.id),
    storageContentType: input.storageContentType,
    fileSizeBytes: input.fileSizeBytes,
    durationMs: isPhoto ? 0 : input.durationMs,
    width: input.width,
    height: input.height,
    status: 'uploading',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    publishedAt: null,
    expiresAt: null,
  } satisfies WithFieldValue<Story>;

  try {
    await setDoc(draftRef, data);
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't start this Story upload." };
  }

  const created = await getDoc(draftRef);
  if (!created.exists()) {
    return { ok: false, error: 'unknown', message: 'Story draft was created but could not be read back.' };
  }
  return { ok: true, story: created.data() as Story };
}

// ---------------------------------------------------------------------------
// Phase 2 — upload the media to Cloud Storage
// ---------------------------------------------------------------------------

export type UploadStoryMediaHandle = {
  /** Aborts the in-flight upload. Safe to call even if the upload hasn't started transferring yet. */
  cancel: () => void;
};

/** Same resumable-upload pattern as uploadReelVideo in reels.ts — see its own doc comment for why a Blob (not a `{ uri }` reference) is required. */
export function uploadStoryMedia(
  story: Story,
  localUri: string,
  onProgress: (percent: number) => void,
  onComplete: (result: { ok: true } | { ok: false; message: string }) => void
): UploadStoryMediaHandle {
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
      onComplete({ ok: false, message: "Couldn't read this file." });
      return;
    }
    if (cancelled) return;

    const objectRef = ref(storage, story.storagePath);
    task = uploadBytesResumable(objectRef, blob, { contentType: story.storageContentType });

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
        onComplete({ ok: false, message: "Couldn't upload this Story." });
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
// Phase 3 — publish
// ---------------------------------------------------------------------------

export type PublishStoryResult = { ok: true } | { ok: false; message: string };

/**
 * `authorUid` is optional purely for cache invalidation (see
 * activeStoriesCache's own doc comment above) — the caller already has it
 * on hand (the draft it just created/uploaded — see camera.tsx's own call
 * site) so passing it costs nothing and avoids an extra read here just to
 * look it back up. Omitting it just means fetchActiveStoriesForAuthor
 * keeps serving its previous (stale, "no active Story yet") answer for up
 * to ACTIVE_STORIES_CACHE_TTL_MS after this call — never a correctness
 * bug, only a staleness window, so this stays optional rather than a
 * required, behavior-changing param.
 */
export async function publishStory(storyId: string, authorUid?: string): Promise<PublishStoryResult> {
  if (!firestore) {
    return { ok: false, message: 'Firestore is not available.' };
  }
  const now = Date.now();
  try {
    await updateDoc(storyRef(storyId), {
      status: 'published',
      publishedAt: serverTimestamp(),
      // Computed CLIENT-SIDE, not via serverTimestamp() arithmetic (there
      // is no such thing — a sentinel can't be added to) — see
      // Story.expiresAt's own doc comment in src/types/story.ts for why
      // this is an accepted, Rules-bounded approximation rather than an
      // authoritative server-stamped value.
      expiresAt: Timestamp.fromMillis(now + STORY_EXPIRY_MS),
      updatedAt: serverTimestamp(),
    });
  } catch {
    return { ok: false, message: "Couldn't publish this Story." };
  }
  // Phase 2 perf pass — this Story just became active; anyone already
  // holding a cached "no active Stories" answer for this author (e.g. an
  // already-rendered ReelFeedItem of theirs) must see the new ring within
  // this same session, not up to 60s from now.
  if (authorUid) activeStoriesCache.delete(authorUid);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Discard an in-progress draft (cancelled upload) — same best-effort,
// idempotent pattern as discardReelDraft in reels.ts.
// ---------------------------------------------------------------------------

export async function discardStoryDraft(storyId: string, storagePath: string): Promise<void> {
  if (storage) {
    try {
      await deleteObject(ref(storage, storagePath));
    } catch (error) {
      if (__DEV__) {
        console.warn(
          `[stories] Could not delete Storage object at "${storagePath}" while discarding Story "${storyId}" — ` +
            'it may be left orphaned and require cleanup via trusted CLI tooling. Error:',
          error
        );
      }
    }
  }
  if (!firestore) return;
  try {
    await deleteDoc(storyRef(storyId));
  } catch {
    // Best-effort — a stuck "uploading" draft is harmless clutter, never a
    // published, user-visible Story.
  }
}

/** The author deleting their own Story early (Instagram-style "delete Story") — a plain client delete, no cascade to clean up (a Story has no likes/comments; its `views` subcollection is left as harmless orphaned data, same acceptable-orphan reasoning as elsewhere in this app). */
export async function deleteMyStory(storyId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) return { ok: false, message: 'Firestore is not available.' };
  const snapshot = await getDoc(storyRef(storyId));
  // Reads authorUid off the SAME snapshot already fetched for storagePath
  // below — no extra Firestore read just for cache invalidation.
  const existing = snapshot.exists() ? (snapshot.data() as Story) : undefined;
  const storagePath = existing?.storagePath;
  try {
    await deleteDoc(storyRef(storyId));
  } catch {
    return { ok: false, message: "Couldn't delete this Story." };
  }
  // Phase 2 perf pass — see publishStory's own doc comment above. A
  // deleted Story might have been this author's only active one; either
  // way, the cached answer for them is no longer necessarily correct.
  if (existing?.authorUid) activeStoriesCache.delete(existing.authorUid);
  if (storage && storagePath) {
    await deleteObject(ref(storage, storagePath)).catch(() => undefined);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reads — followers-only (see firestore.rules), always filtered to
// currently-active Stories (status 'published' && expiresAt > now — see
// Story.expiresAt's own doc comment for why an expired-but-undeleted
// document simply stops being returned here, rather than actually
// disappearing from Firestore/Storage).
// ---------------------------------------------------------------------------

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Every currently-active Story from the caller's own account plus everyone
 * they follow, grouped one entry per author (oldest-story-first within
 * each group — the standard tap-through order), most-recently-updated
 * author group first. The self-group (if the caller has an active Story)
 * is always included regardless of the follow graph, same as Reel
 * ownership checks elsewhere always granting the author their own content.
 */
export async function fetchActiveStoriesForFollowing(viewerUid: string): Promise<StoryGroup[]> {
  if (!firestore) return [];
  const db = firestore;

  const followedUids = await fetchFollowingUids(viewerUid, MAX_FOLLOWED_UIDS_FOR_STORIES);
  // Own Stories are always included — see this function's own doc comment.
  const authorUids = Array.from(new Set([viewerUid, ...followedUids]));

  const nowMillis = Timestamp.now();
  const chunks = chunkArray(authorUids, FOLLOWED_UID_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      getDocs(
        query(
          collection(db, STORIES_COLLECTION),
          where('authorUid', 'in', chunk),
          where('status', '==', 'published'),
          where('expiresAt', '>', nowMillis),
          orderBy('expiresAt', 'asc')
        )
      )
    )
  );

  const storiesByAuthor = new Map<string, Story[]>();
  for (const snapshot of chunkResults) {
    for (const docSnapshot of snapshot.docs) {
      const story = docSnapshot.data() as Story;
      const existing = storiesByAuthor.get(story.authorUid);
      if (existing) existing.push(story);
      else storiesByAuthor.set(story.authorUid, [story]);
    }
  }

  const groups: StoryGroup[] = [];
  for (const [authorUid, stories] of storiesByAuthor) {
    // Oldest first within a group — expiresAt ascending (this function's
    // own query order) already sorts a single author's Stories by
    // createdAt ascending too, since every Story from the same author
    // shares the same STORY_EXPIRY_MS offset from its own publishedAt.
    stories.sort((a, b) => (a.createdAt?.toMillis() ?? 0) - (b.createdAt?.toMillis() ?? 0));
    const first = stories[0];
    groups.push({ authorUid, authorDisplayName: first.authorDisplayName, authorUsername: first.authorUsername, stories });
  }

  // Most-recently-posted author group first — matches every Stories tray
  // convention (freshest content leftmost).
  groups.sort((a, b) => {
    const aLatest = a.stories[a.stories.length - 1]?.createdAt?.toMillis() ?? 0;
    const bLatest = b.stories[b.stories.length - 1]?.createdAt?.toMillis() ?? 0;
    return bLatest - aLatest;
  });
  return groups;
}

/**
 * Every currently-active Story from exactly ONE author, oldest first — the
 * full-screen viewer's own data source (src/app/(app)/story/[uid].tsx).
 * Same read rule as fetchActiveStoriesForFollowing (isCanViewStory in
 * firestore.rules): returns an empty array, not an error, for an author
 * the viewer doesn't follow (and isn't themselves) — Firestore denies that
 * query outright rather than returning zero results, so this treats a
 * permission failure the same as "nothing to show."
 */
export async function fetchActiveStoriesForAuthor(authorUid: string): Promise<Story[]> {
  const cached = activeStoriesCache.getFresh(authorUid);
  if (cached !== undefined) return cached;
  if (!firestore) return [];
  // Narrowed local binding — same reasoning as every other cached fetch
  // this phase (e.g. publicProfile.ts's own `const db = firestore`).
  const db = firestore;
  try {
    // A genuinely empty result (no active Stories right now) IS cached —
    // that's a real, stable fact, not a failure. A thrown error is NOT:
    // it's caught here, outside dedupe()'s own fetchFn, specifically so a
    // transient query failure is never written to the cache as if it were
    // "confirmed no active Stories" for the next 60s.
    const stories = await activeStoriesCache.dedupe(authorUid, async () => {
      const snapshot = await getDocs(
        query(
          collection(db, STORIES_COLLECTION),
          where('authorUid', '==', authorUid),
          where('status', '==', 'published'),
          where('expiresAt', '>', Timestamp.now()),
          orderBy('expiresAt', 'asc')
        )
      );
      return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Story);
    });
    activeStoriesCache.set(authorUid, stories);
    return stories;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Playback URL resolution — same in-memory-cache pattern as
// resolveReelPlaybackUrl in reels.ts.
// ---------------------------------------------------------------------------

const playbackUrlCache = new Map<string, string>();

export async function resolveStoryPlaybackUrl(storagePath: string): Promise<string | null> {
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
// Views — stories/{storyId}/views/{viewerUid}, write-once-per-viewer (an
// update just refreshes viewedAt, never adds a second entry). Only the
// Story's own author can read this subcollection (see firestore.rules) —
// a viewer can never see who ELSE viewed a Story, matching the same
// privacy model real Stories features use.
// ---------------------------------------------------------------------------

export async function markStoryViewed(storyId: string, viewerUid: string): Promise<void> {
  if (!firestore) return;
  try {
    await setDoc(doc(firestore, STORIES_COLLECTION, storyId, 'views', viewerUid), { viewerUid, viewedAt: serverTimestamp() });
  } catch {
    // Best-effort — a missed view mark is a minor cosmetic miss (the
    // author's view count undercounts by one), never a broken viewing
    // experience for the person watching.
  }
}

/**
 * Whether ONE specific viewer has already seen ONE specific Story — the
 * seen/unseen ring color in FollowingAvatarRow (src/app/(app)/(tabs)/inbox.tsx)
 * is built from this, one call per Story currently shown in that row (a
 * small, bounded number — same read-cost shape as everything else in that
 * screen). Defaults to `false` (unseen) on any read failure — the honest
 * "don't know" case renders as if not yet watched, never a wrongly-gray
 * ring hiding new content.
 */
export async function hasViewedStory(storyId: string, viewerUid: string): Promise<boolean> {
  if (!firestore) return false;
  try {
    const snapshot = await getDoc(doc(firestore, STORIES_COLLECTION, storyId, 'views', viewerUid));
    return snapshot.exists();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sound reuse ("Use audio" in src/components/SoundSheet.tsx) — resolves the
// ONE permanent copy of a given sound's actual audio (see
// soundOriginAudioStoragePath in functions/src/index.ts and
// Reel.musicHash's own doc comment in src/types/reel.ts), if one exists.
// `null` (not an error) for a sound with no permanent copy — a legacy Reel
// predating this feature, or a hash lookup that's somehow wrong — the
// caller treats that as "can't reuse this one," never a broken screen.
// ---------------------------------------------------------------------------

export async function resolveSoundAudioUrl(musicHash: string): Promise<string | null> {
  if (!storage || !musicHash) return null;
  try {
    return await getDownloadURL(ref(storage, `soundOrigins/${musicHash}/audio`));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Add to Story" (src/components/SoundSheet.tsx) — reshares an existing
// published Reel as the caller's own new Story. A trusted backend
// callable, not a client operation: the caller never has the Reel's
// video/photo bytes locally to upload themselves (see
// functions/src/index.ts's addReelToMyStory for the full reasoning).
// ---------------------------------------------------------------------------

export type AddReelToMyStoryResult = { ok: true; storyId: string } | { ok: false; message: string };

export async function addReelToMyStory(reelId: string): Promise<AddReelToMyStoryResult> {
  if (!functions) {
    return { ok: false, message: 'This feature is not available right now.' };
  }
  try {
    const result = await httpsCallable(functions, 'addReelToMyStory')({ reelId });
    const data = result.data as { storyId: string };
    return { ok: true, storyId: data.storyId };
  } catch {
    return { ok: false, message: "Couldn't add this post to your Story." };
  }
}
