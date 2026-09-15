/**
 * Recommendation Engine — Step 4, Step 22 — the read side of the trusted
 * engagement-stats doc (see src/types/engagementStats.ts for the schema
 * and trust-level documentation, functions/src/engagementStats.ts for the
 * trigger that maintains it). One doc read replaces the previous TWO
 * `getCountFromServer` calls per displayed item (see reelEngagement.ts's/
 * socialEngagement.ts's fetchReelLikeCount/fetchReelCommentCount, still
 * used as the Step 23 fallback below).
 */
import { doc, getDoc } from 'firebase/firestore';

import type { ContentEngagementStats } from '@/types/engagementStats';
import { EMPTY_ENGAGEMENT_STATS } from '@/types/engagementStats';

import { firestore } from '../firestore';

function statsRef(kind: 'reel' | 'content', id: string) {
  return doc(firestore!, kind === 'reel' ? 'reels' : 'content', id, 'stats', 'engagement');
}

/** Tolerates a missing/partial/legacy doc the same way this codebase's other normalize* functions do — never throws, always returns a well-formed shape. */
function normalizeEngagementStats(data: unknown): ContentEngagementStats {
  if (!data || typeof data !== 'object') return EMPTY_ENGAGEMENT_STATS;
  const raw = data as Partial<Record<keyof ContentEngagementStats, unknown>>;
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  return {
    impressions: num(raw.impressions, 0),
    videoStarts: num(raw.videoStarts, 0),
    meaningfulViews: num(raw.meaningfulViews, 0),
    completions: num(raw.completions, 0),
    rewatches: num(raw.rewatches, 0),
    totalWatchMs: num(raw.totalWatchMs, 0),
    totalWatchPercent: num(raw.totalWatchPercent, 0),
    watchSampleCount: num(raw.watchSampleCount, 0),
    likes: num(raw.likes, 0),
    comments: num(raw.comments, 0),
    saves: num(raw.saves, 0),
    shares: num(raw.shares, 0),
    notInterestedCount: num(raw.notInterestedCount, 0),
    eventOpens: num(raw.eventOpens, 0),
    eventInterested: num(raw.eventInterested, 0),
    eventGoing: num(raw.eventGoing, 0),
    updatedAtMs: num(raw.updatedAtMs, 0),
    schemaVersion: num(raw.schemaVersion, 1),
  };
}

/**
 * `null` means "no usable stats yet" — either a genuinely missing doc
 * (Step 23's graceful migration: brand new content, or content published
 * before this pass existed), OR the read itself failing for any reason
 * (e.g. `permission-denied` if this exact client happens to be running
 * against a `firestore.rules` deploy that predates this pass's own
 * `stats/engagement` read rule). Never throws — a ranking-pipeline read
 * must degrade to the next fallback tier (see ranking.ts's
 * resolveQualityScore), not break the whole feed load over one missing
 * permission on one dimension.
 */
export async function fetchEngagementStats(kind: 'reel' | 'content', id: string): Promise<ContentEngagementStats | null> {
  if (!firestore) return null;
  try {
    const snapshot = await getDoc(statsRef(kind, id));
    if (!snapshot.exists()) return null;
    return normalizeEngagementStats(snapshot.data());
  } catch {
    return null;
  }
}

/**
 * Step 22 — one bounded batch of stats reads, run in PARALLEL (never
 * sequentially, never N+1) for exactly the page-sized set of candidates
 * actually being shown — same pattern the popularity `getCountFromServer`
 * calls it replaces already followed (see recommendationEngine.ts). The
 * client Firestore SDK has no true multi-get batch API the way the Admin
 * SDK does; `Promise.all` of individual reads is the standard, correct
 * client-side equivalent and is already a 2x reduction from the two count
 * queries this replaces (see this feature's own performance report).
 */
export async function fetchEngagementStatsBatch(kind: 'reel' | 'content', ids: readonly string[]): Promise<Map<string, ContentEngagementStats | null>> {
  const results = await Promise.all(ids.map((id) => fetchEngagementStats(kind, id)));
  return new Map(ids.map((id, index) => [id, results[index]]));
}
