/**
 * Recommendation Engine — Step 3, Step 16 — a short-lived, per-uid,
 * in-memory cache in front of interestProfile.ts's fetchInterestProfile.
 * Within one feed session, Home's `getForYouReels` (initial load + every
 * `onEndReached` page) and the Events tab's `rankEventSections` each used
 * to call fetchInterestProfile independently, re-reading the SAME
 * document over and over even though nothing about it had changed since
 * the last read — this is what actually removes those redundant reads
 * (see this feature's own performance report for the before/after
 * numbers). Invalidated the moment a real interaction is persisted (see
 * interactions.ts) rather than kept fresh with a TTL that could serve a
 * stale profile right after the user just acted (Step 16's own "Do NOT
 * introduce stale state" instruction) — the lifetime below only matters
 * for how long a profile with NO new interactions stays cached.
 */
import type { RecommendationProfile } from '@/types/recommendation';

import { fetchInterestProfile } from './interestProfile';
import { PROFILE_CACHE_LIFETIME_MS } from './recommendationConfig';
import { isCacheFresh } from './reliability';

type CacheEntry = { profile: RecommendationProfile; fetchedAtMs: number };

const cache = new Map<string, CacheEntry>();

/** Same contract as fetchInterestProfile — always resolves (never throws for a brand-new/absent profile) — just backed by a short-lived cache first. */
export async function getCachedInterestProfile(uid: string, onboardingInterestIds: readonly string[] = []): Promise<RecommendationProfile> {
  const cached = cache.get(uid);
  if (cached && isCacheFresh(cached.fetchedAtMs, Date.now(), PROFILE_CACHE_LIFETIME_MS)) {
    return cached.profile;
  }
  const profile = await fetchInterestProfile(uid, onboardingInterestIds);
  cache.set(uid, { profile, fetchedAtMs: Date.now() });
  return profile;
}

/** Called right after a real interaction is persisted (see interactions.ts) so the NEXT read reflects it rather than serving a stale cached copy for up to PROFILE_CACHE_LIFETIME_MS. Safe to call for a uid with nothing cached (a no-op). */
export function invalidateInterestProfileCache(uid: string): void {
  cache.delete(uid);
}
