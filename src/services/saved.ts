/**
 * Private Saved Posts — users/{uid}/saved/{savedId} (Step 41.2E). A
 * bookmark referencing another account's Post — never a snapshot, never
 * readable by anyone but its own owner (see firestore.rules). Supports
 * exactly the two existing user-facing Post representations: video Posts
 * (reels/{reelId}) and legacy text Posts (content/{contentId},
 * type=='post'). UI code should only ever import from here, never talk to
 * Firestore directly for Saved relationships.
 */

import { collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, where, type WithFieldValue } from 'firebase/firestore';

import { fetchContentById } from '@/services/content';
import { fetchReel, fetchReelsByMusicHash } from '@/services/reels';
import type { PostContent } from '@/types/content';
import type { Reel } from '@/types/reel';
import type { SavedPost, SavedTargetType } from '@/types/saved';

import { firestore } from './firestore';
import { trackContentInteraction } from './recommendations/interactions';

const SAVED_SUBCOLLECTION = 'saved';
const DEFAULT_SAVED_LIMIT = 40;

function savedId(targetType: SavedTargetType, targetId: string): string {
  return `${targetType}_${targetId}`;
}

function savedRef(uid: string, targetType: SavedTargetType, targetId: string) {
  return doc(firestore!, 'users', uid, SAVED_SUBCOLLECTION, savedId(targetType, targetId));
}

/**
 * Fire-and-forget — a recommendation-signal write never blocks or fails
 * the real save/unsave action. A saved 'sound' isn't a Post the
 * recommendation engine ranks (see SavedTargetType's own doc comment in
 * src/types/saved.ts), so this only tracks 'reel'/'post' targets — and
 * resolves the target document ITSELF here (savePost/unsavePost otherwise
 * never read it) purely for the categoryId/creatorId/cityKey a save
 * signal needs to be meaningful.
 */
async function trackSaveSignal(uid: string, targetType: SavedTargetType, targetId: string, action: 'save' | 'unsave'): Promise<void> {
  if (targetType === 'sound') return;
  try {
    if (targetType === 'reel') {
      const reel = await fetchReel(targetId);
      if (!reel) return;
      await trackContentInteraction({
        userId: uid,
        contentId: reel.reelId,
        contentType: 'reel',
        action,
        categoryId: reel.categoryId,
        creatorId: reel.authorUid,
        cityKey: reel.cityKey,
        countryCode: reel.countryCode,
      });
    } else {
      const content = await fetchContentById(targetId);
      if (!content) return;
      await trackContentInteraction({
        userId: uid,
        contentId: content.contentId,
        contentType: 'content',
        action,
        categoryId: content.categoryId,
        creatorId: content.authorUid,
        cityKey: content.cityKey,
        countryCode: content.countryCode,
      });
    }
  } catch {
    // Best-effort only — see this function's own doc comment.
  }
}

export type SaveActionError = 'not-configured' | 'unknown';
export type SaveActionResult = { ok: true } | { ok: false; error: SaveActionError; message: string };

/** Idempotent — saving an already-saved Post is a no-op success, never a duplicate. */
export async function savePost(uid: string, targetType: SavedTargetType, targetId: string): Promise<SaveActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await setDoc(savedRef(uid, targetType, targetId), {
      targetType,
      targetId,
      savedAt: serverTimestamp(),
    } satisfies WithFieldValue<SavedPost>);
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't save this post." };
  }
  trackSaveSignal(uid, targetType, targetId, 'save').catch(() => {});
  return { ok: true };
}

/** Idempotent — removing an already-absent Saved relationship is a no-op success. */
export async function unsavePost(uid: string, targetType: SavedTargetType, targetId: string): Promise<SaveActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await deleteDoc(savedRef(uid, targetType, targetId));
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't remove this from your saved posts." };
  }
  trackSaveSignal(uid, targetType, targetId, 'unsave').catch(() => {});
  return { ok: true };
}

export async function isPostSaved(uid: string, targetType: SavedTargetType, targetId: string): Promise<boolean> {
  if (!firestore) return false;
  const snapshot = await getDoc(savedRef(uid, targetType, targetId));
  return snapshot.exists();
}

/**
 * One entry in the Saved tab — mirrors src/utils/profilePosts.ts's
 * ProfilePostItem shape closely enough to reuse the exact same
 * ReelPreviewCard/ContentCard rendering, but is NOT built via
 * mergeProfilePosts: Saved orders by when the item was saved
 * (`savedAt`), never by the original Post's own creation/publish time.
 */
export type SavedPostItem =
  | { kind: 'reel'; savedId: string; reel: Reel }
  | { kind: 'text'; savedId: string; content: PostContent }
  /**
   * A saved SOUND (see SavedTargetType's own doc comment in
   * src/types/saved.ts) — `originReel` is the real, currently-published
   * origin Reel for that exact sound, always resolved fresh here (never
   * the stale reel that happened to be playing when it was saved), used
   * purely as a display surrogate (its author's avatar/name, its own
   * thumbnail) since there is no separate "sound" document to show.
   * `postCount` is how many currently-published Reels share this exact
   * sound right now.
   */
  | { kind: 'sound'; savedId: string; musicHash: string; originReel: Reel; postCount: number };

/**
 * A bounded page of the caller's own Saved Posts, newest-saved-first, with
 * each relationship resolved against its real current original document.
 * A Saved reference whose original was deleted (self-deleted, moderated,
 * or removed via account deletion) is silently skipped — never rendered as
 * a broken card, and never cleaned up here (see this step's README for why
 * that cleanup is explicitly deferred). Resolution happens in parallel,
 * but the RESULT preserves the original savedAt-desc query order, not
 * resolve-completion order.
 */
export async function fetchSavedPosts(uid: string, limitCount = DEFAULT_SAVED_LIMIT): Promise<SavedPostItem[]> {
  if (!firestore) return [];

  const savedQuery = query(collection(firestore, 'users', uid, SAVED_SUBCOLLECTION), orderBy('savedAt', 'desc'), limit(limitCount));
  const snapshot = await getDocs(savedQuery);

  const savedDocs = snapshot.docs.map((docSnapshot) => ({ id: docSnapshot.id, data: docSnapshot.data() as SavedPost }));

  const resolved = await Promise.all(
    savedDocs.map(async ({ id, data }) => {
      if (data.targetType === 'reel') {
        const reel = await fetchReel(data.targetId);
        if (!reel || reel.status !== 'published') return null;
        return { kind: 'reel' as const, savedId: id, reel };
      }
      if (data.targetType === 'sound') {
        // targetId is a musicHash here, not a reelId — see
        // SavedTargetType's own doc comment in src/types/saved.ts.
        const soundReels = await fetchReelsByMusicHash(data.targetId);
        const originReel = soundReels[0];
        if (!originReel) return null;
        return { kind: 'sound' as const, savedId: id, musicHash: data.targetId, originReel, postCount: soundReels.length };
      }
      const content = await fetchContentById(data.targetId);
      if (!content || content.type !== 'post' || content.status !== 'published') return null;
      return { kind: 'text' as const, savedId: id, content };
    })
  );

  return resolved.filter((item): item is SavedPostItem => item !== null);
}

/**
 * One saved SOUND, scoped to exactly that (no unrelated saved Reels/Posts
 * ever fetched) — the "Favorites" tab of the music picker
 * (src/app/(app)/create/reel/music.tsx), which only ever needs sounds,
 * never a full mixed Saved list. Same resolution/skip-if-gone reasoning
 * as fetchSavedPosts' own 'sound' branch.
 */
export type SavedSound = { savedId: string; musicHash: string; originReel: Reel };

export async function fetchSavedSounds(uid: string, limitCount = DEFAULT_SAVED_LIMIT): Promise<SavedSound[]> {
  if (!firestore) return [];

  const savedQuery = query(
    collection(firestore, 'users', uid, SAVED_SUBCOLLECTION),
    where('targetType', '==', 'sound'),
    orderBy('savedAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(savedQuery);
  const savedDocs = snapshot.docs.map((docSnapshot) => ({ id: docSnapshot.id, data: docSnapshot.data() as SavedPost }));

  const resolved = await Promise.all(
    savedDocs.map(async ({ id, data }) => {
      const soundReels = await fetchReelsByMusicHash(data.targetId);
      const originReel = soundReels[0];
      if (!originReel) return null;
      return { savedId: id, musicHash: data.targetId, originReel };
    })
  );

  return resolved.filter((item): item is SavedSound => item !== null);
}
