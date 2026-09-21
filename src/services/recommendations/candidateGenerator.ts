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
import { CANDIDATE_POOL } from './recommendationConfig';

export type ReelCandidatePool = {
  candidates: Reel[];
};

/**
 * Fetches the candidate pool for one uid's Reels "For You" feed. Excludes
 * blocked authors and (via `excludeReelIds`, accumulated by the caller
 * across feed pages — see recommendationEngine.ts) anything already shown
 * this session, so a second page never just re-ranks the exact same pool.
 *
 * STRICT GEOGRAPHY, no exceptions: the candidate pool is exactly what the
 * viewer's own explicitly selected `scope` returns — City stays City,
 * Country stays that one country, World is everything. There is no
 * fallback that ever widens a starved scope into a broader one (the old
 * Step 8 "graceful widening" — city -> country -> world when the pool was
 * thin — has been removed entirely, by explicit product decision): a
 * Karlstad Reel must never appear under Stockholm, and a Swedish Reel
 * must never appear under a different country, no matter how few Reels
 * the selected scope currently has. The ONLY way to see broader content
 * is to explicitly pick a broader scope (Country or World) — which
 * already naturally includes it, via fetchCityReels' own
 * 'country'/'world' query branches, with no widening needed.
 *
 * `homeCountryCode`/`normalizedCityAffinity` are accepted for call-site
 * compatibility with recommendationEngine.ts (which still computes the
 * latter for ranking.ts's own scoreLocation secondary-city bonus, and for
 * Events' own separate secondary-city discovery section) but are no
 * longer used to inject another city's/country's Reels as CANDIDATES
 * here.
 */
export async function generateReelCandidates(
  uid: string,
  scope: BrowseScope,
  homeCountryCode: string,
  excludeReelIds: ReadonlySet<string>,
  normalizedCityAffinity: Record<string, number> = {}
): Promise<ReelCandidatePool> {
  void homeCountryCode;
  void normalizedCityAffinity;

  const [localPool, followingPool, blockedUids] = await Promise.all([
    fetchCityReels(scope, CANDIDATE_POOL.localPoolLimit),
    fetchFollowingReels({ currentUid: uid, scope, limit: CANDIDATE_POOL.followingPoolLimit }).then((result) => result.reels),
    fetchMyBlockedUserIds(uid),
  ]);

  const combined = [...localPool, ...followingPool];
  const effectivePool = dedupeAndFilter(combined, blockedUids, excludeReelIds);

  return { candidates: effectivePool };
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
