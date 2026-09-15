/**
 * Recommendation Engine — Step 4 — trusted, server-aggregated engagement
 * statistics. See src/types/engagementStats.ts (the Expo app's own copy
 * of this schema, with the full trust-level documentation) for the shape
 * this file maintains, and firestore.rules' `stats/engagement` blocks for
 * why these documents are safe to trust: `allow create, update, delete:
 * if false` unconditionally for every client — the Admin SDK below is the
 * ONLY writer, and it bypasses Firestore Rules entirely via IAM.
 *
 * STATS DOCUMENT PATHS:
 *   reels/{reelId}/stats/engagement
 *   content/{contentId}/stats/engagement
 * — never a field on the reel/content document itself (Step 2's own "do
 * NOT mutate immutable published reel/content documents just to store
 * counters" instruction; reels/content documents are already
 * field-immutable-after-publish per firestore.rules' own isValidReelPublish/
 * content update rules, and stacking a mutable counter onto an otherwise
 * immutable document would be a much bigger behavioral change than a
 * sibling subcollection document).
 *
 * SOURCES OF TRUTH (Step 6) — every trigger below maps to EXACTLY one
 * underlying Firestore write pattern, chosen for its trust level:
 *   - likes/comments/saves: real document create/delete on the actual
 *     Like/Comment/Saved relationship (HIGH trust — see the per-trigger
 *     doc comments below).
 *   - impressions/videoStarts/meaningfulViews/completions/rewatches/
 *     watch totals/notInterestedCount/shares/event-response counts:
 *     derived from `users/{uid}/recommendationEvents/{eventId}` (MEDIUM,
 *     for watch/share — client-reported; re-validated here regardless —
 *     see validateWatchSample).
 * `like`/`unlike`/`save`/`unsave`/`comment` recommendationEvents are
 * DELIBERATELY IGNORED by the recommendationEvents trigger — those are
 * fully covered by the dedicated like/comment/saved triggers already, and
 * double-counting from two independent trigger sources for the same
 * underlying action would silently inflate every one of those counts.
 *
 * IDEMPOTENCY (Step 7) — Cloud Functions triggers are at-least-once, not
 * exactly-once: the SAME event can be redelivered (a retry after a
 * timeout, a platform-level redelivery, ...). Every trigger below uses
 * withIdempotentStatsUpdate, which — in ONE transaction — checks a marker
 * document keyed by the trigger's own globally-unique CloudEvent id
 * (`event.id`) and only applies the stats mutation the FIRST time that
 * exact id is ever seen, writing the marker in the same transaction so a
 * duplicate delivery can never partially land. The marker collection
 * (`recommendationStatsEvents/{eventId}`) has no Firestore Rules entry at
 * all — matching this codebase's existing precedent for backend-only
 * collections (see functions/src/index.ts's `systemMigrations` usage,
 * which similarly relies on Firestore's own default-deny for a
 * collection with no matching rule) — Firestore denies any client
 * read/write to it by default. NOTE: these marker documents currently
 * have no expiry — see this file's own final report for why that's a
 * documented, deliberate v1 limitation rather than something silently
 * ignored.
 */
import { FieldValue, getFirestore, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { onDocumentCreated, onDocumentDeleted } from 'firebase-functions/v2/firestore';

import { MAX_PLAUSIBLE_WATCH_MS, MEANINGFUL_VIEW_MIN_MS, MEANINGFUL_VIEW_MIN_PERCENT } from './statsConfig';

// Same region as every other Cloud Function in this project (see
// index.ts's own REGION constant/doc comment) — duplicated here rather
// than imported, so this file has zero coupling to index.ts's own module
// state (index.ts re-exports this file's functions, not the other way
// around; see this file's own bottom for the export list index.ts pulls in).
const REGION = 'europe-north1';

function statsPathFor(kind: 'reel' | 'content', id: string): string {
  return kind === 'reel' ? `reels/${id}/stats/engagement` : `content/${id}/stats/engagement`;
}

/** Reads a numeric field off a possibly-partial/legacy stats doc, defaulting to 0 — never NaN, never a stray non-number surviving into a write. */
function currentNumber(current: Record<string, unknown>, field: string): number {
  const value = current[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Step 8/21 — the one counter-delta primitive every trigger below uses. `floorAtZero` (default true) is what makes Step 8's "count must never go below zero" hold for every decrement, regardless of any prior corruption/race — this ALWAYS reads the current value from inside the same transaction as the write, never a stale read. */
export function bumpField(current: Record<string, unknown>, field: string, delta: number, floorAtZero = true): number {
  const next = currentNumber(current, field) + delta;
  return floorAtZero ? Math.max(0, next) : next;
}

/**
 * Step 7 — the shared idempotent-transaction primitive. `computePatch`
 * returns the fields to merge-write, or `null` to mark this event
 * processed WITHOUT writing anything to the stats doc itself (used for a
 * rejected/invalid sample — Step 11 — so a redelivery of a genuinely bad
 * event is never re-evaluated, but also never contributes anything).
 */
export async function withIdempotentStatsUpdate(
  db: Firestore,
  eventId: string,
  statsRef: DocumentReference,
  computePatch: (current: Record<string, unknown>) => Record<string, unknown> | null
): Promise<'applied' | 'duplicate' | 'rejected'> {
  const markerRef = db.doc(`recommendationStatsEvents/${eventId}`);
  return db.runTransaction(async (tx) => {
    const markerSnap = await tx.get(markerRef);
    if (markerSnap.exists) return 'duplicate';

    const statsSnap = await tx.get(statsRef);
    const current = statsSnap.exists ? (statsSnap.data() as Record<string, unknown>) : {};
    const patch = computePatch(current);

    // The marker is written EVERY time this transaction runs for a new
    // eventId, whether or not a real patch resulted — a rejected sample
    // must never be re-evaluated on redelivery either.
    tx.set(markerRef, { processedAt: FieldValue.serverTimestamp(), statsPath: statsRef.path });

    if (!patch) return 'rejected';
    tx.set(statsRef, patch, { merge: true });
    return 'applied';
  });
}

// ---------------------------------------------------------------------------
// Step 8 — Likes. HIGH trust: derived directly from the real
// reels|content/{id}/likes/{uid} relationship document actually existing —
// a client cannot fabricate a like count without that document (governed
// by firestore.rules) actually being created/deleted.
// ---------------------------------------------------------------------------

export const onReelLikeCreated = onDocumentCreated({ region: REGION, document: 'reels/{reelId}/likes/{uid}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('reel', event.params.reelId)), (current) => ({
    likes: bumpField(current, 'likes', 1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

export const onReelLikeDeleted = onDocumentDeleted({ region: REGION, document: 'reels/{reelId}/likes/{uid}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('reel', event.params.reelId)), (current) => ({
    likes: bumpField(current, 'likes', -1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

export const onContentLikeCreated = onDocumentCreated({ region: REGION, document: 'content/{contentId}/likes/{uid}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('content', event.params.contentId)), (current) => ({
    likes: bumpField(current, 'likes', 1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

export const onContentLikeDeleted = onDocumentDeleted({ region: REGION, document: 'content/{contentId}/likes/{uid}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('content', event.params.contentId)), (current) => ({
    likes: bumpField(current, 'likes', -1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

// ---------------------------------------------------------------------------
// Step 9 — Comments. HIGH trust, same reasoning as Likes. Both
// reels/{reelId}/comments/{commentId} and content/{contentId}/comments/
// {commentId} are HARD-deleted by this app's own deleteComment/
// deleteReelComment (src/services/socialEngagement.ts/reelEngagement.ts —
// confirmed by inspection: a real batch.delete(), never a soft-delete
// flag) — so onDocumentDeleted is the correct, complete signal for a
// removed comment; there is no separate "soft-deleted" state to reconcile.
// ---------------------------------------------------------------------------

export const onReelCommentCreated = onDocumentCreated({ region: REGION, document: 'reels/{reelId}/comments/{commentId}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('reel', event.params.reelId)), (current) => ({
    comments: bumpField(current, 'comments', 1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

export const onReelCommentDeleted = onDocumentDeleted({ region: REGION, document: 'reels/{reelId}/comments/{commentId}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('reel', event.params.reelId)), (current) => ({
    comments: bumpField(current, 'comments', -1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

export const onContentCommentCreated = onDocumentCreated({ region: REGION, document: 'content/{contentId}/comments/{commentId}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('content', event.params.contentId)), (current) => ({
    comments: bumpField(current, 'comments', 1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

export const onContentCommentDeleted = onDocumentDeleted({ region: REGION, document: 'content/{contentId}/comments/{commentId}' }, async (event) => {
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor('content', event.params.contentId)), (current) => ({
    comments: bumpField(current, 'comments', -1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

// ---------------------------------------------------------------------------
// Step 10 — Saves. HIGH trust. `users/{uid}/saved/{savedId}` (see
// src/services/saved.ts) is per-USER, not per-target, so this trigger has
// to branch on the document's OWN `targetType`/`targetId` fields rather
// than a path segment — a 'sound' target is skipped entirely (Step 10's
// own "do not count sound saves as content saves" instruction): it isn't
// even given an idempotency marker, since no stats mutation is ever
// attempted for it.
// ---------------------------------------------------------------------------

type SavedDocLike = { targetType?: unknown; targetId?: unknown };

function resolveSaveTarget(data: SavedDocLike): { kind: 'reel' | 'content'; id: string } | null {
  const targetType = data.targetType;
  const targetId = data.targetId;
  if (typeof targetId !== 'string' || targetId.length === 0) return null;
  if (targetType === 'reel') return { kind: 'reel', id: targetId };
  if (targetType === 'post') return { kind: 'content', id: targetId };
  return null; // 'sound' (or anything unrecognized) — never a content/Reel save.
}

export const onSavedCreated = onDocumentCreated({ region: REGION, document: 'users/{uid}/saved/{savedId}' }, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const target = resolveSaveTarget(snapshot.data() as SavedDocLike);
  if (!target) return;
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor(target.kind, target.id)), (current) => ({
    saves: bumpField(current, 'saves', 1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

export const onSavedDeleted = onDocumentDeleted({ region: REGION, document: 'users/{uid}/saved/{savedId}' }, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const target = resolveSaveTarget(snapshot.data() as SavedDocLike);
  if (!target) return;
  const db = getFirestore();
  await withIdempotentStatsUpdate(db, event.id, db.doc(statsPathFor(target.kind, target.id)), (current) => ({
    saves: bumpField(current, 'saves', -1),
    updatedAtMs: Date.now(),
    schemaVersion: 1,
  }));
});

// ---------------------------------------------------------------------------
// Steps 5/11/12/13/19 — recommendationEvents-derived counters. MEDIUM
// trust for watch/share data (client-reported — see this file's own top
// doc comment); every watch sample is independently re-validated here
// regardless of what the client already computed (Step 6's own "do NOT
// pretend client-reported watch/share events are perfectly trustworthy"
// instruction).
// ---------------------------------------------------------------------------

/** Mirrors deriveWatchAction's own summarized-action set (recommendationConfig.ts) — one watch SUMMARY per viewing session, never a separate write per milestone (Step 11's own "do NOT process every milestone as separate watch totals" instruction — this app's client already only ever sends one). */
export const WATCH_SUMMARY_ACTIONS = new Set(['quick_skip', 'open', 'watch_25', 'watch_50', 'watch_75', 'complete', 'rewatch']);

type ValidatedWatchSample = { watchDurationMs: number; watchPercentage: number };

/**
 * Step 11 — independently re-validates a client-reported watch sample.
 * Rejects (returns null) rather than clamps-and-keeps for an impossible
 * DURATION (negative, non-finite, or beyond MAX_PLAUSIBLE_WATCH_MS — the
 * spec's own "multi-hour watch on a 10-second reel" example) since a
 * corrupt/malicious duration can't be partially trusted. A watch
 * PERCENTAGE, by contrast, is always re-clamped to [0,1] rather than
 * rejected outright — the client already clamps this before writing (see
 * trackReelWatchSummary), so an out-of-range value here is far more
 * likely a version skew/edge case than a deliberate fabrication, and the
 * duration-side rejection above is what actually guards against the
 * "impossible watch" scenario the spec is really worried about.
 */
export function validateWatchSample(rawDurationMs: unknown, rawPercentage: unknown): ValidatedWatchSample | null {
  const durationMs = typeof rawDurationMs === 'number' ? rawDurationMs : NaN;
  const percentage = typeof rawPercentage === 'number' ? rawPercentage : NaN;
  if (!Number.isFinite(durationMs) || !Number.isFinite(percentage)) return null;
  if (durationMs < 0 || durationMs > MAX_PLAUSIBLE_WATCH_MS) return null;
  return { watchDurationMs: durationMs, watchPercentage: Math.max(0, Math.min(1, percentage)) };
}

/** Step 5 — a raw impression is too weak on its own to count as real engagement; a (already-validated) watch sample only becomes "meaningful" once it clears EITHER the absolute-duration or the percentage bar (see MEANINGFUL_VIEW_MIN_MS/MEANINGFUL_VIEW_MIN_PERCENT's own doc comment in statsConfig.ts for why "either" rather than "both"). Extracted as its own function purely so it has a direct unit test (see scripts/test-stats-logic.cjs) independent of the full trigger. */
export function isMeaningfulView(sample: ValidatedWatchSample): boolean {
  return sample.watchDurationMs >= MEANINGFUL_VIEW_MIN_MS || sample.watchPercentage >= MEANINGFUL_VIEW_MIN_PERCENT;
}

type RecommendationEventLike = {
  action?: unknown;
  contentType?: unknown;
  contentId?: unknown;
  watchDurationMs?: unknown;
  watchPercentage?: unknown;
};

export const onRecommendationEventCreated = onDocumentCreated(
  { region: REGION, document: 'users/{uid}/recommendationEvents/{eventId}' },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const data = snapshot.data() as RecommendationEventLike;
    const action = data.action;
    const contentType = data.contentType;
    const contentId = data.contentId;
    if (typeof action !== 'string' || typeof contentId !== 'string' || !contentId) return;
    if (contentType !== 'reel' && contentType !== 'content') return;

    const db = getFirestore();
    const statsRef = db.doc(statsPathFor(contentType, contentId));

    // Step 6 — like/unlike/save/unsave/comment are fully covered by the
    // dedicated document triggers above; processing them again here would
    // double-count. Deliberately not marked "processed" at all (no
    // idempotency write) — this path does nothing, so there's nothing to
    // guard against being redelivered.
    if (action === 'like' || action === 'unlike' || action === 'save' || action === 'unsave' || action === 'comment') return;

    if (action === 'impression') {
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => ({
        impressions: bumpField(current, 'impressions', 1),
        updatedAtMs: Date.now(),
        schemaVersion: 1,
      }));
      return;
    }
    if (action === 'video_started') {
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => ({
        videoStarts: bumpField(current, 'videoStarts', 1),
        updatedAtMs: Date.now(),
        schemaVersion: 1,
      }));
      return;
    }
    if (action === 'not_interested') {
      // Step 12 — a strong, dedicated negative signal, never diluted.
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => ({
        notInterestedCount: bumpField(current, 'notInterestedCount', 1),
        updatedAtMs: Date.now(),
        schemaVersion: 1,
      }));
      return;
    }
    if (action === 'share') {
      // Step 13 — this app's shareReel() only confirms the OS share sheet
      // was invoked without throwing (see src/utils/reelShare.ts) — a
      // share-INTENT signal, not verified delivery, on Android/web
      // especially. Counted here as `shares` regardless (the schema's own
      // requested field name), but weighted conservatively in the quality
      // formula (see qualityConfig.ts's QUALITY_RATE_PRIORS.share) rather
      // than introducing a whole separate action/field for this pass.
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => ({
        shares: bumpField(current, 'shares', 1),
        updatedAtMs: Date.now(),
        schemaVersion: 1,
      }));
      return;
    }
    if (action === 'event_open') {
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => ({
        eventOpens: bumpField(current, 'eventOpens', 1),
        updatedAtMs: Date.now(),
        schemaVersion: 1,
      }));
      return;
    }
    if (action === 'event_interested') {
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => ({
        eventInterested: bumpField(current, 'eventInterested', 1),
        updatedAtMs: Date.now(),
        schemaVersion: 1,
      }));
      return;
    }
    if (action === 'event_going') {
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => ({
        eventGoing: bumpField(current, 'eventGoing', 1),
        updatedAtMs: Date.now(),
        schemaVersion: 1,
      }));
      return;
    }

    if (WATCH_SUMMARY_ACTIONS.has(action)) {
      const validated = validateWatchSample(data.watchDurationMs, data.watchPercentage);
      if (!validated) {
        // Step 11 — impossible sample, rejected outright. Still marks
        // this exact event processed (see withIdempotentStatsUpdate's own
        // doc comment) so a redelivery isn't re-evaluated.
        await withIdempotentStatsUpdate(db, event.id, statsRef, () => null);
        return;
      }
      const meaningfulView = isMeaningfulView(validated);
      await withIdempotentStatsUpdate(db, event.id, statsRef, (current) => {
        const patch: Record<string, unknown> = {
          totalWatchMs: bumpField(current, 'totalWatchMs', validated.watchDurationMs, false),
          totalWatchPercent: bumpField(current, 'totalWatchPercent', validated.watchPercentage, false),
          watchSampleCount: bumpField(current, 'watchSampleCount', 1),
          updatedAtMs: Date.now(),
          schemaVersion: 1,
        };
        if (meaningfulView) patch.meaningfulViews = bumpField(current, 'meaningfulViews', 1);
        if (action === 'complete') patch.completions = bumpField(current, 'completions', 1);
        if (action === 'rewatch') patch.rewatches = bumpField(current, 'rewatches', 1);
        return patch;
      });
    }
    // Every other action (profile_open, follow, unfollow, event_save,
    // event_unsave) is a creator/profile-affinity signal, not a
    // per-content engagement stat — correctly ignored here.
  }
);
