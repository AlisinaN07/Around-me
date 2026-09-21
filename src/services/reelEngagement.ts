/**
 * Reel Likes and Comments — reels/{reelId}/likes/{uid} and
 * reels/{reelId}/comments/{commentId}. Structurally parallel to
 * src/services/socialEngagement.ts's content Likes/Comments, but kept as a
 * dedicated module since Reels are a separate root collection from
 * content/{contentId} (see src/types/reel.ts). UI code should only ever
 * import from here, never talk to Firestore directly for Reel engagement.
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
  where,
  writeBatch,
  type WithFieldValue,
} from 'firebase/firestore';

import type { Notification } from '@/types/notification';
import { NOTIFICATION_PREVIEW_MAX_LENGTH } from '@/types/notification';
import type { PostLike } from '@/types/postLikes';
import type { Reel, ReelComment, ReelCommentReaction, ReelCommentReactionType, ReelLike } from '@/types/reel';
import { REEL_COMMENT_BODY_MAX_LENGTH } from '@/types/reel';
import { TtlCache } from '@/utils/requestCache';

import { resolveTrustedFields, type EngagementError, type EngagementResult } from './engagement';
import { firestore } from './firestore';
import { buildNotificationId, notificationRef } from './notifications';
import { postLikeRef } from './postLikes';
import { trackContentInteraction } from './recommendations/interactions';
import { normalizeReel, reelRef } from './reels';

/** Fire-and-forget — a recommendation-signal write never blocks or fails the real like/comment action it's attached to (see trackContentInteraction's own doc comment). */
function trackReelSignal(uid: string, reel: Reel, action: 'like' | 'unlike' | 'comment'): void {
  trackContentInteraction({
    userId: uid,
    contentId: reel.reelId,
    contentType: 'reel',
    action,
    categoryId: reel.categoryId,
    creatorId: reel.authorUid,
    cityKey: reel.cityKey,
    countryCode: reel.countryCode,
    hashtags: reel.hashtags,
  }).catch(() => {});
}

const REELS_COLLECTION = 'reels';
const DEFAULT_REEL_COMMENT_LIMIT = 30;
// Bounds the one-shot cleanup queries deleteReelComment runs before
// removing a comment (see its own doc comment) — real caps, not an
// unbounded scan, matching this codebase's "never unbounded" rule
// everywhere else. Kept well under Firestore's own 500-write batch limit
// even added together with the comment/notification deletes themselves.
// Reaction/reply counts on one comment are expected to stay far below
// these at this app's current scale; if one somehow exceeds a cap, the
// excess docs are left as harmless orphans under the now-deleted comment
// (inaccessible once the comment is gone, same accepted-limitation shape
// as the thumbnail/music Storage orphans documented in README.md's Post-v1
// technical debt) rather than blocking the delete itself.
const MAX_REACTIONS_DELETED_WITH_COMMENT = 200;
const MAX_REPLIES_DELETED_WITH_COMMENT = 200;

// Perf pass — same TtlCache building block as following.ts/saved.ts/
// publicProfile.ts/stories.ts (see requestCache.ts's own doc comment).
// Fixes the audit's own "ReelFeedItem remount re-fetches fresh every
// time" finding for the three engagement reads it makes per mount:
// isReelLiked, fetchReelLikeCount, fetchReelCommentCount.
//
// Two different TTLs, matching the two different kinds of staleness risk:
//   - reelLikedCache mirrors FOLLOW_CACHE_TTL_MS/SAVED_CACHE_TTL_MS
//     (45s) exactly — it's the same shape of state (a private, per-
//     viewer boolean this viewer's own action fully controls).
//   - the two count caches use a shorter TTL: unlike a follow/save flag,
//     a like/comment COUNT can also change because of a DIFFERENT
//     user's action, which this cache has no way to observe — a shorter
//     TTL keeps that drift small without giving up the "scroll away and
//     back within a few seconds" win the audit was actually about.
const REEL_LIKED_CACHE_TTL_MS = 45_000;
const REEL_COUNT_CACHE_TTL_MS = 20_000;

const reelLikedCache = new TtlCache<boolean>(REEL_LIKED_CACHE_TTL_MS);
const reelLikeCountCache = new TtlCache<number>(REEL_COUNT_CACHE_TTL_MS);
const reelCommentCountCache = new TtlCache<number>(REEL_COUNT_CACHE_TTL_MS);

// Same "pair, not just target" reasoning as followCacheKey in
// following.ts — whether uid liked THIS reel is a (reel, viewer) pair,
// never shared across different signed-in accounts sharing one session.
function reelLikedCacheKey(reelId: string, uid: string): string {
  return `${reelId}:${uid}`;
}

/**
 * Bumps a cached count by a known, exact delta (+1 like, -1 unlike, +1
 * comment, -(1 + replies) comment-thread delete) instead of forcing a
 * fresh getCountFromServer read after every mutation. Only touches the
 * cache when a fresh entry already exists — if this count was never
 * cached (or its TTL already lapsed), there's nothing to bump: the next
 * real fetchReelLikeCount/fetchReelCommentCount call will read the true
 * server value directly, which is correct on its own and cheaper than an
 * extra read here just to warm a cache nobody has asked for yet. Never
 * lets a count go negative.
 */
function bumpCachedCount(cache: TtlCache<number>, key: string, delta: number): void {
  const current = cache.getFresh(key);
  if (current === undefined) return;
  cache.set(key, Math.max(0, current + delta));
}

function reelLikeRef(reelId: string, uid: string) {
  return doc(firestore!, REELS_COLLECTION, reelId, 'likes', uid);
}
function reelCommentsCollectionRef(reelId: string) {
  return collection(firestore!, REELS_COLLECTION, reelId, 'comments');
}
function reelCommentRef(reelId: string, commentId: string) {
  return doc(firestore!, REELS_COLLECTION, reelId, 'comments', commentId);
}
function reelCommentReactionsCollectionRef(reelId: string, commentId: string) {
  return collection(firestore!, REELS_COLLECTION, reelId, 'comments', commentId, 'reactions');
}
function reelCommentReactionRef(reelId: string, commentId: string, uid: string) {
  return doc(firestore!, REELS_COLLECTION, reelId, 'comments', commentId, 'reactions', uid);
}

type AssertPublishedReelResult = { ok: true; reel: Reel } | { ok: false; error: EngagementError; message: string };

async function assertPublishedReel(reelId: string): Promise<AssertPublishedReelResult> {
  const snapshot = await getDoc(reelRef(reelId));
  if (!snapshot.exists() || snapshot.data().status !== 'published') {
    return { ok: false, error: 'not-found', message: "Couldn't find that post." };
  }
  return { ok: true, reel: normalizeReel(snapshot.data() as Reel) };
}

// ---------------------------------------------------------------------------
// Likes
// ---------------------------------------------------------------------------

export type LikeReelResult = EngagementResult<{ alreadyLiked: boolean }>;

export async function likeReel(reelId: string, uid: string): Promise<LikeReelResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  const parent = await assertPublishedReel(reelId);
  if (!parent.ok) return { ...parent, message: "Couldn't like this post." };

  const existing = await getDoc(reelLikeRef(reelId, uid));
  if (existing.exists()) {
    // Already liked — the redundant call still confirms the real, current
    // state, so this is a fine place to (re)populate the cache too rather
    // than leave it to the next isReelLiked() call (same reasoning as
    // followUser's own "already following" early-return).
    reelLikedCache.set(reelLikedCacheKey(reelId, uid), true);
    return { ok: true, alreadyLiked: true };
  }

  try {
    // Like + notification + postLikes relationship land atomically — see
    // firestore.rules, which requires the like doc to exist (existsAfter)
    // for both the notification AND the postLikes create to be valid.
    // Never notify yourself for your own like, and never create a
    // postLikes relationship for a self-like either (Step 41.2H.1 — a
    // self-Like still behaves exactly as before, it just never
    // contributes to the author's future "Liked" total).
    const batch = writeBatch(firestore);
    batch.set(reelLikeRef(reelId, uid), {
      uid,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<ReelLike>);

    if (parent.reel.authorUid !== uid) {
      const notificationId = buildNotificationId('reel_like', { reelId, actorUid: uid });
      batch.set(notificationRef(notificationId), {
        notificationId,
        recipientUid: parent.reel.authorUid,
        actorUid: uid,
        actorDisplayName: trusted.fields.displayName,
        actorUsername: trusted.fields.username,
        type: 'reel_like',
        contentId: null,
        reelId,
        commentId: null,
        previewText: null,
        responseStatus: null,
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<Notification>);

      batch.set(postLikeRef(uid, 'reel', reelId), {
        likerUid: uid,
        targetAuthorUid: parent.reel.authorUid,
        targetType: 'reel',
        targetId: reelId,
        createdAt: serverTimestamp(),
      } satisfies WithFieldValue<PostLike>);
    }

    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't like this post." };
  }

  // The write above just succeeded, so the new state is already known
  // with certainty — update, not just invalidate, the same "write the
  // known new value directly" pattern followUser/unfollowUser already
  // use, so the very next isReelLiked()/fetchReelLikeCount() call (e.g.
  // this same item re-rendering right after this resolves) reflects it
  // immediately, with no extra Firestore read and no stale window.
  reelLikedCache.set(reelLikedCacheKey(reelId, uid), true);
  bumpCachedCount(reelLikeCountCache, reelId, 1);
  trackReelSignal(uid, parent.reel, 'like');
  return { ok: true, alreadyLiked: false };
}

export async function unlikeReel(reelId: string, uid: string): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    // Removing the like, its notification (if any — self-likes never had
    // one), and its postLikes relationship (Step 41.2H.1 — same caveat:
    // self-likes never had one either) all land in the same batch, so
    // neither can ever outlive the like it was for. Allowed even if the
    // two users became blocked after the like was created — unliking must
    // never trap a stale like. The postLikes delete is unconditional and
    // safe even when no such row ever existed (self-like, or a Like
    // created before this Rules change) — firestore.rules explicitly
    // allows deleting an already-absent postLikes doc as a no-op.
    const reelSnapshot = await getDoc(reelRef(reelId));
    const batch = writeBatch(firestore);
    batch.delete(reelLikeRef(reelId, uid));
    batch.delete(postLikeRef(uid, 'reel', reelId));
    if (reelSnapshot.exists() && reelSnapshot.data().authorUid !== uid) {
      batch.delete(notificationRef(buildNotificationId('reel_like', { reelId, actorUid: uid })));
    }
    await batch.commit();
    if (reelSnapshot.exists()) {
      trackReelSignal(uid, normalizeReel(reelSnapshot.data() as Reel), 'unlike');
    }
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't remove your like." };
  }
  // Same "update with the now-known value" reasoning as likeReel above.
  reelLikedCache.set(reelLikedCacheKey(reelId, uid), false);
  bumpCachedCount(reelLikeCountCache, reelId, -1);
  return { ok: true };
}

export async function isReelLiked(reelId: string, uid: string): Promise<boolean> {
  const key = reelLikedCacheKey(reelId, uid);
  const cached = reelLikedCache.getFresh(key);
  if (cached !== undefined) return cached;
  if (!firestore) return false;
  const result = await reelLikedCache.dedupe(key, async () => {
    const snapshot = await getDoc(reelLikeRef(reelId, uid));
    return snapshot.exists();
  });
  reelLikedCache.set(key, result);
  return result;
}

/** Server-side aggregation count — never fetches every like document just to count them. */
export async function fetchReelLikeCount(reelId: string): Promise<number> {
  const cached = reelLikeCountCache.getFresh(reelId);
  if (cached !== undefined) return cached;
  if (!firestore) return 0;
  const result = await reelLikeCountCache.dedupe(reelId, async () => {
    const snapshot = await getCountFromServer(collection(firestore!, REELS_COLLECTION, reelId, 'likes'));
    return snapshot.data().count;
  });
  reelLikeCountCache.set(reelId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export type AddReelCommentResult = EngagementResult<{ comment: ReelComment }>;

/** `parentCommentId` — omit or pass `null` for an ordinary top-level comment; pass the comment being replied to for a reply. See ReelComment's own doc comment for the one-level-only cap this enforces (mirrored in firestore.rules). */
export async function addReelComment(
  reelId: string,
  uid: string,
  body: string,
  parentCommentId: string | null = null
): Promise<AddReelCommentResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trimmed = body.trim();
  if (!trimmed || trimmed.length > REEL_COMMENT_BODY_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: `Comment must be 1–${REEL_COMMENT_BODY_MAX_LENGTH} characters.` };
  }

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  const parent = await assertPublishedReel(reelId);
  if (!parent.ok) return { ...parent, message: "Couldn't post your comment." };

  const ref = doc(reelCommentsCollectionRef(reelId));
  const data = {
    commentId: ref.id,
    authorUid: uid,
    authorDisplayName: trusted.fields.displayName,
    authorUsername: trusted.fields.username,
    body: trimmed,
    parentCommentId,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  } satisfies WithFieldValue<ReelComment>;

  try {
    // Comment + notification land atomically — see firestore.rules, which
    // requires the comment doc to exist (existsAfter) for the notification
    // create to be valid. Never notify yourself for your own comment.
    const batch = writeBatch(firestore);
    batch.set(ref, data);

    if (parent.reel.authorUid !== uid) {
      const notificationId = buildNotificationId('reel_comment', { commentId: ref.id });
      const previewText = trimmed.length > NOTIFICATION_PREVIEW_MAX_LENGTH ? `${trimmed.slice(0, NOTIFICATION_PREVIEW_MAX_LENGTH)}…` : trimmed;
      batch.set(notificationRef(notificationId), {
        notificationId,
        recipientUid: parent.reel.authorUid,
        actorUid: uid,
        actorDisplayName: trusted.fields.displayName,
        actorUsername: trusted.fields.username,
        type: 'reel_comment',
        contentId: null,
        reelId,
        commentId: ref.id,
        previewText,
        responseStatus: null,
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<Notification>);
    }

    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't post your comment." };
  }

  const created = await getDoc(ref);
  if (!created.exists()) {
    return { ok: false, error: 'unknown', message: 'Comment was posted but could not be read back.' };
  }
  // Exactly one comment document was just added — see bumpCachedCount's
  // own doc comment for why this is a bump, not a forced re-read.
  bumpCachedCount(reelCommentCountCache, reelId, 1);
  trackReelSignal(uid, parent.reel, 'comment');
  return { ok: true, comment: created.data() as ReelComment };
}

export async function deleteReelComment(
  reelId: string,
  commentId: string,
  uid: string
): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    // Removing the comment, its notification (if any — self-comments
    // never had one), its own reactions, and — if this is a top-level
    // comment — its direct replies (plus each reply's own notification,
    // by the same self-comment rule) all land in the same batch, so
    // nothing here can ever outlive the comment it belonged to. Replies'
    // OWN reactions are deliberately not cascaded into (see
    // MAX_REACTIONS_DELETED_WITH_COMMENT/MAX_REPLIES_DELETED_WITH_COMMENT's
    // own doc comment on why that's an accepted limit, not a bug). Allowed
    // even if the two users became blocked after the comment was created.
    const [reelSnapshot, reactionsSnapshot, repliesSnapshot] = await Promise.all([
      getDoc(reelRef(reelId)),
      getDocs(query(reelCommentReactionsCollectionRef(reelId, commentId), limit(MAX_REACTIONS_DELETED_WITH_COMMENT))),
      getDocs(query(reelCommentsCollectionRef(reelId), where('parentCommentId', '==', commentId), limit(MAX_REPLIES_DELETED_WITH_COMMENT))),
    ]);
    const reelAuthorUid = reelSnapshot.exists() ? reelSnapshot.data().authorUid : null;

    const batch = writeBatch(firestore);
    batch.delete(reelCommentRef(reelId, commentId));
    if (reelAuthorUid && reelAuthorUid !== uid) {
      batch.delete(notificationRef(buildNotificationId('reel_comment', { commentId })));
    }
    for (const reactionDoc of reactionsSnapshot.docs) {
      batch.delete(reactionDoc.ref);
    }
    for (const replyDoc of repliesSnapshot.docs) {
      batch.delete(replyDoc.ref);
      const reply = replyDoc.data() as ReelComment;
      if (reelAuthorUid && reelAuthorUid !== reply.authorUid) {
        batch.delete(notificationRef(buildNotificationId('reel_comment', { commentId: reply.commentId })));
      }
    }
    await batch.commit();
    // The comment itself PLUS every direct reply deleted alongside it —
    // see bumpCachedCount's own doc comment for why this is a bump, not
    // a forced re-read. Reaction deletes don't count here: reactions were
    // never part of this cache.
    bumpCachedCount(reelCommentCountCache, reelId, -(1 + repliesSnapshot.docs.length));
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't delete your comment." };
  }
  return { ok: true };
}

export type FetchReelCommentsOptions = {
  limitCount?: number;
  // No cursor param yet — fetchReelComments is a one-shot newest-30 read,
  // same as fetchComments in socialEngagement.ts.
};

/** Newest-first, explicitly limited — never an unbounded fetch. */
export async function fetchReelComments(reelId: string, options: FetchReelCommentsOptions = {}): Promise<ReelComment[]> {
  if (!firestore) return [];
  const commentsQuery = query(reelCommentsCollectionRef(reelId), orderBy('createdAt', 'desc'), limit(options.limitCount ?? DEFAULT_REEL_COMMENT_LIMIT));
  const snapshot = await getDocs(commentsQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as ReelComment);
}

/** One exact comment by ID — used by src/services/reports.ts to validate a Reel-comment report against the real comment before submitting it. */
export async function fetchReelComment(reelId: string, commentId: string): Promise<ReelComment | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(reelCommentRef(reelId, commentId));
  return snapshot.exists() ? (snapshot.data() as ReelComment) : null;
}

/** Server-side aggregation count — never fetches every comment just to count them. */
export async function fetchReelCommentCount(reelId: string): Promise<number> {
  const cached = reelCommentCountCache.getFresh(reelId);
  if (cached !== undefined) return cached;
  if (!firestore) return 0;
  const result = await reelCommentCountCache.dedupe(reelId, async () => {
    const snapshot = await getCountFromServer(reelCommentsCollectionRef(reelId));
    return snapshot.data().count;
  });
  reelCommentCountCache.set(reelId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Comment reactions (Like / Dislike) — reels/{reelId}/comments/{commentId}/
// reactions/{uid}. See ReelCommentReaction's own doc comment in
// src/types/reel.ts: exclusive per user (never both at once on the same
// comment), and deliberately separate from postLikes/the lifetime Liked
// stat — this is a lightweight, purely-informational reaction count, not
// social-Post engagement.
// ---------------------------------------------------------------------------

export type ReelCommentReactionCounts = { likeCount: number; dislikeCount: number };

/** Two independent server-side aggregations — never fetches every reaction just to count them. */
export async function fetchReelCommentReactionCounts(reelId: string, commentId: string): Promise<ReelCommentReactionCounts> {
  if (!firestore) return { likeCount: 0, dislikeCount: 0 };
  const reactionsRef = reelCommentReactionsCollectionRef(reelId, commentId);
  const [likeSnapshot, dislikeSnapshot] = await Promise.all([
    getCountFromServer(query(reactionsRef, where('type', '==', 'like'))),
    getCountFromServer(query(reactionsRef, where('type', '==', 'dislike'))),
  ]);
  return { likeCount: likeSnapshot.data().count, dislikeCount: dislikeSnapshot.data().count };
}

/** `null` when the viewer hasn't reacted to this comment at all. */
export async function fetchMyReelCommentReaction(reelId: string, commentId: string, uid: string): Promise<ReelCommentReactionType | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(reelCommentReactionRef(reelId, commentId, uid));
  if (!snapshot.exists()) return null;
  return (snapshot.data() as ReelCommentReaction).type;
}

/**
 * Sets (or switches) the caller's reaction on one comment. A plain
 * `setDoc` overwrite works for both a first-time reaction and switching
 * Like <-> Dislike — see firestore.rules' matching `allow create, update`
 * pair on this same path for why both cases need identical validation.
 * The caller is responsible for calling removeReelCommentReaction instead
 * when the tapped icon is already the viewer's current reaction (the
 * "tap again to undo" toggle) — this function always sets, never toggles
 * on its own, mirroring likeReel/unlikeReel's own split above.
 */
export async function setReelCommentReaction(
  reelId: string,
  commentId: string,
  uid: string,
  type: ReelCommentReactionType
): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await setDoc(reelCommentReactionRef(reelId, commentId, uid), {
      uid,
      type,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<ReelCommentReaction>);
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't react to this comment." };
  }
  return { ok: true };
}

export async function removeReelCommentReaction(
  reelId: string,
  commentId: string,
  uid: string
): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await deleteDoc(reelCommentReactionRef(reelId, commentId, uid));
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't remove your reaction." };
  }
  return { ok: true };
}
