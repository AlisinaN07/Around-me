/**
 * The pure, Firestore-free half of Steps 4-5 (interest profile scoring +
 * time decay + cold start), plus the second pass's bounded-growth,
 * negative-feedback, and repeat-exposure tracking logic. Deliberately
 * dependency-free (only recommendationConfig.ts + types — no Firebase/
 * Firestore imports at all, unlike interestProfile.ts, which imports THIS
 * file and adds the actual read/write calls on top) so
 * tests/recommendations.test.ts can exercise the real scoring logic
 * directly without dragging in Firebase app initialization, which needs
 * the React Native runtime (`__DEV__`) this suite doesn't run under.
 */
import type { RecommendationAction, RecommendationProfile, TrackInteractionInput } from '@/types/recommendation';

import {
  CATEGORY_SCORE_MAX,
  CATEGORY_WEIGHT_OVERRIDES,
  CITY_SCORE_MAX,
  CITY_WEIGHT_OVERRIDES,
  CREATOR_SCORE_MAX,
  CREATOR_WEIGHT_OVERRIDES,
  DECAY_HALF_LIFE_DAYS,
  MAX_EXCLUDED_CONTENT_IDS,
  MAX_RECENT_IMPRESSIONS,
  MAX_RESPONDED_EVENT_IDS,
  MAX_STRONGLY_ENGAGED_CONTENT_IDS,
  MAX_TRACKED_CITIES,
  MAX_TRACKED_CREATORS,
  MIN_DECAY_INTERVAL_MS,
  SIGNAL_WEIGHTS,
  VIEW_ACTIONS,
} from './recommendationConfig';

/** A brand-new account's profile — every score starts at 0, nothing excluded/tracked yet. Cold start (Step 14) is handled separately by applyColdStartSeed below, not by anything here. */
export function emptyRecommendationProfile(now: number): Omit<RecommendationProfile, 'updatedAt'> & { updatedAt: null } {
  return {
    categoryScores: {},
    creatorScores: {},
    cityScores: {},
    excludedContentIds: [],
    recentImpressions: {},
    stronglyEngagedContentIds: [],
    respondedEventIds: [],
    interactionCount: 0,
    lastDecayAt: now,
    updatedAt: null,
  };
}

/** Caps a score map to its top N entries by |score| — the mechanism that keeps creatorScores/cityScores bounded forever (Step 4's own "bounded document" requirement) regardless of how many distinct creators/cities a long-lived account has ever touched. */
export function trimScoreMap(scores: Record<string, number>, maxEntries: number): Record<string, number> {
  const entries = Object.entries(scores);
  if (entries.length <= maxEntries) return scores;
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return Object.fromEntries(entries.slice(0, maxEntries));
}

/** Caps a recency-ordered list (newest-first) to its N most recent entries — the same shape excludedContentIds already used, reused for stronglyEngagedContentIds/respondedEventIds. */
function trimRecencyList(ids: string[], maxEntries: number): string[] {
  return ids.length <= maxEntries ? ids : ids.slice(0, maxEntries);
}

/** Caps `recentImpressions` to its N most-recently-seen entries — dropped by lastSeenAt (oldest first), never by count, since a content the viewer saw many times a LONG time ago is less relevant to today's exposure penalty than one seen a couple of times recently. */
function trimRecentImpressions(impressions: RecommendationProfile['recentImpressions'], maxEntries: number): RecommendationProfile['recentImpressions'] {
  const entries = Object.entries(impressions);
  if (entries.length <= maxEntries) return impressions;
  entries.sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

/**
 * Second pass, Step 9/10 — a bounded, diminishing-returns delta: the
 * closer `current` already is to the cap (`max` in its own direction),
 * the less additional room `weight` has to move it, asymptotically
 * approaching but never exceeding ±max. This is what actually prevents
 * many small repeated actions (twenty `open`s) from ever accumulating to
 * more than one strong action (`save`) would alone once `current` isn't
 * near zero anymore — plain unbounded addition has no such ceiling.
 * `weight` of 0 (e.g. `impression`) is always a true no-op.
 */
export function applyBoundedDelta(current: number, weight: number, max: number): number {
  if (weight === 0 || max <= 0) return current;
  if (weight > 0) {
    const room = Math.max(0, max - current);
    return current + weight * (room / max);
  }
  const room = Math.max(0, current + max);
  return current + weight * (room / max);
}

/** Resolves the weight ONE dimension (category/creator/city) should move by for a given action — an override if one exists for that dimension, else the shared SIGNAL_WEIGHTS default (Step 3's second-pass "different semantics per dimension" instruction — see CATEGORY_WEIGHT_OVERRIDES/CREATOR_WEIGHT_OVERRIDES' own doc comment). */
function resolveDimensionWeight(action: RecommendationAction, overrides: Partial<Record<RecommendationAction, number>>): number {
  return overrides[action] ?? SIGNAL_WEIGHTS[action];
}

/**
 * Simple exponential decay — halves every DECAY_HALF_LIFE_DAYS of elapsed
 * wall-clock time since this profile's last decay pass (Step 5). Applied
 * to every category/creator/city score uniformly (creator affinity decays
 * the same way — Step 10's own "creator affinity should also decay over
 * time"). A no-op (returns the same object) when less than
 * MIN_DECAY_INTERVAL_MS has passed, so an app opened several times an
 * hour doesn't recompute this pointlessly on every single read.
 */
export function applyDecay(profile: RecommendationProfile, nowMs: number): RecommendationProfile {
  const elapsedMs = nowMs - profile.lastDecayAt;
  if (elapsedMs < MIN_DECAY_INTERVAL_MS) return profile;

  const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);
  const decayFactor = Math.pow(0.5, elapsedDays / DECAY_HALF_LIFE_DAYS);
  const decayMap = (scores: Record<string, number>): Record<string, number> => {
    const next: Record<string, number> = {};
    for (const [key, value] of Object.entries(scores)) {
      const decayed = value * decayFactor;
      // Drop scores that have decayed to near-nothing rather than keeping
      // an ever-growing map of negligible entries around forever.
      if (Math.abs(decayed) >= 0.01) next[key] = decayed;
    }
    return next;
  };

  return {
    ...profile,
    categoryScores: decayMap(profile.categoryScores),
    creatorScores: decayMap(profile.creatorScores),
    cityScores: decayMap(profile.cityScores),
    lastDecayAt: nowMs,
  };
}

/**
 * The core Step 4 update rule — one interaction moves category, creator,
 * and city scores by a per-dimension weight (see resolveDimensionWeight),
 * applied through applyBoundedDelta so growth is bounded and diminishing
 * rather than unbounded linear addition, folded through decay first so an
 * old, stale profile doesn't let ancient interactions dominate a fresh
 * one (Step 5).
 *
 * Second pass additions on top of the first version:
 *  - `impression` no longer increments `interactionCount` — a passive
 *    view (weight 0 everywhere) isn't a real behavioral signal, and
 *    counting it would end Step 14 cold-start seeding after the very
 *    first scroll rather than after real preference signal exists.
 *  - `impression` records a recentImpressions entry (Step 4 repeat-
 *    exposure tracking).
 *  - `rewatch`/`complete`/`save`/`share` record the content into
 *    stronglyEngagedContentIds (exempts it from the exposure penalty).
 *  - `event_interested`/`event_going` record the content into
 *    respondedEventIds (Step 8's "don't let a Going event keep
 *    dominating discovery").
 */
export function applyInteractionToProfile(
  profile: RecommendationProfile,
  input: Pick<TrackInteractionInput, 'action' | 'categoryId' | 'creatorId' | 'cityKey' | 'contentId'>,
  nowMs: number
): RecommendationProfile {
  const decayed = applyDecay(profile, nowMs);

  const categoryScores = { ...decayed.categoryScores };
  if (input.categoryId) {
    const weight = resolveDimensionWeight(input.action, CATEGORY_WEIGHT_OVERRIDES);
    categoryScores[input.categoryId] = applyBoundedDelta(categoryScores[input.categoryId] ?? 0, weight, CATEGORY_SCORE_MAX);
  }

  const creatorScores = { ...decayed.creatorScores };
  if (input.creatorId) {
    const weight = resolveDimensionWeight(input.action, CREATOR_WEIGHT_OVERRIDES);
    creatorScores[input.creatorId] = applyBoundedDelta(creatorScores[input.creatorId] ?? 0, weight, CREATOR_SCORE_MAX);
  }

  const cityScores = { ...decayed.cityScores };
  if (input.cityKey) {
    // Recommendation Engine — Step 3, Step 4 — city now has its own
    // per-dimension weight table (CITY_WEIGHT_OVERRIDES), same mechanism
    // category/creator already used — see that const's own doc comment
    // for why e.g. `follow`/`event_going` move a city's score harder than
    // a plain SIGNAL_WEIGHTS lookup would.
    const weight = resolveDimensionWeight(input.action, CITY_WEIGHT_OVERRIDES);
    cityScores[input.cityKey] = applyBoundedDelta(cityScores[input.cityKey] ?? 0, weight, CITY_SCORE_MAX);
  }

  let excludedContentIds = decayed.excludedContentIds;
  if (input.action === 'not_interested' && input.contentId) {
    excludedContentIds = trimRecencyList([input.contentId, ...excludedContentIds.filter((id) => id !== input.contentId)], MAX_EXCLUDED_CONTENT_IDS);
  }

  let recentImpressions = decayed.recentImpressions;
  // Recommendation Engine — Step 3, Step 13 — any real content VIEW
  // (not just the literal 'impression' action) counts toward repeat-
  // exposure bookkeeping — see VIEW_ACTIONS' own doc comment for why
  // `impression` itself no longer runs its own transaction at all in the
  // real app (interactions.ts), folding this bump into whichever single
  // watch-summary action that same viewing actually produced instead.
  if (VIEW_ACTIONS.has(input.action) && input.contentId) {
    const existing = recentImpressions[input.contentId];
    recentImpressions = trimRecentImpressions(
      { ...recentImpressions, [input.contentId]: { count: (existing?.count ?? 0) + 1, lastSeenAt: nowMs } },
      MAX_RECENT_IMPRESSIONS
    );
  }

  let stronglyEngagedContentIds = decayed.stronglyEngagedContentIds;
  const isStrongEngagementAction = input.action === 'rewatch' || input.action === 'complete' || input.action === 'save' || input.action === 'share';
  if (isStrongEngagementAction && input.contentId && !stronglyEngagedContentIds.includes(input.contentId)) {
    stronglyEngagedContentIds = trimRecencyList([input.contentId, ...stronglyEngagedContentIds], MAX_STRONGLY_ENGAGED_CONTENT_IDS);
  }

  let respondedEventIds = decayed.respondedEventIds;
  if ((input.action === 'event_interested' || input.action === 'event_going') && input.contentId && !respondedEventIds.includes(input.contentId)) {
    respondedEventIds = trimRecencyList([input.contentId, ...respondedEventIds], MAX_RESPONDED_EVENT_IDS);
  }

  return {
    categoryScores: trimScoreMap(categoryScores, 200), // generous — real catalog is ~18 IDs
    creatorScores: trimScoreMap(creatorScores, MAX_TRACKED_CREATORS),
    cityScores: trimScoreMap(cityScores, MAX_TRACKED_CITIES),
    excludedContentIds,
    recentImpressions,
    stronglyEngagedContentIds,
    respondedEventIds,
    // A passive impression isn't real behavioral signal — see this
    // function's own doc comment on why it's excluded from this count.
    interactionCount: input.action === 'impression' ? decayed.interactionCount : decayed.interactionCount + 1,
    lastDecayAt: decayed.lastDecayAt,
    updatedAt: decayed.updatedAt,
  };
}

/** Parses a raw Firestore document (or `null`, for a brand-new account) into a well-formed RecommendationProfile, filling in defaults for anything missing — the "legacy/absent doc" tolerance this app's other normalize* functions (e.g. normalizeReel) already follow. */
export function toProfile(data: unknown, nowMs: number): RecommendationProfile {
  if (!data || typeof data !== 'object') {
    return emptyRecommendationProfile(nowMs) as unknown as RecommendationProfile;
  }
  const raw = data as Partial<RecommendationProfile>;
  return {
    categoryScores: raw.categoryScores ?? {},
    creatorScores: raw.creatorScores ?? {},
    cityScores: raw.cityScores ?? {},
    excludedContentIds: raw.excludedContentIds ?? [],
    recentImpressions: raw.recentImpressions ?? {},
    stronglyEngagedContentIds: raw.stronglyEngagedContentIds ?? [],
    respondedEventIds: raw.respondedEventIds ?? [],
    interactionCount: raw.interactionCount ?? 0,
    lastDecayAt: raw.lastDecayAt ?? nowMs,
    updatedAt: raw.updatedAt as RecommendationProfile['updatedAt'],
  };
}

/**
 * Step 14 cold start — a modest positive nudge (well under a single
 * `like`'s +3) applied to each of the caller's onboarding interests
 * (`users/{uid}.interests`) the FIRST time their profile is read, before
 * any real behavioral signal exists. Seeded directly into categoryScores
 * itself (rather than threaded as a separate parameter through every
 * scoring/bucketing call site) so scoreInterest/classifyBucket both
 * naturally reflect it with no special-case code. Never applied once
 * `interactionCount > 0` — real behavior takes over entirely from that
 * point on, exactly as Step 14 asks for.
 */
const COLD_START_CATEGORY_SEED = 5;

export function applyColdStartSeed(profile: RecommendationProfile, onboardingInterestIds: readonly string[]): RecommendationProfile {
  if (profile.interactionCount > 0 || Object.keys(profile.categoryScores).length > 0 || onboardingInterestIds.length === 0) {
    return profile;
  }
  const categoryScores: Record<string, number> = {};
  for (const id of onboardingInterestIds) categoryScores[id] = COLD_START_CATEGORY_SEED;
  return { ...profile, categoryScores };
}
