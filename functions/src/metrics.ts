/**
 * Recommendation Engine — Step 6 — evaluation & feed-health metrics,
 * built ENTIRELY from the existing `recommendationEvents` stream (no new
 * client writes were needed beyond the small analytics fields Step 6
 * itself added to that event — see src/types/recommendation.ts's own
 * doc comment on TrackInteractionInput/RecommendationEvent). This file
 * does NOT duplicate an existing analytics system — inspection (this
 * feature's own Step 1) confirmed there is no Firebase Analytics usage
 * anywhere in this project (no `firebase/analytics` import, no
 * `logEvent` call) — this IS the first analytics/evaluation layer.
 *
 * THREE bounded, backend-only aggregates, all derived from the SAME
 * trigger (one Cloud Function, up to three idempotent sub-updates —
 * see onRecommendationEventCreatedForMetrics):
 *
 *   1. recommendationMetrics/reels_{date} — one doc per UTC day, Reels/
 *      Home For You metrics (Step 2), broken down by exploration bucket
 *      and by collaborative-discovery/same-city/secondary-city source
 *      tags (Step 5) — NOT broken down further (no per-user, no per-
 *      content entries — Step 15's own "keep cardinality bounded").
 *   2. recommendationMetrics/events_{date} — one doc per UTC day, the
 *      Events funnel (Step 3: shown -> opened -> interested -> going).
 *      Deliberately built ONLY from the three action names that are
 *      unambiguously Event-specific by construction (`event_open`,
 *      `event_interested`, `event_going` — see the doc comment on
 *      buildEventMetricsPatch for why `not_interested`/`share` are
 *      excluded here: `contentType: 'content'` also covers text Posts/
 *      Activities, and there is no field on a recommendationEvent
 *      distinguishing which — attributing an ambiguous action to
 *      "Events" would silently misreport this metric with content that
 *      was never an Event at all).
 *   3. users/{uid}/feedSessions/{feedSessionId} — Step 9's own session
 *      summary, built incrementally (never a single "finalize" write —
 *      see this file's own doc comment on why: a session's
 *      `lastEventAt` simply stops advancing once the user leaves, so
 *      "session duration" is `lastEventAt - startedAt` computed AT READ
 *      TIME by the admin evaluation script, with no explicit
 *      finalization signal needed from the client at all — Step 9's own
 *      "aggregate locally/backend and finalize periodically... WHERE
 *      PRACTICAL" allowance).
 *
 * IDEMPOTENCY (Step 7/17) — reuses engagementStats.ts's own
 * withIdempotentStatsUpdate primitive (same transaction+marker pattern),
 * with a per-PURPOSE composite marker key (`${event.id}:reels`,
 * `${event.id}:events`, `${event.id}:session`) — NOT the bare event.id —
 * since all three sub-updates share the same underlying trigger
 * invocation and would otherwise shadow each other's markers.
 *
 * TRUST (Step 16) — every field aggregated here is self-reported by the
 * SAME client that generated it (same MEDIUM trust level
 * recommendationEvents already had before this pass). This file never
 * exposes one user's session/behavior to another user — feedSessions are
 * owner-scoped subcollections, and recommendationMetrics is aggregate-
 * only with NO per-user breakdown at all.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';

import { withIdempotentStatsUpdate, WATCH_SUMMARY_ACTIONS } from './engagementStats';

const REGION = 'europe-north1';

function utcDateString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function num(current: Record<string, unknown>, field: string): number {
  const value = current[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function bump(current: Record<string, unknown>, field: string, delta = 1): number {
  return num(current, field) + delta;
}

/** Increments one field inside a nested bucket-shaped sub-object (e.g. `known.impressions`) without disturbing the sub-object's other fields. */
export function bumpNested(current: Record<string, unknown>, bucketKey: string, field: string, delta = 1): Record<string, unknown> {
  const bucket = current[bucketKey];
  const bucketObj = bucket && typeof bucket === 'object' ? (bucket as Record<string, unknown>) : {};
  return { ...bucketObj, [field]: num(bucketObj, field) + delta };
}

type RecommendationEventLike = {
  action?: unknown;
  contentType?: unknown;
  bucket?: unknown;
  sourceTags?: unknown;
  watchPercentage?: unknown;
  feedSessionId?: unknown;
  categoryId?: unknown;
  creatorId?: unknown;
  rankingVersion?: unknown;
  experimentVariant?: unknown;
};

const KNOWN_BUCKETS = new Set(['known', 'related', 'discovery']);

/**
 * Step 2/5 — Reels/Home For You daily metrics. Every field here maps
 * directly onto one of Step 2's own listed metrics; `known`/`related`/
 * `discovery` and `collaborativeDiscovery` are the ONLY breakdown
 * dimensions kept (Step 5's own "measure engagement separately for each
 * source" — the four sources this pass can actually attribute, per
 * attribution.ts's own doc comment on which tags exist).
 */
export function buildReelMetricsPatch(current: Record<string, unknown>, data: RecommendationEventLike): Record<string, unknown> | null {
  const action = data.action;
  if (typeof action !== 'string') return null;
  const bucket = typeof data.bucket === 'string' && KNOWN_BUCKETS.has(data.bucket) ? data.bucket : null;
  const sourceTags = typeof data.sourceTags === 'string' ? data.sourceTags.split(',').filter(Boolean) : [];
  const patch: Record<string, unknown> = { date: utcDateString(), updatedAtMs: Date.now(), schemaVersion: 1 };

  if (action === 'impression') {
    patch.impressions = bump(current, 'impressions');
    if (bucket) patch[bucket] = bumpNested(current, bucket, 'impressions');
    if (sourceTags.includes('collaborative_discovery')) patch.collaborativeDiscovery = bumpNested(current, 'collaborativeDiscovery', 'impressions');
    if (sourceTags.includes('same_city')) patch.sameCityImpressions = bump(current, 'sameCityImpressions');
    if (sourceTags.includes('secondary_city_exploration')) patch.secondaryCityImpressions = bump(current, 'secondaryCityImpressions');
    return patch;
  }

  if (WATCH_SUMMARY_ACTIONS.has(action)) {
    const watchPercentage = typeof data.watchPercentage === 'number' && Number.isFinite(data.watchPercentage) ? data.watchPercentage : 0;
    patch.totalWatchPercentSum = num(current, 'totalWatchPercentSum') + Math.max(0, Math.min(1, watchPercentage));
    patch.watchSampleCount = bump(current, 'watchSampleCount');
    if (action === 'quick_skip') {
      patch.quickSkips = bump(current, 'quickSkips');
      return patch;
    }
    patch.meaningfulViews = bump(current, 'meaningfulViews');
    if (bucket) patch[bucket] = bumpNested(current, bucket, 'meaningfulViews');
    if (sourceTags.includes('collaborative_discovery')) patch.collaborativeDiscovery = bumpNested(current, 'collaborativeDiscovery', 'meaningfulViews');
    if (action === 'complete') patch.completions = bump(current, 'completions');
    if (action === 'rewatch') patch.rewatches = bump(current, 'rewatches');
    return patch;
  }

  if (action === 'like') {
    patch.likes = bump(current, 'likes');
    return patch;
  }
  if (action === 'save') {
    patch.saves = bump(current, 'saves');
    if (bucket) patch[bucket] = bumpNested(current, bucket, 'saves');
    if (sourceTags.includes('collaborative_discovery')) patch.collaborativeDiscovery = bumpNested(current, 'collaborativeDiscovery', 'saves');
    return patch;
  }
  if (action === 'share') {
    patch.shares = bump(current, 'shares');
    return patch;
  }
  if (action === 'comment') {
    patch.comments = bump(current, 'comments');
    return patch;
  }
  if (action === 'not_interested') {
    patch.notInterested = bump(current, 'notInterested');
    if (bucket) patch[bucket] = bumpNested(current, bucket, 'notInterested');
    return patch;
  }
  return null; // profile_open/follow/unfollow/video_started/etc. — not a Reel-feed-health metric on their own (see this file's own top doc comment on the follow-after-view limitation).
}

/**
 * Step 3 — the Events funnel. Deliberately narrow — see this file's own
 * top doc comment for why only these three actions are used.
 */
export function buildEventMetricsPatch(current: Record<string, unknown>, data: RecommendationEventLike): Record<string, unknown> | null {
  const action = data.action;
  const sourceTags = typeof data.sourceTags === 'string' ? data.sourceTags.split(',').filter(Boolean) : [];
  const patch: Record<string, unknown> = { date: utcDateString(), updatedAtMs: Date.now(), schemaVersion: 1 };

  if (action === 'event_open') {
    patch.opens = bump(current, 'opens');
    if (sourceTags.includes('same_city')) patch.sameCityOpens = bump(current, 'sameCityOpens');
    if (sourceTags.includes('secondary_city_exploration')) patch.secondaryCityOpens = bump(current, 'secondaryCityOpens');
    return patch;
  }
  if (action === 'event_interested') {
    patch.interested = bump(current, 'interested');
    return patch;
  }
  if (action === 'event_going') {
    patch.going = bump(current, 'going');
    return patch;
  }
  return null;
}

const MAX_UNIQUE_TRACKED = 50;

/** Appends an id to a bounded, de-duplicated list — used for the session's own uniqueCreators/uniqueCategories (Step 9). Once the bound is hit, a genuinely new id is simply not added (the COUNT stays capped, never wrong-but-unbounded) — acceptable for a feed session, which realistically never shows more than a handful of distinct creators/categories anyway. */
export function addUnique(list: unknown, id: string): string[] {
  const current = Array.isArray(list) ? (list as string[]) : [];
  if (current.includes(id) || current.length >= MAX_UNIQUE_TRACKED) return current;
  return [...current, id];
}

/**
 * Step 9/10 — the per-session summary. Built incrementally, one field at
 * a time, from whichever real interaction just happened — never a single
 * bulk "finalize" write (see this file's own top doc comment).
 */
export function buildSessionPatch(current: Record<string, unknown>, data: RecommendationEventLike, uid: string): Record<string, unknown> {
  const action = data.action;
  const patch: Record<string, unknown> = {
    userId: uid,
    startedAt: typeof current.startedAt === 'number' ? current.startedAt : Date.now(),
    lastEventAt: Date.now(),
    schemaVersion: 1,
  };
  if (typeof data.rankingVersion === 'string' && data.rankingVersion) patch.rankingVersion = data.rankingVersion;
  if (typeof data.experimentVariant === 'string' && data.experimentVariant) patch.variantId = data.experimentVariant;

  if (action === 'impression') patch.itemsShown = bump(current, 'itemsShown');
  if (typeof action === 'string' && WATCH_SUMMARY_ACTIONS.has(action) && action !== 'quick_skip') patch.meaningfulViews = bump(current, 'meaningfulViews');
  if (action === 'like') patch.likes = bump(current, 'likes');
  if (action === 'save') patch.saves = bump(current, 'saves');
  if (action === 'share') patch.shares = bump(current, 'shares');
  if (action === 'not_interested') patch.notInterested = bump(current, 'notInterested');

  if (typeof data.creatorId === 'string' && data.creatorId) patch.uniqueCreatorIds = addUnique(current.uniqueCreatorIds, data.creatorId);
  if (typeof data.categoryId === 'string' && data.categoryId) patch.uniqueCategoryIds = addUnique(current.uniqueCategoryIds, data.categoryId);

  return patch;
}

export const onRecommendationEventCreatedForMetrics = onDocumentCreated(
  { region: REGION, document: 'users/{uid}/recommendationEvents/{eventId}' },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) return;
    const data = snapshot.data() as RecommendationEventLike;
    const uid = event.params.uid;
    const contentType = data.contentType;
    const db = getFirestore();
    const date = utcDateString();

    if (contentType === 'reel') {
      const reelsRef = db.doc(`recommendationMetrics/reels_${date}`);
      await withIdempotentStatsUpdate(db, `${event.id}:reels`, reelsRef, (current) => buildReelMetricsPatch(current, data));
    } else if (contentType === 'content') {
      const eventsRef = db.doc(`recommendationMetrics/events_${date}`);
      await withIdempotentStatsUpdate(db, `${event.id}:events`, eventsRef, (current) => buildEventMetricsPatch(current, data));
    }

    if (typeof data.feedSessionId === 'string' && data.feedSessionId) {
      const sessionRef = db.doc(`users/${uid}/feedSessions/${data.feedSessionId}`);
      await withIdempotentStatsUpdate(db, `${event.id}:session`, sessionRef, (current) => buildSessionPatch(current, data, uid));
    }
  }
);
