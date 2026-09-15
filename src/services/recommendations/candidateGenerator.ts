/**
 * Step 6 — candidate generation for the Reels "For You" feed. Builds a
 * bounded pool (roughly 100-300 items, per the spec's own target) from a
 * SMALL number of parallel Firestore queries, never a full collection
 * scan, and never one query per category/candidate-source combination.
 *
 * Deliberately ONE shared local pool (recent published Reels in the
 * active scope) covers candidate sources A-D and G from the spec
 * (strongest interests, adjacent interests, popular, fresh, local) —
 * recommendationEngine.ts does the actual interest/freshness/popularity
 * SCORING and bucketing over this one pool afterward, rather than this
 * function running a separate query per source. At Around Me's current
 * per-city content volume this is both simpler and cheaper than N
 * category-scoped queries would be; see this feature's own final report
 * for why a per-category query (needing new composite indexes) is a
 * reasonable next-stage improvement once content volume grows per city.
 * Source E (followed creators) gets its own small supplementary query
 * since the shared recency-ordered pool could otherwise miss a followed
 * creator's older-but-still-relevant Reel entirely.
 *
 * Recommendation Engine — Step 5, Step 27 — collaborative-filtering
 * discovery categories (see collaborative.ts/ranking.ts's
 * scoreCollaborativeAffinity) are deliberately NOT given their own 1-3
 * dedicated category-scoped queries here yet, even though Step 27 asks
 * for that capability: this app has no `categoryId`-scoped composite
 * index on `reels` today (see firestore.indexes.json), and at this
 * project's current per-city content volume the SAME reasoning above
 * already applies — the shared local pool (up to localPoolLimit=180
 * recent Reels) already contains effectively every published Reel in
 * scope, so a collaborative-discovery category candidate is already IN
 * the pool; `scoreCollaborativeAffinity` re-ranking it favorably at
 * scoring time achieves Step 27's actual intent (a fair shot at
 * surfacing) without a new query or index. REVISIT this once
 * localPoolLimit stops safely covering a city's full recent catalog
 * (i.e., once a single city can publish more than ~180 Reels within the
 * freshness window this pool implicitly favors) — at that point, add a
 * `cityKey + categoryId + status + publishedAt` composite index and a
 * bounded (max 1-3, per Step 27's own cap) supplemental query here, gated
 * on the SAME `pickSecondaryCity`-style "does a real, confident signal
 * exist" check collaborativeProfile.confidence already provides.
 */
import type { BrowseScope } from '@/types/browseScope';
import type { Reel } from '@/types/reel';

import { fetchMyBlockedUserIds } from '../blocks';
import { fetchCityReels, fetchFollowingReels } from '../reels';
import { CANDIDATE_POOL, SECONDARY_CITY_REEL_POOL_LIMIT } from './recommendationConfig';
import { pickSecondaryCity } from './ranking';

function widenScope(scope: BrowseScope, homeCountryCode: string): BrowseScope | null {
  if (scope.kind === 'world') return null;
  if (scope.kind === 'country') return { kind: 'world' };
  return { kind: 'country', countryCode: homeCountryCode };
}

export type ReelCandidatePool = {
  candidates: Reel[];
  /** True when scope had to widen (Step 8's graceful widening) because the active scope alone didn't have enough local content. */
  widened: boolean;
};

/**
 * Fetches the candidate pool for one uid's Reels "For You" feed. Excludes
 * blocked authors and (via `excludeReelIds`, accumulated by the caller
 * across feed pages — see recommendationEngine.ts) anything already shown
 * this session, so a second page never just re-ranks the exact same pool.
 *
 * Recommendation Engine — Step 3, Step 17 — `normalizedCityAffinity` (see
 * ranking.ts's normalizeCityAffinity, computed once by the caller from
 * the already-fetched profile) optionally adds ONE small, bounded
 * supplementary query for the single qualifying learned secondary city
 * (see pickSecondaryCity) — never one query per learned city, and never
 * more than SECONDARY_CITY_REEL_POOL_LIMIT items. This is a deliberate
 * exploration injection (Step 6/23's "Stockholm should occasionally
 * appear"), independent of the graceful-widening fallback below (that
 * one only ever fires when the pool is STARVED; this one fires purely
 * because a real learned preference exists, regardless of how rich the
 * home-scope pool already is).
 */
export async function generateReelCandidates(
  uid: string,
  scope: BrowseScope,
  homeCountryCode: string,
  excludeReelIds: ReadonlySet<string>,
  normalizedCityAffinity: Record<string, number> = {}
): Promise<ReelCandidatePool> {
  const secondaryCityKey = pickSecondaryCity(scope, normalizedCityAffinity);

  const [localPool, followingPool, secondaryPool, blockedUids] = await Promise.all([
    fetchCityReels(scope, CANDIDATE_POOL.localPoolLimit),
    fetchFollowingReels({ currentUid: uid, scope, limit: CANDIDATE_POOL.followingPoolLimit }).then((result) => result.reels),
    secondaryCityKey ? fetchCityReels({ kind: 'city', cityKey: secondaryCityKey }, SECONDARY_CITY_REEL_POOL_LIMIT) : Promise.resolve([]),
    fetchMyBlockedUserIds(uid),
  ]);

  let widened = false;
  let combined = [...localPool, ...followingPool, ...secondaryPool];
  let effectivePool = dedupeAndFilter(combined, blockedUids, excludeReelIds);

  // Step 8 — graceful widening: not enough local content, so widen scope
  // city -> country -> world rather than serving a starved feed. Only
  // ever widens ONE step per call (city/cities -> country, or
  // country -> world) — recommendationEngine re-derives scope on the next
  // page fetch anyway, so this doesn't need to recurse further here.
  if (effectivePool.length < CANDIDATE_POOL.minLocalPoolBeforeWidening) {
    const wider = widenScope(scope, homeCountryCode);
    if (wider) {
      widened = true;
      const widerPool = await fetchCityReels(wider, CANDIDATE_POOL.localPoolLimit);
      combined = [...combined, ...widerPool];
      effectivePool = dedupeAndFilter(combined, blockedUids, excludeReelIds);
    }
  }

  return { candidates: effectivePool, widened };
}

function dedupeAndFilter(reels: Reel[], blockedUids: string[], excludeReelIds: ReadonlySet<string>): Reel[] {
  const blocked = new Set(blockedUids);
  const seen = new Set<string>();
  const result: Reel[] = [];
  for (const reel of reels) {
    if (seen.has(reel.reelId) || excludeReelIds.has(reel.reelId)) continue;
    if (blocked.has(reel.authorUid)) continue;
    seen.add(reel.reelId);
    result.push(reel);
  }
  return result;
}
