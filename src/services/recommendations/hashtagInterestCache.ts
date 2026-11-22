/**
 * Recommendation Engine — For You ranking integration — the ONE point of
 * contact between the ranking pipeline and users/{uid}/hashtagInterests
 * (Step 5). Same shape as collaborative.ts's getCachedCollaborativeProfile:
 * a bounded read (getUserTopHashtagInterests, already built in Step 5) plus
 * a short-lived in-memory cache, so a whole recommendation batch — the
 * initial page and every subsequent onEndReached page — costs at most ONE
 * Firestore read of the caller's own top hashtag interests, never one read
 * per page and never one read per candidate Reel.
 */
import type { TopHashtagInterest } from '@/types/hashtagInterest';

import { HASHTAG_INTEREST_CACHE_TTL_MS, HASHTAG_RANKING_INTEREST_LIMIT } from './hashtagInterestConfig';
import { getUserTopHashtagInterests } from './hashtagInterestProfile';
import { isCacheFresh } from './reliability';

/** Empty map — the "no signal" value used both for a genuinely new user (zero interest documents) and for a failed read (see getCachedHashtagInterestMap's own doc comment). scoreHashtagRelevance already treats an empty map as "no hashtag boost" for every candidate, so both cases degrade identically and safely. */
const EMPTY_HASHTAG_INTEREST_MAP: ReadonlyMap<string, number> = new Map();

/**
 * Fetches the caller's own top hashtag interests and returns them as a
 * ready-to-use `Map<hashtag, score>` lookup — exactly the shape
 * scoreHashtagRelevance (ranking.ts) needs, so recommendationEngine.ts
 * never has to re-derive one per call. FAIL-SOFT (spec's own explicit
 * requirement): a Firestore read failure (offline, transient error, ...)
 * is caught here and degrades to the same empty map a brand-new user with
 * no hashtag history gets — the For You feed must never fail, or even
 * skip hashtag scoring's own graceful zero-contribution path, just
 * because this one read didn't succeed.
 */
async function fetchHashtagInterestMap(uid: string): Promise<Map<string, number>> {
  try {
    const interests: TopHashtagInterest[] = await getUserTopHashtagInterests(uid, HASHTAG_RANKING_INTEREST_LIMIT);
    const map = new Map<string, number>();
    for (const interest of interests) map.set(interest.hashtag, interest.score);
    return map;
  } catch {
    return new Map(EMPTY_HASHTAG_INTEREST_MAP);
  }
}

type CacheEntry = { interestMap: Map<string, number>; fetchedAtMs: number };
const cache = new Map<string, CacheEntry>();

/** Same short-lived-cache shape as profileCache.ts/collaborative.ts's own getCached* functions — one read per feed session in the common case, not one per page. */
export async function getCachedHashtagInterestMap(uid: string): Promise<Map<string, number>> {
  const cached = cache.get(uid);
  if (cached && isCacheFresh(cached.fetchedAtMs, Date.now(), HASHTAG_INTEREST_CACHE_TTL_MS)) {
    return cached.interestMap;
  }
  const interestMap = await fetchHashtagInterestMap(uid);
  cache.set(uid, { interestMap, fetchedAtMs: Date.now() });
  return interestMap;
}

/** Called right after a real hashtag-interest signal is persisted (see interactions.ts) so the NEXT recommendation batch reflects it rather than serving a stale cached map for up to HASHTAG_INTEREST_CACHE_TTL_MS. Safe to call for a uid with nothing cached (a no-op) — same contract as invalidateInterestProfileCache in profileCache.ts. */
export function invalidateHashtagInterestCache(uid: string): void {
  cache.delete(uid);
}
