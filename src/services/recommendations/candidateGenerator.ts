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
 *
 * Perf pass — real cursor pagination (fixes the audit's own "load-more
 * re-runs the same bounded 180-doc query from the start every page"
 * finding). STRICT GEOGRAPHY is completely unaffected: `fetchCityReelsPage`
 * shares the exact same `scopeWhereClause` as `fetchCityReels` (City stays
 * City, Country stays that one country, World stays unfiltered) — a real
 * Firestore `startAfter` cursor is the only difference, so this changes
 * HOW eligible candidates are fetched, never WHICH ones are eligible or
 * how they're ranked afterward. `ReelCandidateCursor.scopeKey` isolates
 * pagination state per scope (Karlstad City vs. Sweden Country vs. Global
 * each get their own, never-shared cursor) — see generateReelCandidates'
 * own doc comment for exactly how.
 */
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';

import type { BrowseScope } from '@/types/browseScope';
import { browseScopeKey } from '@/types/browseScope';
import type { Reel } from '@/types/reel';

import { fetchMyBlockedUserIds } from '../blocks';
import { fetchCityReels, fetchCityReelsPage, fetchFollowingReels } from '../reels';
import { CANDIDATE_POOL } from './recommendationConfig';

/**
 * Opaque pagination state for one scope's own local (City/Country/World)
 * pool. `scopeKey` (see browseScopeKey) is what keeps Karlstad's own City
 * cursor from ever being read back as if it were Sweden's Country cursor
 * or the Global cursor — generateReelCandidates only ever resumes a
 * `previousCursor` whose `scopeKey` matches the CURRENT scope exactly;
 * anything else (a genuine scope change) starts that scope fresh from
 * page one, which is also what naturally happens the first time a scope
 * is ever viewed. `exhausted` persists across calls so an already-fully-
 * paged-through scope never re-queries it's own local pool again this
 * session — only the small Following/blocked-list reads still run.
 */
export type ReelCandidateCursor = {
  scopeKey: string;
  cityCursor: QueryDocumentSnapshot<DocumentData> | null;
  exhausted: boolean;
};

export type ReelCandidatePool = {
  candidates: Reel[];
  cursor: ReelCandidateCursor;
};

function freshCursor(scopeKey: string, exhausted = false): ReelCandidateCursor {
  return { scopeKey, cityCursor: null, exhausted };
}

/**
 * Fetches the candidate pool for one uid's Reels "For You" feed. Excludes
 * blocked authors and (via `excludeReelIds`, accumulated by the caller
 * across feed pages — see recommendationEngine.ts) anything already shown
 * this session — this remains a safety-net dedupe layer, not the primary
 * mechanism preventing repeated reads (that's `previousCursor` below).
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
 * already naturally includes it, via fetchCityReels'/fetchCityReelsPage's
 * own 'country'/'world' query branches, with no widening needed.
 *
 * `previousCursor` should be whatever this same function returned on the
 * last call for this uid's session (`undefined` on the very first page);
 * it's only honored when its own `scopeKey` matches the CURRENT scope —
 * a scope change always starts that scope's own pool fresh, from page
 * one, exactly like viewing it for the first time. `'cities'` (multi-city
 * drill-down) is deliberately NOT routed through cursor pagination at
 * all — see the branch below for why.
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
  normalizedCityAffinity: Record<string, number> = {},
  previousCursor?: ReelCandidateCursor
): Promise<ReelCandidatePool> {
  void homeCountryCode;
  void normalizedCityAffinity;

  const scopeKey = browseScopeKey(scope);
  const isContinuation = previousCursor?.scopeKey === scopeKey;

  const [followingReels, blockedUids] = await Promise.all([
    fetchFollowingReels({ currentUid: uid, scope, limit: CANDIDATE_POOL.followingPoolLimit }).then((result) => result.reels),
    fetchMyBlockedUserIds(uid),
  ]);
  const blocked = new Set(blockedUids);
  const seen = new Set(excludeReelIds);
  const collected: Reel[] = [];
  let duplicatesFiltered = 0;

  const addReels = (reels: Reel[]) => {
    for (const reel of reels) {
      if (seen.has(reel.reelId) || blocked.has(reel.authorUid)) {
        duplicatesFiltered += 1;
        continue;
      }
      seen.add(reel.reelId);
      collected.push(reel);
    }
  };

  // Step: Following is not promotion-gated — merged in unconditionally,
  // completely independent of the local pool below.
  addReels(followingReels);

  // 'cities' (multi-city drill-down) — deliberately NOT routed through
  // cursor pagination: this scope kind already fans into a bounded
  // `where('cityKey', 'in', [...])` fetch (fetchCityReels' own branch),
  // and a real per-city-combination cursor scheme was judged not worth
  // the added complexity for this secondary, less-used scope kind (same
  // "report the decision, don't force a fit" call this codebase already
  // made for 'cities' scope elsewhere). Its OLD simple, single-bounded-
  // fetch behavior is fully preserved.
  if (scope.kind === 'cities') {
    addReels(await fetchCityReels(scope, CANDIDATE_POOL.localPoolLimit));
    return { candidates: collected, cursor: freshCursor(scopeKey, true) };
  }

  const resumed = isContinuation ? previousCursor! : freshCursor(scopeKey);

  let cityCursor = resumed.cityCursor;
  let exhausted = resumed.exhausted;
  let pageReturnedCount = 0;

  // Once a scope's own local pool is fully exhausted, never re-query it
  // again this session — only the small Following/blocked-list reads
  // above still run on every call. This is the actual fix for the
  // audit's "load-more re-reads the same ~180 documents" finding: a
  // continuation call resumes from `cityCursor`, a real Firestore
  // `startAfter` position, instead of re-running the bounded query from
  // the very start.
  if (!exhausted) {
    const page = await fetchCityReelsPage(scope, cityCursor, CANDIDATE_POOL.localPoolLimit);
    pageReturnedCount = page.items.length;
    cityCursor = page.cursor;
    if (page.cursor === null) exhausted = true;
    addReels(page.items);
  }

  if (__DEV__) {
    // Dev-only pagination observability (Step 2's own explicit ask) —
    // never runs in production builds, never affects candidate
    // generation itself.
    // eslint-disable-next-line no-console
    console.log('[recommendations] Reel candidate pagination', {
      scope: scopeKey,
      mode: isContinuation ? 'continuation' : 'initial',
      requestedPageSize: CANDIDATE_POOL.localPoolLimit,
      returnedCount: pageReturnedCount,
      exhausted,
      duplicatesFiltered,
      totalCollected: collected.length,
    });
  }

  return { candidates: collected, cursor: { scopeKey, cityCursor, exhausted } };
}
