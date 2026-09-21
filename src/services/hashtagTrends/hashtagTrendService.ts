/**
 * Trending Hashtags by City and Time Window — the ONE point of contact
 * between UI code and cityHashtagTrends (see functions/src/hashtagTrends.ts
 * for the trusted write side, hashtagTrendLogic.ts for the pure scoring
 * math this file only adds Firestore read + caching on top of). UI code
 * should only ever import getTrendingHashtagsForCity from here — never
 * talk to the `cityHashtagTrends` collection directly.
 *
 * QUERY (Step: avoid full historical scans / one read per hashtag): ONE
 * bounded query per (cityId, window) — `where('cityId','==',cityId)
 * .orderBy('lastActivityAt','desc').limit(TREND_CANDIDATE_POOL_SIZE)` —
 * scores every candidate LOCALLY (no per-hashtag follow-up read — the
 * scoring inputs are already fully contained in each candidate's own
 * document), sorts, and returns the top N. Never fetches raw Reels, never
 * scans a whole city's content.
 */
import { collection, getDocs, limit, orderBy, query, where } from 'firebase/firestore';

import type { CityHashtagTrend, TrendingHashtag } from '@/types/hashtagTrend';
import { TtlCache } from '@/utils/requestCache';

import { firestore } from '../firestore';
import {
  DEFAULT_TREND_WINDOW,
  TREND_CACHE_TTL_MS,
  TREND_CANDIDATE_POOL_SIZE,
  TREND_RESULT_DEFAULT_LIMIT,
  TREND_RESULT_MAX_LIMIT,
  TREND_WINDOW_MS,
  type TrendWindow,
} from './hashtagTrendConfig';
import { countRawRecentPosts, deriveTrendScoreInput, scoreHashtagTrend } from './hashtagTrendLogic';

const CITY_HASHTAG_TRENDS_COLLECTION = 'cityHashtagTrends';

export type GetTrendingHashtagsOptions = {
  window?: TrendWindow;
  limit?: number;
};

/**
 * Ranks and caches the FULL bounded candidate pool for one (cityId,
 * window) up to TREND_RESULT_MAX_LIMIT results — a caller asking for
 * fewer (the common case) just slices this same cached array, so two
 * different `limit` values requested within the same TTL never trigger a
 * second Firestore read.
 */
const rankedTrendCache = new TtlCache<TrendingHashtag[]>(TREND_CACHE_TTL_MS);

function cacheKey(cityId: string, window: TrendWindow): string {
  return `${cityId}:${window}`;
}

async function computeTrendingHashtagsForCity(cityId: string, window: TrendWindow): Promise<TrendingHashtag[]> {
  if (!firestore) return [];
  const windowMs = TREND_WINDOW_MS[window];
  const nowMs = Date.now();

  const snapshot = await getDocs(
    query(
      collection(firestore, CITY_HASHTAG_TRENDS_COLLECTION),
      where('cityId', '==', cityId),
      orderBy('lastActivityAt', 'desc'),
      limit(TREND_CANDIDATE_POOL_SIZE)
    )
  );

  const scored = snapshot.docs.map((docSnapshot) => {
    const data = docSnapshot.data() as CityHashtagTrend;
    const recentPosts = data.recentPosts ?? [];
    const recentEngagement = data.recentEngagement ?? [];
    return {
      hashtag: data.hashtag,
      score: scoreHashtagTrend(deriveTrendScoreInput(recentPosts, recentEngagement, windowMs, nowMs)),
      recentPostCount: countRawRecentPosts(recentPosts, windowMs, nowMs),
    };
  });

  // TREND_MIN_RECENT_POSTS (enforced inside scoreHashtagTrend) already
  // means a candidate with too little recent activity scores exactly 0 —
  // filtered out here rather than shown as a zero-strength "trend" (Step
  // 20's own "do not fabricate trends" instruction: a small city with few
  // qualifying hashtags should simply show fewer trends, never padded
  // ones).
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, TREND_RESULT_MAX_LIMIT)
    .map((entry) => ({ hashtag: entry.hashtag, recentPostCount: entry.recentPostCount }));
}

/**
 * Public trending API — bounded, cached, fail-soft. Returns `[]` (never
 * throws) for a missing/empty `cityId`, an empty trend collection for
 * that city, or a genuine read failure (offline, transient error, ...) —
 * Search must never crash or show an intrusive error just because this
 * one discovery section couldn't load (same fail-soft philosophy as this
 * hashtag system's own Search-integration and ranking read paths).
 */
export async function getTrendingHashtagsForCity(cityId: string, options: GetTrendingHashtagsOptions = {}): Promise<TrendingHashtag[]> {
  if (!cityId) return [];
  const window = options.window ?? DEFAULT_TREND_WINDOW;
  const limitCount = Math.min(Math.max(1, options.limit ?? TREND_RESULT_DEFAULT_LIMIT), TREND_RESULT_MAX_LIMIT);
  const key = cacheKey(cityId, window);

  try {
    const cached = rankedTrendCache.getFresh(key);
    if (cached) return cached.slice(0, limitCount);

    const ranked = await rankedTrendCache.dedupe(key, () => computeTrendingHashtagsForCity(cityId, window));
    rankedTrendCache.set(key, ranked);
    return ranked.slice(0, limitCount);
  } catch {
    return [];
  }
}
