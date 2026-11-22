/**
 * Trending Hashtags by City and Time Window — trusted, server-aggregated
 * city-level hashtag activity. See src/types/hashtagTrend.ts (the Expo
 * app's own copy of this schema) for the shape this file maintains, and
 * firestore.rules' `cityHashtagTrends/{docId}` block for why these
 * documents are safe to trust: `allow create, update, delete: if false`
 * unconditionally for every client — the Admin SDK below is the ONLY
 * writer, bypassing Firestore Rules entirely via IAM. Same architecture
 * and idempotency shape as engagementStats.ts (own file for the same
 * "this file was already large" reason).
 *
 * DATA MODEL — one document per (cityId, hashtag) pair:
 *   cityHashtagTrends/{cityId}__{hashtag}
 *     { cityId, hashtag, recentPosts: {reelId,atMs,creatorUid}[],
 *       recentEngagement: {atMs,weight}[], lastActivityAt, updatedAt }
 * Both arrays are BOUNDED (capped, newest-first, oldest trimmed) — never
 * one document per event, never an unbounded history. Deliberately NO
 * stored `trendScore`/`posts24h`/etc: those are always DERIVED at READ
 * time from the raw capped arrays (see src/services/hashtagTrends/ on the
 * client) — a window count computed from a live "now" is never stale the
 * way a periodically-recomputed stored score would be between writes,
 * and this needs no scheduled rotation/decay job to stay honest as time
 * passes (an old timestamp simply stops counting toward "recent" once
 * enough real time elapses — no active maintenance required). This also
 * means Firestore Rules never need to validate a trend SCORE at all
 * (Step 30's own "trend score is internal" — it isn't even a field here).
 *
 * SIGNALS (cost-aware subset — see this feature's own final report for
 * the full inspection):
 *   - Reel PUBLISH (onReelPublishedForTrends) — a genuine draft-or-other
 *     -> 'published' transition only, never a draft/failed-upload.
 *   - Reel DELETE (onReelDeletedForTrends) — removes that Reel's own
 *     entry from `recentPosts` where practical (already trimmed out by
 *     the cap is a no-op, not an error — "where practical", per spec).
 *   - Reel engagement CHANGES (onReelEngagementWrittenForTrends) —
 *     triggered on the SAME `reels/{reelId}/stats/engagement` document
 *     engagementStats.ts already trusted-aggregates likes/comments/saves/
 *     shares/completions/rewatches into. Computes ONE weighted-engagement
 *     delta between before/after and exits immediately (no read, no
 *     write) when that delta is exactly 0 — which is EVERY watch_25/
 *     watch_50/watch_75/impression/videoStart-only update, since those
 *     fields are deliberately excluded from the weighted formula. This is
 *     the actual cost control the spec's own Step 13 asks for: hooking
 *     the ALREADY-aggregated stats doc (one trigger) instead of adding a
 *     second per-action-type listener for each of like/comment/save/
 *     share/complete/rewatch individually.
 *
 * IDEMPOTENCY: same shape as engagementStats.ts's withIdempotentStatsUpdate
 * (a per-CloudEvent-id marker doc, in the SAME transaction as the real
 * write), but generalized to N documents at once (a Reel's hashtags are
 * capped at TREND_MAX_HASHTAGS_PER_PUBLISH, so this is always a small,
 * bounded transaction — never one write per hashtag as a separate round
 * trip). Its own dedicated marker collection (`hashtagTrendEvents`, not
 * engagementStats.ts's `recommendationStatsEvents`) — same "no Firestore
 * Rules entry at all, denied by default" precedent, kept separate purely
 * so each subsystem's own markers stay legible to a future reader.
 */
import { FieldValue, getFirestore, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import { onDocumentDeleted, onDocumentUpdated, onDocumentWritten } from 'firebase-functions/v2/firestore';

// Same region as every other Cloud Function in this project — duplicated
// (not imported), same "zero coupling between sibling files" reasoning as
// engagementStats.ts/collaborative.ts's own REGION constants.
const REGION = 'europe-north1';

/** How many of a Reel's own hashtags actually contribute to city trend stats — mirrors Step 5's HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT cap number for the same "one post with 20 tags shouldn't get 20 full-strength updates" reasoning, kept as its own constant since this is a completely separate write path. */
const TREND_MAX_HASHTAGS_PER_PUBLISH = 6;

/** Bounded per-(city,hashtag) history — newest-first, oldest trimmed once over cap. Generous enough for Around Me's current per-city scale (Step 20's own "keep the threshold low enough that the feature still works for a small launch city" instruction) while keeping every document's size small and predictable regardless of how long a hashtag has been active. */
const TREND_RECENT_POST_CAP = 100;
const TREND_RECENT_ENGAGEMENT_CAP = 150;

/**
 * Coarse, cost-aware engagement weights for TRENDING specifically — a
 * much simpler formula than qualityConfig.ts's own Bayesian-smoothed
 * rates (Step 4), which is about per-CONTENT quality, not city-hashtag
 * momentum, and needs none of that per-item rate-smoothing machinery
 * here. Only the six highest-VALUE, already-trusted-aggregated fields on
 * `stats/engagement` are used — impressions/videoStarts/notInterestedCount/
 * raw watch totals/meaningfulViews are deliberately excluded (see this
 * file's own top doc comment): including them would mean nearly every
 * playback tick's own stats-doc update changes the weighted total, firing
 * this trigger's own read+write far more often than the spec's cost
 * guidance ("not every signal needs to write") allows for.
 */
const TREND_ENGAGEMENT_WEIGHTS = { likes: 1, comments: 2, saves: 3, shares: 2, completions: 2, rewatches: 1 } as const;

function cityHashtagTrendDocId(cityId: string, hashtag: string): string {
  return `${cityId}__${hashtag}`;
}

function cityHashtagTrendRef(db: Firestore, cityId: string, hashtag: string): DocumentReference {
  return db.collection('cityHashtagTrends').doc(cityHashtagTrendDocId(cityId, hashtag));
}

type ReelLike = {
  status?: unknown;
  cityKey?: unknown;
  hashtags?: unknown;
  authorUid?: unknown;
};

/** Defensive extraction — never trusts a raw Firestore read to already be well-formed (same "normalize, never assume" convention this codebase's own normalizeReel/toProfile functions already follow). */
function extractHashtagsAndCity(data: ReelLike): { cityId: string; hashtags: string[] } {
  const cityId = typeof data.cityKey === 'string' ? data.cityKey : '';
  const hashtags = Array.isArray(data.hashtags)
    ? data.hashtags.filter((tag): tag is string => typeof tag === 'string').slice(0, TREND_MAX_HASHTAGS_PER_PUBLISH)
    : [];
  return { cityId, hashtags };
}

type EngagementStatsLike = { likes?: unknown; comments?: unknown; saves?: unknown; shares?: unknown; completions?: unknown; rewatches?: unknown };

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The one weighted-engagement number this whole feature cares about — see TREND_ENGAGEMENT_WEIGHTS' own doc comment for exactly which fields and why. `undefined` (no prior stats doc, or the doc was just deleted) reads as all-zero. */
function computeWeightedTrendEngagement(stats: EngagementStatsLike | undefined): number {
  if (!stats) return 0;
  return (
    num(stats.likes) * TREND_ENGAGEMENT_WEIGHTS.likes +
    num(stats.comments) * TREND_ENGAGEMENT_WEIGHTS.comments +
    num(stats.saves) * TREND_ENGAGEMENT_WEIGHTS.saves +
    num(stats.shares) * TREND_ENGAGEMENT_WEIGHTS.shares +
    num(stats.completions) * TREND_ENGAGEMENT_WEIGHTS.completions +
    num(stats.rewatches) * TREND_ENGAGEMENT_WEIGHTS.rewatches
  );
}

/**
 * The shared idempotent-multi-document-transaction primitive — same
 * "check a marker, compute, write, mark processed, all in ONE
 * transaction" shape as engagementStats.ts's withIdempotentStatsUpdate,
 * generalized to the small, bounded set of hashtag-trend documents ONE
 * Reel/engagement event can touch at once (never a separate round trip
 * per hashtag). `computePatches` returning `null` for a given index means
 * "nothing to write for this one" (e.g. deleting a Reel's contribution
 * from a hashtag that was never actually tracked) — that ref is simply
 * skipped, never given an empty/fabricated document.
 */
async function withIdempotentTrendUpdate(
  db: Firestore,
  eventId: string,
  refs: DocumentReference[],
  computePatches: (currents: (Record<string, unknown> | undefined)[]) => (Record<string, unknown> | null)[]
): Promise<'applied' | 'duplicate'> {
  const markerRef = db.doc(`hashtagTrendEvents/${eventId}`);
  return db.runTransaction(async (tx) => {
    const markerSnap = await tx.get(markerRef);
    if (markerSnap.exists) return 'duplicate';

    // All reads before any write, sequentially — small and bounded
    // (<= TREND_MAX_HASHTAGS_PER_PUBLISH docs), same safe-and-simple
    // choice as the client's own hashtagInterestProfile.ts.
    const currents: (Record<string, unknown> | undefined)[] = [];
    for (const ref of refs) {
      const snap = await tx.get(ref);
      currents.push(snap.exists ? (snap.data() as Record<string, unknown>) : undefined);
    }

    const patches = computePatches(currents);
    tx.set(markerRef, { processedAt: FieldValue.serverTimestamp(), refCount: refs.length });
    refs.forEach((ref, index) => {
      const patch = patches[index];
      if (patch) tx.set(ref, patch, { merge: true });
    });
    return 'applied';
  });
}

// ---------------------------------------------------------------------------
// Publish signal — a genuine (not-already-published) -> 'published'
// transition only. Never a draft being edited, never a failed/discarded
// upload (those never reach 'published' at all — see createReelDraft/
// publishReel in src/services/reels.ts).
// ---------------------------------------------------------------------------
export const onReelPublishedForTrends = onDocumentUpdated({ region: REGION, document: 'reels/{reelId}' }, async (event) => {
  const change = event.data;
  if (!change) return;
  const before = change.before.data() as ReelLike | undefined;
  const after = change.after.data() as ReelLike | undefined;
  if (!after || before?.status === 'published' || after.status !== 'published') return;

  const { cityId, hashtags } = extractHashtagsAndCity(after);
  if (!cityId || hashtags.length === 0) return;

  const creatorUid = typeof after.authorUid === 'string' ? after.authorUid : '';
  const reelId = event.params.reelId;
  const nowMs = Date.now();
  const db = getFirestore();
  const refs = hashtags.map((hashtag) => cityHashtagTrendRef(db, cityId, hashtag));

  await withIdempotentTrendUpdate(db, event.id, refs, (currents) =>
    hashtags.map((hashtag, index) => {
      const current = currents[index];
      const existingPosts = Array.isArray(current?.recentPosts) ? (current!.recentPosts as unknown[]) : [];
      const recentPosts = [{ reelId, atMs: nowMs, creatorUid }, ...existingPosts].slice(0, TREND_RECENT_POST_CAP);
      return {
        cityId,
        hashtag,
        recentPosts,
        recentEngagement: current?.recentEngagement ?? [],
        lastActivityAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
    })
  );
});

// ---------------------------------------------------------------------------
// Delete signal — removes that Reel's own entry from `recentPosts` where
// it's still actually present (Step 11's own "where practical" — an
// entry already evicted by the cap has nothing left to correct, which is
// an accepted, harmless limitation, not an error). A deleted DRAFT never
// contributed anything in the first place (only a publish ever writes
// here), so this is skipped entirely for `status !== 'published'`.
// ---------------------------------------------------------------------------
export const onReelDeletedForTrends = onDocumentDeleted({ region: REGION, document: 'reels/{reelId}' }, async (event) => {
  const snapshot = event.data;
  if (!snapshot) return;
  const data = snapshot.data() as ReelLike;
  if (data.status !== 'published') return;

  const { cityId, hashtags } = extractHashtagsAndCity(data);
  if (!cityId || hashtags.length === 0) return;

  const reelId = event.params.reelId;
  const db = getFirestore();
  const refs = hashtags.map((hashtag) => cityHashtagTrendRef(db, cityId, hashtag));

  await withIdempotentTrendUpdate(db, event.id, refs, (currents) =>
    hashtags.map((hashtag, index) => {
      const current = currents[index];
      if (!current) return null; // never tracked (or already trimmed away) — nothing to correct
      const existingPosts = Array.isArray(current.recentPosts) ? (current.recentPosts as { reelId?: unknown }[]) : [];
      const stillPresent = existingPosts.some((post) => post.reelId === reelId);
      if (!stillPresent) return null; // already evicted by the cap — a real, accepted no-op
      return {
        cityId,
        hashtag,
        recentPosts: existingPosts.filter((post) => post.reelId !== reelId),
        // lastActivityAt intentionally NOT bumped — a removal isn't new activity.
        updatedAt: FieldValue.serverTimestamp(),
      };
    })
  );
});

// ---------------------------------------------------------------------------
// Engagement signal — see this file's own top doc comment for the full
// cost reasoning (the delta===0 early-exit is what keeps every ordinary
// watch-progress stats update from ever touching this feature at all).
// ---------------------------------------------------------------------------
export const onReelEngagementWrittenForTrends = onDocumentWritten({ region: REGION, document: 'reels/{reelId}/stats/engagement' }, async (event) => {
  const change = event.data;
  if (!change || !change.after.exists) return; // stats doc deleted entirely — nothing to roll forward

  const before = change.before.exists ? (change.before.data() as EngagementStatsLike) : undefined;
  const after = change.after.data() as EngagementStatsLike;
  const delta = computeWeightedTrendEngagement(after) - computeWeightedTrendEngagement(before);
  if (delta === 0) return; // e.g. a pure watch_25/watch_50/impression/videoStart update — no read, no write

  const db = getFirestore();
  const reelSnap = await db.doc(`reels/${event.params.reelId}`).get();
  if (!reelSnap.exists) return;
  const { cityId, hashtags } = extractHashtagsAndCity(reelSnap.data() as ReelLike);
  if ((reelSnap.data() as ReelLike).status !== 'published' || !cityId || hashtags.length === 0) return;

  const nowMs = Date.now();
  const refs = hashtags.map((hashtag) => cityHashtagTrendRef(db, cityId, hashtag));

  await withIdempotentTrendUpdate(db, event.id, refs, (currents) =>
    hashtags.map((hashtag, index) => {
      const current = currents[index];
      const existingEngagement = Array.isArray(current?.recentEngagement) ? (current!.recentEngagement as unknown[]) : [];
      const recentEngagement = [{ atMs: nowMs, weight: delta }, ...existingEngagement].slice(0, TREND_RECENT_ENGAGEMENT_CAP);
      return {
        cityId,
        hashtag,
        recentPosts: current?.recentPosts ?? [],
        recentEngagement,
        lastActivityAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
    })
  );
});

// Re-exported purely so a Node-side unit test could import these directly
// if ever needed (same "export the pure/testable pieces" convention as
// engagementStats.ts's own bumpField/validateWatchSample/isMeaningfulView)
// — the actual scoring math these feed into lives client-side, fully unit
// tested there (see src/services/hashtagTrends/hashtagTrendLogic.ts and
// tests/hashtagTrend.test.ts), since none of it depends on Firebase Admin.
export { computeWeightedTrendEngagement, TREND_ENGAGEMENT_WEIGHTS, TREND_MAX_HASHTAGS_PER_PUBLISH, TREND_RECENT_ENGAGEMENT_CAP, TREND_RECENT_POST_CAP };
