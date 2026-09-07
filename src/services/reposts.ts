/**
 * Public Reposts — reposts/{repostId} (Step 41.2F). A user publicly
 * republishing another account's Post (video or legacy text) onto their
 * own Profile's Reposts tab. Unlike Saved (private, users/{uid}/saved —
 * Step 41.2E), Reposts live in a public ROOT collection, since a public
 * Profile must be able to query "everything this uid has reposted"
 * without touching anyone's private users/{uid} subtree. UI code should
 * only ever import from here, never talk to Firestore directly for Repost
 * relationships.
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  where,
  type WithFieldValue,
} from 'firebase/firestore';

import { fetchContentById } from '@/services/content';
import { fetchReel } from '@/services/reels';
import type { PostContent } from '@/types/content';
import type { Reel } from '@/types/reel';
import type { Repost, RepostTargetType } from '@/types/reposts';

import { firestore } from './firestore';

const REPOSTS_COLLECTION = 'reposts';
const DEFAULT_REPOST_LIMIT = 40;

function repostId(userUid: string, targetType: RepostTargetType, targetId: string): string {
  return `${userUid}_${targetType}_${targetId}`;
}

function repostRef(userUid: string, targetType: RepostTargetType, targetId: string) {
  return doc(firestore!, REPOSTS_COLLECTION, repostId(userUid, targetType, targetId));
}

export type RepostActionError = 'not-configured' | 'unknown';
export type RepostActionResult = { ok: true } | { ok: false; error: RepostActionError; message: string };

/** Idempotent — reposting an already-reposted Post is a no-op success, never a duplicate. */
export async function repostPost(
  userUid: string,
  targetType: RepostTargetType,
  targetId: string,
  targetAuthorUid: string
): Promise<RepostActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await setDoc(repostRef(userUid, targetType, targetId), {
      userUid,
      targetType,
      targetId,
      targetAuthorUid,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<Repost>);
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't repost this post." };
  }
  return { ok: true };
}

/** Idempotent — undoing an already-absent Repost relationship is a no-op success. */
export async function undoRepost(userUid: string, targetType: RepostTargetType, targetId: string): Promise<RepostActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await deleteDoc(repostRef(userUid, targetType, targetId));
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't undo this repost." };
  }
  return { ok: true };
}

export async function isPostReposted(userUid: string, targetType: RepostTargetType, targetId: string): Promise<boolean> {
  if (!firestore) return false;
  const snapshot = await getDoc(repostRef(userUid, targetType, targetId));
  return snapshot.exists();
}

/**
 * One entry in a Reposts tab — mirrors src/services/saved.ts's
 * SavedPostItem shape closely enough to reuse the exact same
 * ReelPreviewCard/ContentCard rendering, but resolved for ANY profile uid
 * (Reposts are public), not just the caller's own.
 */
export type RepostedPostItem =
  | { kind: 'reel'; repostId: string; reel: Reel }
  | { kind: 'text'; repostId: string; content: PostContent };

/**
 * A bounded page of one profile's public Reposts, newest-reposted-first,
 * each relationship resolved against its real current original document.
 * A Repost whose original was deleted or moderated is silently skipped —
 * never rendered as a broken card, and never cleaned up here (see this
 * step's README for the actual cleanup that does happen, in the trusted
 * backend). Resolution happens in parallel, but the RESULT preserves the
 * original createdAt-desc query order, not resolve-completion order.
 */
export async function fetchProfileReposts(profileUid: string, limitCount = DEFAULT_REPOST_LIMIT): Promise<RepostedPostItem[]> {
  if (!firestore) return [];

  const repostsQuery = query(
    collection(firestore, REPOSTS_COLLECTION),
    where('userUid', '==', profileUid),
    orderBy('createdAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(repostsQuery);

  const repostDocs = snapshot.docs.map((docSnapshot) => ({ id: docSnapshot.id, data: docSnapshot.data() as Repost }));

  const resolved = await Promise.all(
    repostDocs.map(async ({ id, data }) => {
      if (data.targetType === 'reel') {
        const reel = await fetchReel(data.targetId);
        if (!reel || reel.status !== 'published') return null;
        return { kind: 'reel' as const, repostId: id, reel };
      }
      const content = await fetchContentById(data.targetId);
      if (!content || content.type !== 'post' || content.status !== 'published') return null;
      return { kind: 'text' as const, repostId: id, content };
    })
  );

  return resolved.filter((item): item is RepostedPostItem => item !== null);
}
