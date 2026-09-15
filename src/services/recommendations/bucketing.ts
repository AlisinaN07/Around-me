/**
 * Step 12 exploration bucketing — pure, content-type-agnostic, and
 * deliberately dependency-free (only recommendationConfig.ts + types, no
 * Firebase/Firestore imports at all) so tests/recommendations.test.ts can
 * exercise it directly without dragging in this app's real Firestore
 * services. recommendationEngine.ts is the only real caller.
 */
import type { RecommendationProfile, ExplorationBucket } from '@/types/recommendation';

import { EXPLORATION_BUCKET_RATIOS, KNOWN_CATEGORY_COUNT, RELATED_CATEGORIES } from './recommendationConfig';

/**
 * `profile.categoryScores` already reflects Step 14 cold start (see
 * fetchInterestProfile/applyColdStartSeed in interestProfile.ts, which
 * seeds it from onboarding interests for a brand new account with no
 * real behavioral signal yet) — this never needs to know the difference.
 */
export function classifyBucket(categoryId: string, profile: RecommendationProfile): ExplorationBucket {
  const topCategories = Object.entries(profile.categoryScores)
    .sort((a, b) => b[1] - a[1])
    .slice(0, KNOWN_CATEGORY_COUNT)
    .map(([id]) => id);
  if (topCategories.includes(categoryId)) return 'known';
  const relatedToKnown = new Set(topCategories.flatMap((id) => RELATED_CATEGORIES[id] ?? []));
  if (relatedToKnown.has(categoryId)) return 'related';
  return 'discovery';
}

/**
 * Interleaved weighted round-robin over the three buckets (known/related/
 * discovery), targeting EXPLORATION_BUCKET_RATIOS spread EVENLY across the
 * page — never all "known" items first and discovery clustered at the
 * end. Falls back to whatever bucket still has items (known > related >
 * discovery priority) once one runs dry, so a small candidate pool still
 * fills the page rather than coming up short.
 */
export function buildBucketOrder(pageSize: number): ExplorationBucket[] {
  const buckets: ExplorationBucket[] = ['known', 'related', 'discovery'];
  const credits: Record<ExplorationBucket, number> = { known: 0, related: 0, discovery: 0 };
  const order: ExplorationBucket[] = [];
  for (let i = 0; i < pageSize; i++) {
    for (const bucket of buckets) credits[bucket] += EXPLORATION_BUCKET_RATIOS[bucket];
    let chosen = buckets[0];
    for (const bucket of buckets) {
      if (credits[bucket] > credits[chosen]) chosen = bucket;
    }
    credits[chosen] -= 1;
    order.push(chosen);
  }
  return order;
}

export type BucketableEntry<T> = { item: T; score: number; bucket: ExplorationBucket; creatorId: string; categoryId: string };

function interleaveBuckets<T>(buckets: Record<ExplorationBucket, T[]>, pageSize: number): T[] {
  const order = buildBucketOrder(pageSize);
  const cursors: Record<ExplorationBucket, number> = { known: 0, related: 0, discovery: 0 };
  const fallbackOrder: ExplorationBucket[] = ['known', 'related', 'discovery'];
  const result: T[] = [];

  for (const bucket of order) {
    if (cursors[bucket] < buckets[bucket].length) {
      result.push(buckets[bucket][cursors[bucket]]);
      cursors[bucket] += 1;
      continue;
    }
    const fallback = fallbackOrder.find((candidate) => cursors[candidate] < buckets[candidate].length);
    if (fallback) {
      result.push(buckets[fallback][cursors[fallback]]);
      cursors[fallback] += 1;
    }
  }
  return result;
}

/** Groups already-scored candidates into known/related/discovery, sorts each by score, then interleaves them per buildBucketOrder. The one function recommendationEngine.ts actually calls per feed page. */
export function bucketAndSort<T extends BucketableEntry<unknown>>(scored: T[], pageSize: number): T[] {
  const buckets: Record<ExplorationBucket, T[]> = { known: [], related: [], discovery: [] };
  for (const entry of scored) buckets[entry.bucket].push(entry);
  for (const key of Object.keys(buckets) as ExplorationBucket[]) {
    buckets[key].sort((a, b) => b.score - a.score);
  }
  return interleaveBuckets(buckets, pageSize);
}
