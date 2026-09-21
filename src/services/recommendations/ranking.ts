/**
 * Pure scoring functions (Steps 7-11) — no Firestore, no React, fully
 * unit-testable (see tests/recommendations.test.ts). candidateGenerator.ts
 * fetches the raw candidates; recommendationEngine.ts calls these to turn
 * each one into a comparable score and hands the result to diversity.ts.
 *
 * finalScore is a WEIGHTED SUM (see RANKING_WEIGHTS's own doc comment for
 * why addition over multiplication), where every individual signal below
 * is first squashed into a smooth, bounded, comparable range via
 * `sigmoid` — an unbounded raw interest/creator score (which can grow
 * arbitrarily with account age) never lets one dimension silently swamp
 * every other one just because its raw numbers happen to be bigger.
 */
import { HASHTAG_MATCH_DECAY, HASHTAG_RANKING_MATCH_CAP, HASHTAG_RELEVANCE_WEIGHT } from './hashtagInterestConfig';
import {
  EVENT_FRESHNESS_HALF_LIFE_HOURS,
  EVENT_LOCATION_WEIGHT_MULTIPLIER,
  EVENT_TIME_SCORE,
  EXPOSURE_PENALTY_BY_COUNT,
  EXPOSURE_PENALTY_FLOOR,
  FRESHNESS_HALF_LIFE_HOURS,
  LOCATION_SCORE,
  LOCATION_SECONDARY_CITY_BONUS_MAX,
  LOCATION_WORLD_AFFINITY_BONUS_MAX,
  NEW_CONTENT_BOOST,
  NEW_CONTENT_GRACE_HOURS,
  POPULARITY_PRIOR_SCORE,
  POPULARITY_PRIOR_WEIGHT,
  RANKING_WEIGHTS,
  RESPONDED_EVENT_DISCOVERY_MULTIPLIER,
  SECONDARY_CITY_AFFINITY_THRESHOLD,
} from './recommendationConfig';
import {
  EVENT_QUALITY_COMPONENT_WEIGHTS,
  EVENT_QUALITY_CONFIDENCE_K,
  EVENT_QUALITY_RATE_PRIORS,
  QUALITY_COMPONENT_WEIGHTS,
  QUALITY_CONFIDENCE_K,
  QUALITY_PRIOR_AVERAGE_WATCH_PERCENT,
  QUALITY_RATE_DENOMINATOR_FLOOR,
  QUALITY_RATE_PRIORS,
  QUALITY_SHORT_VIDEO_MIN_CREDIT,
  QUALITY_SHORT_VIDEO_REFERENCE_MS,
} from './qualityConfig';
import { COLLABORATIVE_MIN_CONFIDENCE_TO_APPLY, COLLABORATIVE_WEIGHT } from './collaborativeConfig';
import type { CollaborativeProfile } from '@/types/collaborative';
import type { ContentEngagementStats } from '@/types/engagementStats';
import type { RecommendationProfile } from '@/types/recommendation';
import type { BrowseScope } from '@/types/browseScope';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Maps any real number to (0,1), 0.5 at x=0 — the shared normalizer every raw/unbounded signal below goes through before being weighted-summed. `scale` is "how big a raw value needs to be to feel like a strong signal" for that particular score. */
export function sigmoid(x: number, scale: number): number {
  return 1 / (1 + Math.exp(-x / scale));
}

/** Step 7 interest score — how much the viewer's own profile likes this item's category. Centered at 0.5 (no signal yet, e.g. cold start) rather than 0, so an unknown category isn't scored as "actively disliked". */
export function scoreInterest(categoryId: string, profile: RecommendationProfile): number {
  const raw = profile.categoryScores[categoryId] ?? 0;
  return sigmoid(raw, 15);
}

/** Step 7 creator/business affinity — profile score plus a flat boost for an actually-followed account (a deliberate, explicit relationship, not just an inferred one). */
export function scoreCreatorAffinity(creatorId: string, profile: RecommendationProfile, isFollowing: boolean): number {
  const raw = (profile.creatorScores[creatorId] ?? 0) + (isFollowing ? 10 : 0);
  return sigmoid(raw, 15);
}

/**
 * Recommendation Engine — Step 3, Steps 2/5 — turns the profile's raw,
 * unbounded `cityScores` (see CITY_SCORE_MAX — bounded to ±40, but not on
 * any shared 0-1 scale other scores use) into a 0-1 affinity RELATIVE to
 * the viewer's own single strongest tracked city, e.g. `{ karlstad: 1,
 * stockholm: 0.61, goteborg: 0.18 }` for the spec's own literal example —
 * so "how much does this person care about city X" reads consistently
 * regardless of how large or small their raw scores happen to be (a
 * brand-new account and a year-old one should both be able to have a
 * clear #1/#2/#3 city ordering). Cities with a non-positive score are
 * dropped entirely (a NEGATIVE city score — extremely rare in practice,
 * since almost every SIGNAL_WEIGHTS/CITY_WEIGHT_OVERRIDES entry is
 * zero-or-positive — should never read as a "secondary affinity bonus").
 * Empty input (a cold-start profile with no city history yet) returns
 * `{}`, which scoreLocation below treats as "no bonus anywhere" — correct
 * cold-start behavior, since BrowseScope/home-city alone already decide
 * ranking at that point.
 */
export function normalizeCityAffinity(cityScores: Record<string, number>): Record<string, number> {
  let max = 0;
  for (const score of Object.values(cityScores)) {
    if (score > max) max = score;
  }
  if (max <= 0) return {};
  const normalized: Record<string, number> = {};
  for (const [cityKey, score] of Object.entries(cityScores)) {
    if (score > 0) normalized[cityKey] = score / max;
  }
  return normalized;
}

/**
 * Recommendation Engine — Step 3, Step 17/18 — the single learned
 * "secondary city" candidate generation is allowed to enrich a pool
 * with, or null when none qualifies. Deliberately picks at most ONE
 * (MAX_LEARNED_SECONDARY_CITIES's own doc comment) — the single highest-
 * affinity city that (a) isn't already the scope/home city itself and
 * (b) clears SECONDARY_CITY_AFFINITY_THRESHOLD — never a whole ranked
 * list, so a caller can never accidentally loop this into N queries.
 * Only meaningful under a single-city scope (`'city'`) — Step 3's own
 * hierarchy: under 'country'/'world' scope the query itself already
 * spans multiple cities, so there is nothing for a SEPARATE enrichment
 * query to add; scoreLocation's own affinity bonus still applies to
 * whatever the scope's normal query already returned.
 */
export function pickSecondaryCity(scope: BrowseScope, normalizedCityAffinity: Record<string, number>): string | null {
  if (scope.kind !== 'city') return null;
  let best: string | null = null;
  let bestAffinity = SECONDARY_CITY_AFFINITY_THRESHOLD;
  for (const [cityKey, affinity] of Object.entries(normalizedCityAffinity)) {
    if (cityKey === scope.cityKey) continue;
    if (affinity >= bestAffinity) {
      best = cityKey;
      bestAffinity = affinity;
    }
  }
  return best;
}

/**
 * Step 8 location relevance, extended (Recommendation Engine — Step 3,
 * Steps 2/3) with LEARNED city affinity on top of the explicit-scope
 * hierarchy — reusing this app's own BrowseScope rather than GPS. When
 * the active scope is itself 'country'/'cities'/'world', "same city" just
 * means "matches one of the scope's own cities" so a Country/Worldwide
 * browse doesn't unfairly rank everything as merely "same-country"
 * relative to the user's true HOME city.
 *
 * `normalizedCityAffinity` (see normalizeCityAffinity above) adds a small
 * bonus for a candidate in the viewer's own learned secondary city — but
 * BrowseScope always remains the strongest constraint (Step 3's own "Do
 * NOT let learned affinity override the user's explicitly selected
 * BrowseScope"): every branch below clamps the result so a secondary-city
 * bonus can narrow the gap toward `sameCity` but never reach or exceed
 * it, meaning an explicit same-city match ALWAYS outranks a
 * secondary-city one on this dimension alone, no matter how strong that
 * learned affinity is.
 */
export function scoreLocation(
  itemCityKey: string,
  itemCountryCode: string,
  scope: BrowseScope,
  homeCityKey: string,
  // Accepted for symmetry/future use (e.g. weighting the user's real home
  // country above other same-scope countries) but not needed by the cases
  // below yet.
  _homeCountryCode: string,
  normalizedCityAffinity: Record<string, number> = {}
): number {
  const secondaryBonus = (maxBonus: number, alreadyScoredCityKey?: string): number => {
    if (itemCityKey === alreadyScoredCityKey) return 0; // already at the top tier via the explicit match below — never double-counted
    const affinity = normalizedCityAffinity[itemCityKey] ?? 0;
    return affinity >= SECONDARY_CITY_AFFINITY_THRESHOLD ? maxBonus * affinity : 0;
  };
  // Never allowed to reach (let alone exceed) a genuine same-city match —
  // see this function's own doc comment on why BrowseScope always wins.
  const capBelowSameCity = (value: number): number => Math.min(LOCATION_SCORE.sameCity - 0.01, value);

  if (scope.kind === 'world') {
    // Step 3 — "mild bonus... should not heavily restrict discovery":
    // deliberately the smallest bonus ceiling of the three, and applies
    // to ANY city with real affinity (home city included), never just a
    // secondary one — a world browse has no single "explicit" city to
    // protect against being overridden.
    return capBelowSameCity(LOCATION_SCORE.worldwide + secondaryBonus(LOCATION_WORLD_AFFINITY_BONUS_MAX));
  }
  if (scope.kind === 'city') {
    if (itemCityKey === scope.cityKey) return LOCATION_SCORE.sameCity;
    return capBelowSameCity(LOCATION_SCORE.worldwide + secondaryBonus(LOCATION_SECONDARY_CITY_BONUS_MAX, scope.cityKey));
  }
  if (scope.kind === 'cities') {
    if (scope.cityKeys.includes(itemCityKey)) return LOCATION_SCORE.sameCity;
    return capBelowSameCity(LOCATION_SCORE.worldwide + secondaryBonus(LOCATION_SECONDARY_CITY_BONUS_MAX));
  }
  // 'country' scope
  if (itemCountryCode === scope.countryCode) {
    if (itemCityKey === homeCityKey) return LOCATION_SCORE.sameCity;
    // Step 3 — "learned preferred cities inside the country -> boosted":
    // a learned secondary city inside the same country moves up from the
    // flat sameCountry tier toward (never reaching) sameCity.
    return capBelowSameCity(LOCATION_SCORE.sameCountry + secondaryBonus(LOCATION_SECONDARY_CITY_BONUS_MAX, homeCityKey));
  }
  return LOCATION_SCORE.worldwide;
}

/** Step 10 freshness — exponential decay by age since publish, same shape as interestProfile.ts's own decay but on a much shorter (hours, not weeks) half-life. Evergreen content never hits 0, just keeps shrinking. */
export function scoreFreshness(publishedAtMs: number, nowMs: number, halfLifeHours = FRESHNESS_HALF_LIFE_HOURS): number {
  const ageHours = Math.max(0, (nowMs - publishedAtMs) / HOUR_MS);
  return Math.pow(0.5, ageHours / halfLifeHours);
}

/** Step 15 — new content cold start: a temporary, tapering boost for anything published within the last NEW_CONTENT_GRACE_HOURS, independent of scoreFreshness's own longer-range curve, so a brand new post with zero engagement still gets a real shot at being seen rather than needing existing popularity it can't have yet. */
export function scoreNewContentBoost(publishedAtMs: number, nowMs: number): number {
  const ageHours = (nowMs - publishedAtMs) / HOUR_MS;
  if (ageHours < 0 || ageHours > NEW_CONTENT_GRACE_HOURS) return 0;
  return NEW_CONTENT_BOOST * (1 - ageHours / NEW_CONTENT_GRACE_HOURS);
}

export type EventTimeResult = { score: number; excluded: boolean };

/**
 * Step 9 — event time relevance. `null`/excluded once the event has
 * already ended (endsAt in the past) regardless of any other score — an
 * ended event never belongs in a forward-looking recommendation feed.
 * Otherwise scores higher the sooner it starts, floored (not zeroed) for
 * anything further out so a genuinely great, well-matched event three
 * weeks out doesn't vanish entirely — the OTHER scores (interest,
 * location, popularity) still apply on top of this.
 */
export function scoreEventTime(startsAtMs: number, endsAtMs: number, nowMs: number): EventTimeResult {
  if (endsAtMs < nowMs) return { score: 0, excluded: true };
  if (startsAtMs <= nowMs) return { score: EVENT_TIME_SCORE.startingSoonScore, excluded: false }; // happening now
  const hoursUntilStart = (startsAtMs - nowMs) / HOUR_MS;
  if (hoursUntilStart <= EVENT_TIME_SCORE.startingSoonHours) return { score: EVENT_TIME_SCORE.startingSoonScore, excluded: false };
  if (hoursUntilStart <= EVENT_TIME_SCORE.tomorrowHours) return { score: EVENT_TIME_SCORE.tomorrowScore, excluded: false };
  const daysUntilStart = hoursUntilStart / 24;
  if (daysUntilStart <= EVENT_TIME_SCORE.thisWeekendDays) return { score: EVENT_TIME_SCORE.thisWeekendScore, excluded: false };
  if (daysUntilStart >= EVENT_TIME_SCORE.laterDaysFloor) return { score: EVENT_TIME_SCORE.laterScoreFloor, excluded: false };
  // Linear taper between "this weekend" and the far-out floor.
  const span = EVENT_TIME_SCORE.laterDaysFloor - EVENT_TIME_SCORE.thisWeekendDays;
  const progress = (daysUntilStart - EVENT_TIME_SCORE.thisWeekendDays) / span;
  const score = EVENT_TIME_SCORE.thisWeekendScore - progress * (EVENT_TIME_SCORE.thisWeekendScore - EVENT_TIME_SCORE.laterScoreFloor);
  return { score, excluded: false };
}

/** Event posting freshness uses the same shape as scoreFreshness but a shorter half-life — a stale-feeling event LISTING is a worse experience than a stale-feeling Reel (Step 10's own "Events should use stricter freshness rules"). This is separate from scoreEventTime (which is about when the event itself happens, not when it was posted). */
export function scoreEventFreshness(createdAtMs: number, nowMs: number): number {
  return scoreFreshness(createdAtMs, nowMs, EVENT_FRESHNESS_HALF_LIFE_HOURS);
}

/**
 * Step 11 popularity/quality — from whatever cheap engagement counts are
 * passed in (see ranking's own doc comment at the top of this file:
 * deliberately computed for only a small final page-sized set of
 * candidates, via the existing per-item getCountFromServer helpers this
 * app already has — reels/{id}/likes, reels/{id}/comments — never a
 * denormalized counter added to every candidate in the pool). Log-scaled
 * so a handful of huge accounts can't make every other candidate's
 * popularity look like zero (Step 11's own "avoid letting huge accounts
 * dominate" instruction) — this deliberately does NOT use follower count
 * at all, only actual engagement on THIS item.
 *
 * Second pass, Step 6 — Bayesian-style shrinkage toward
 * POPULARITY_PRIOR_SCORE (a neutral 0.5) on top of that raw sigmoid: the
 * fewer total engagement events observed, the more the raw score gets
 * pulled back toward "we don't know yet" rather than trusted outright.
 * This is what makes "1 view + 1 like" read as roughly neutral instead of
 * "highest rated" (Step 6's own literal example) — `confidence` only
 * approaches 1 once engagement is well past POPULARITY_PRIOR_WEIGHT.
 * There's no real per-content VIEW count to compute a true engagement
 * RATE from yet (see this feature's own final report, Step 7) — this is
 * the safest thing to do with the engagement COUNTS that are actually,
 * cheaply available today.
 */
export function scorePopularity(likeCount: number, commentCount: number): number {
  const engagement = likeCount + commentCount * 2; // a comment is a stronger signal than a like
  const rawScore = sigmoid(Math.log1p(engagement) - Math.log1p(3), 1.5); // centered so ~3 engagements reads as "average"
  const confidence = engagement / (engagement + POPULARITY_PRIOR_WEIGHT);
  return POPULARITY_PRIOR_SCORE + confidence * (rawScore - POPULARITY_PRIOR_SCORE);
}

/**
 * Recommendation Engine — Step 4, Step 16 — the one Bayesian-smoothing
 * primitive every rate in scoreContentQuality/scoreEventQuality below is
 * built from: `(successes + priorRate*priorWeight) / (samples + priorWeight)`.
 * With zero real samples this returns exactly `priorRate` (pure prior, no
 * data yet); as `samples` grows relative to `priorWeight`, it converges on
 * the true empirical rate `successes/samples`. Deliberately generic/
 * reusable rather than one bespoke shrinkage formula per rate — "keep the
 * math understandable" (Step 16's own instruction).
 */
export function smoothedRate(successes: number, samples: number, priorRate: number, priorWeight: number): number {
  const safeSamples = Math.max(0, samples);
  return (Math.max(0, successes) + priorRate * priorWeight) / (safeSamples + priorWeight);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Recommendation Engine — Step 4, Steps 15/17/18 — the trusted-stats
 * content-QUALITY score for a Reel/Post, replacing scorePopularity's raw-
 * count formula wherever real ContentEngagementStats exist (see
 * computeItemScore's own fallback hierarchy below). Every individual RATE
 * is first Bayesian-smoothed (Step 16, via smoothedRate) against a modest
 * neutral prior, THEN the whole composite is blended toward a dynamically
 * computed neutral composite by an overall sample-size confidence (Step
 * 17) — two independent layers of shrinkage, both explicitly asked for: the
 * first keeps any ONE rate (e.g. a fluke 1-like-out-of-2-views) from
 * reading as 100%; the second keeps a composite built from a handful of
 * views from reading as confidently as one built from thousands (Step
 * 17's own literal "5 views/90%" vs "5,000 views/90%" example).
 *
 * `hasVideo` (true only for Reels) gates the watch/completion terms
 * entirely — a text Post has no watch concept at all, and including
 * those terms anyway would inject a phantom prior-driven value from a
 * `watchSampleCount` of 0 rather than correctly contributing nothing.
 * `videoDurationMs`, when known, dampens completionQuality for very short
 * videos (Step 18's own "avoid over-rewarding extremely short videos
 * simply because completion is easy").
 *
 * IMPORTANT — the overall Step 17 confidence blend targets a DYNAMICALLY
 * computed neutral composite (this exact formula, evaluated with every
 * rate at its own smoothedRate prior — see computeCompositeQuality below),
 * never a fixed constant like 0.5: this composite is a direct weighted SUM
 * of rates typically well under 1 (see QUALITY_COMPONENT_WEIGHTS' own doc
 * comment — the realistic ceiling is nowhere near 1.0), so blending a
 * tiny/no-sample item toward an unrelated fixed 0.5 would make it read as
 * MORE trustworthy-looking than almost any real, well-measured content —
 * exactly backwards from Step 17's own intent.
 */
function computeCompositeQuality(
  likeRate: number,
  commentRate: number,
  saveRate: number,
  shareRate: number,
  notInterestedRate: number,
  hasVideo: boolean,
  averageWatchPercent: number,
  completionQuality: number
): number {
  let composite =
    saveRate * QUALITY_COMPONENT_WEIGHTS.save +
    shareRate * QUALITY_COMPONENT_WEIGHTS.share +
    likeRate * QUALITY_COMPONENT_WEIGHTS.like +
    commentRate * QUALITY_COMPONENT_WEIGHTS.comment -
    notInterestedRate * QUALITY_COMPONENT_WEIGHTS.notInterestedPenalty;
  if (hasVideo) {
    composite += averageWatchPercent * QUALITY_COMPONENT_WEIGHTS.watch + completionQuality * QUALITY_COMPONENT_WEIGHTS.completion;
  }
  return composite;
}

export function scoreContentQuality(stats: ContentEngagementStats, hasVideo: boolean, videoDurationMs?: number): number {
  // Step 14 — prefer meaningfulViews (a real engaged look) over raw
  // impressions (could be nothing but an accidental scroll-through) as
  // the rate denominator; fall back to impressions only when there are
  // truly zero meaningful views yet, so a real negative signal (e.g. a
  // high not-interested rate from lots of quick-skips) isn't understated
  // by treating "no meaningful views" the same as "no data at all".
  const sampleBasis = stats.meaningfulViews > 0 ? stats.meaningfulViews : stats.impressions;
  const rateDenominator = Math.max(QUALITY_RATE_DENOMINATOR_FLOOR, sampleBasis);

  const likeRate = smoothedRate(stats.likes, rateDenominator, QUALITY_RATE_PRIORS.like.priorRate, QUALITY_RATE_PRIORS.like.priorWeight);
  const commentRate = smoothedRate(stats.comments, rateDenominator, QUALITY_RATE_PRIORS.comment.priorRate, QUALITY_RATE_PRIORS.comment.priorWeight);
  const saveRate = smoothedRate(stats.saves, rateDenominator, QUALITY_RATE_PRIORS.save.priorRate, QUALITY_RATE_PRIORS.save.priorWeight);
  const shareRate = smoothedRate(stats.shares, rateDenominator, QUALITY_RATE_PRIORS.share.priorRate, QUALITY_RATE_PRIORS.share.priorWeight);
  const notInterestedRate = smoothedRate(
    stats.notInterestedCount,
    rateDenominator,
    QUALITY_RATE_PRIORS.notInterested.priorRate,
    QUALITY_RATE_PRIORS.notInterested.priorWeight
  );

  const averageWatchPercent = stats.watchSampleCount > 0 ? clamp01(stats.totalWatchPercent / stats.watchSampleCount) : 0;
  const rawCompletionRate = smoothedRate(
    stats.completions,
    Math.max(QUALITY_RATE_DENOMINATOR_FLOOR, stats.watchSampleCount),
    QUALITY_RATE_PRIORS.completion.priorRate,
    QUALITY_RATE_PRIORS.completion.priorWeight
  );
  const durationFactor =
    videoDurationMs != null && videoDurationMs > 0
      ? QUALITY_SHORT_VIDEO_MIN_CREDIT + (1 - QUALITY_SHORT_VIDEO_MIN_CREDIT) * Math.min(1, videoDurationMs / QUALITY_SHORT_VIDEO_REFERENCE_MS)
      : 1;
  const completionQuality = rawCompletionRate * durationFactor;

  const measuredQuality = clamp01(
    computeCompositeQuality(likeRate, commentRate, saveRate, shareRate, notInterestedRate, hasVideo, averageWatchPercent, completionQuality)
  );

  // The SAME formula, evaluated with every rate at its own zero-sample
  // prior (what smoothedRate already returns at samples=0) and a
  // configured assumed "typical" watch percent — this IS "no real data
  // yet" in this composite's own units, computed once so a config change
  // to any prior/weight automatically keeps this consistent without a
  // second hand-maintained constant.
  const priorQuality = clamp01(
    computeCompositeQuality(
      QUALITY_RATE_PRIORS.like.priorRate,
      QUALITY_RATE_PRIORS.comment.priorRate,
      QUALITY_RATE_PRIORS.save.priorRate,
      QUALITY_RATE_PRIORS.share.priorRate,
      QUALITY_RATE_PRIORS.notInterested.priorRate,
      hasVideo,
      QUALITY_PRIOR_AVERAGE_WATCH_PERCENT,
      QUALITY_RATE_PRIORS.completion.priorRate
    )
  );

  // Step 17 — confidence must track the SAME sample basis the rates
  // above actually used (`sampleBasis`, before the denominator floor —
  // NOT raw `impressions` once meaningfulViews exists), plus
  // watchSampleCount when video terms are in play. Using an unrelated,
  // always-larger number here (e.g. raw impressions even when the rates
  // were computed from a much smaller meaningfulViews count) would let a
  // high-impression/low-engagement item borrow false confidence from
  // impressions it never actually used to compute its own rates.
  const sampleSize = Math.max(sampleBasis, stats.watchSampleCount);
  const confidence = sampleSize / (sampleSize + QUALITY_CONFIDENCE_K);
  return priorQuality * (1 - confidence) + measuredQuality * confidence;
}

/**
 * Recommendation Engine — Step 4, Step 19 — Events get a DIFFERENT
 * composite entirely: no watch/completion terms at all (irrelevant for an
 * Event with no associated video), and `eventOpens` (not `impressions`,
 * which Events never generate today — see EVENT_QUALITY_RATE_PRIORS' own
 * doc comment) is both the rate denominator and the confidence sample
 * size. Same two-layer Bayesian-smoothing + overall-confidence shape as
 * scoreContentQuality above, just over a different, event-specific set of
 * signals (interested/going/save/share/not-interested).
 */
function computeEventCompositeQuality(interestedRate: number, goingRate: number, saveRate: number, shareRate: number, notInterestedRate: number): number {
  return (
    interestedRate * EVENT_QUALITY_COMPONENT_WEIGHTS.interested +
    goingRate * EVENT_QUALITY_COMPONENT_WEIGHTS.going +
    saveRate * EVENT_QUALITY_COMPONENT_WEIGHTS.save +
    shareRate * EVENT_QUALITY_COMPONENT_WEIGHTS.share -
    notInterestedRate * EVENT_QUALITY_COMPONENT_WEIGHTS.notInterestedPenalty
  );
}

export function scoreEventQuality(stats: ContentEngagementStats): number {
  const rateDenominator = Math.max(QUALITY_RATE_DENOMINATOR_FLOOR, stats.eventOpens);

  const interestedRate = smoothedRate(
    stats.eventInterested,
    rateDenominator,
    EVENT_QUALITY_RATE_PRIORS.interested.priorRate,
    EVENT_QUALITY_RATE_PRIORS.interested.priorWeight
  );
  const goingRate = smoothedRate(stats.eventGoing, rateDenominator, EVENT_QUALITY_RATE_PRIORS.going.priorRate, EVENT_QUALITY_RATE_PRIORS.going.priorWeight);
  const saveRate = smoothedRate(stats.saves, rateDenominator, EVENT_QUALITY_RATE_PRIORS.save.priorRate, EVENT_QUALITY_RATE_PRIORS.save.priorWeight);
  const shareRate = smoothedRate(stats.shares, rateDenominator, EVENT_QUALITY_RATE_PRIORS.share.priorRate, EVENT_QUALITY_RATE_PRIORS.share.priorWeight);
  const notInterestedRate = smoothedRate(
    stats.notInterestedCount,
    rateDenominator,
    EVENT_QUALITY_RATE_PRIORS.notInterested.priorRate,
    EVENT_QUALITY_RATE_PRIORS.notInterested.priorWeight
  );

  const measuredQuality = clamp01(computeEventCompositeQuality(interestedRate, goingRate, saveRate, shareRate, notInterestedRate));
  // Same "dynamically computed neutral point" reasoning as
  // scoreContentQuality above — every rate at its own zero-sample prior.
  const priorQuality = clamp01(
    computeEventCompositeQuality(
      EVENT_QUALITY_RATE_PRIORS.interested.priorRate,
      EVENT_QUALITY_RATE_PRIORS.going.priorRate,
      EVENT_QUALITY_RATE_PRIORS.save.priorRate,
      EVENT_QUALITY_RATE_PRIORS.share.priorRate,
      EVENT_QUALITY_RATE_PRIORS.notInterested.priorRate
    )
  );

  const confidence = stats.eventOpens / (stats.eventOpens + EVENT_QUALITY_CONFIDENCE_K);
  return priorQuality * (1 - confidence) + measuredQuality * confidence;
}

/**
 * Second pass, Step 4 — repeat-exposure penalty, a MULTIPLIER (not an
 * additive score term) applied to the final weighted-sum score. `hasStrongEngagement`
 * (the viewer previously rewatched/completed/saved/shared THIS exact
 * content — see RecommendationProfile.stronglyEngagedContentIds) fully
 * exempts it: a saved favorite should be allowed to resurface regardless
 * of how many times it's already been shown. Otherwise the multiplier
 * shrinks with each additional recent impression, floored (never fully
 * zeroed — that's what not_interested/excludedContentIds is for, a
 * DIFFERENT, stronger mechanism) at EXPOSURE_PENALTY_FLOOR.
 */
export function scoreRepeatExposurePenalty(impressionCount: number, hasStrongEngagement: boolean): number {
  if (hasStrongEngagement || impressionCount <= 0) return 1;
  const index = Math.min(impressionCount, EXPOSURE_PENALTY_BY_COUNT.length - 1);
  return Math.max(EXPOSURE_PENALTY_FLOOR, EXPOSURE_PENALTY_BY_COUNT[index]);
}

/** Second pass, Step 8 — an event the viewer already marked interested/going gets deprioritized (not excluded) in discovery, so it stops competing with events they haven't seen yet. See RESPONDED_EVENT_DISCOVERY_MULTIPLIER's own doc comment. */
export function scoreRespondedEventPenalty(hasResponded: boolean): number {
  return hasResponded ? RESPONDED_EVENT_DISCOVERY_MULTIPLIER : 1;
}

/**
 * Second pass, Step 5 — a small, deterministic hash of an arbitrary
 * string into [0, 1), used ONLY as a per-(user, session, content) score
 * jitter for feed-session stability (see recommendationEngine.ts and
 * SESSION_JITTER_WEIGHT's own doc comment). Plain FNV-1a — fast,
 * dependency-free, and deterministic across JS environments (no reliance
 * on Math.random or object iteration order).
 */
export function hashToUnitInterval(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

/** Step 12 exploration score — the inverse of a category's interest score, i.e. how UNfamiliar this category is to the viewer. Used to bias ordering WITHIN the discovery bucket (recommendationEngine.ts), not as a general-purpose ranking dimension — a candidate the engine has already bucketed as "known"/"related" doesn't need this. */
export function scoreExploration(categoryId: string, profile: RecommendationProfile): number {
  return 1 - scoreInterest(categoryId, profile);
}

/**
 * Recommendation Engine — Step 5, Steps 16/18 — the collaborative-
 * filtering ranking dimension. `collaborativeProfile.categoryScores` is
 * ALREADY confidence-scaled by the backend (see
 * functions/src/collaborative.ts's own computeCollaborativeCategoryScores
 * — `discoveryScore = neighborWeightedScore * confidence`), so this does
 * NOT multiply by confidence again (that would square it, over-shrinking
 * mid-confidence results) — it only gates on
 * COLLABORATIVE_MIN_CONFIDENCE_TO_APPLY as a belt-and-suspenders floor
 * (Step 15: a doc with confidence 0 already has an empty categoryScores
 * map from the backend, so this floor mostly guards a future edge case,
 * not today's normal path).
 *
 * Step 18's "personal negative signals win" — the single most important
 * rule for this whole feature — is enforced here, explicitly and
 * unconditionally: ANY negative personal categoryScore (the viewer has
 * quick-skipped/marked-not-interested enough on this category to pull
 * their OWN score below zero — see CATEGORY_WEIGHT_OVERRIDES) zeroes the
 * collaborative bonus for that category outright, regardless of how
 * confident or strong the collaborative signal is. This is a stronger
 * guarantee than merely "a small ranking weight" would give on its own —
 * Step 18 called this "Very important", so it gets an explicit, direct
 * check rather than relying only on COLLABORATIVE_WEIGHT being smaller
 * than `interest`'s own weight.
 */
export function scoreCollaborativeAffinity(categoryId: string, profile: RecommendationProfile, collaborativeProfile?: CollaborativeProfile | null): number {
  if (!collaborativeProfile) return 0;
  if (collaborativeProfile.confidence < COLLABORATIVE_MIN_CONFIDENCE_TO_APPLY) return 0;
  const personalScore = profile.categoryScores[categoryId] ?? 0;
  if (personalScore < 0) return 0;
  return Math.max(0, Math.min(1, collaborativeProfile.categoryScores[categoryId] ?? 0));
}

/**
 * For You ranking integration — the user's own topical hashtag interest
 * in ONE candidate Reel, from the Reel's own `hashtags` array (never a
 * separate `hashtags/{hashtag}` document read — see this function's own
 * call site in recommendationEngine.ts, and the global collection is
 * irrelevant to per-user ranking anyway) and the caller's already-loaded
 * `hashtagInterests` lookup (see hashtagInterestCache.ts — ONE bounded
 * read per recommendation batch, never per candidate).
 *
 * EXACT canonical matching only (Step 5's own normalized hashtags on both
 * sides — no semantic/topic-graph inference: `#realmadrid` never implies
 * `#football` unless the user has a real, separately-earned `football`
 * interest document).
 *
 * Bounded aggregation, not a plain sum — a Reel with many matching tags
 * doesn't get unlimited credit for it: every matched interest score is
 * collected, sorted STRONGEST first, and only the top
 * HASHTAG_RANKING_MATCH_CAP contribute, each at a shrinking
 * HASHTAG_MATCH_DECAY weight (1, 0.5, 0.25, ...) — a fourth+ match adds
 * nothing further. The final `Math.min(1, ...)` is the hard ceiling this
 * function's own contract promises: 0 for no match, up to but never
 * exceeding 1 for several strong matches.
 *
 * Deterministic and Firestore-free — no different result for the same
 * two inputs, ever, so this is directly unit-testable without a database.
 */
/** Shared, reused-not-reallocated empty map for the common "no hashtagInterests supplied" case (a brand-new user, or a caller that never loaded one) — computeItemScore's own two call sites default to this instead of allocating a fresh `new Map()` per candidate. */
const EMPTY_HASHTAG_INTEREST_MAP: ReadonlyMap<string, number> = new Map();

export function scoreHashtagRelevance(reelHashtags: readonly string[], hashtagInterests: ReadonlyMap<string, number>): number {
  if (reelHashtags.length === 0 || hashtagInterests.size === 0) return 0;

  const matchedScores: number[] = [];
  const seen = new Set<string>();
  for (const hashtag of reelHashtags) {
    // Defensive dedupe — a Reel's own `hashtags` are already deduplicated
    // at creation (Step 1's extractHashtags), but this function never
    // assumes a caller's array is pre-validated.
    if (seen.has(hashtag)) continue;
    seen.add(hashtag);
    const score = hashtagInterests.get(hashtag);
    if (score !== undefined && score > 0) matchedScores.push(score);
  }
  if (matchedScores.length === 0) return 0;

  matchedScores.sort((a, b) => b - a);
  let total = 0;
  for (let i = 0; i < Math.min(matchedScores.length, HASHTAG_RANKING_MATCH_CAP); i++) {
    total += matchedScores[i] * HASHTAG_MATCH_DECAY[Math.min(i, HASHTAG_MATCH_DECAY.length - 1)];
  }
  return Math.min(1, total);
}

export type ScoreContext = {
  categoryId: string;
  creatorId: string;
  cityKey: string;
  countryCode: string;
  publishedAtMs: number;
  isFollowingCreator: boolean;
  likeCount: number;
  commentCount: number;
  /** Present only for Events — see scoreEventTime; omit for Reels/Posts. */
  event?: { startsAtMs: number; endsAtMs: number };
  /** Second pass, Step 4 — how many times this content has recently been shown to this viewer, and whether they've ever strongly engaged with it. Omit (or leave both falsy) for content this scoring pass doesn't need exposure-penalized (e.g. content the viewer has never had impressed before). */
  exposure?: { impressionCount: number; hasStrongEngagement: boolean };
  /** Second pass, Step 8 — Events only: whether the viewer already marked this event interested/going. */
  hasRespondedToEvent?: boolean;
  /**
   * Recommendation Engine — Step 4, Step 23 — the trusted aggregate stats
   * doc, when one exists (see engagementStats.ts's fetchEngagementStats).
   * `undefined`/`null` means "no stats doc yet" — computeItemScore falls
   * back to `scorePopularity(likeCount, commentCount)` in that case (the
   * pre-Step-4 live-count path), never to a hand-rolled zero/neutral
   * value, preserving the exact graceful-migration hierarchy Step 23 asks
   * for: trusted stats -> existing safe counts -> (scorePopularity's own
   * built-in shrinkage already covers "neutral prior" for the all-zero
   * case, so no separate third branch is needed here).
   */
  engagementStats?: ContentEngagementStats | null;
  /** Reels only — true for a video Reel (gates scoreContentQuality's watch/completion terms); omit/false for a photo Reel or any non-Reel content. */
  hasVideo?: boolean;
  /** Reels only — the video's own real duration, when known, for scoreContentQuality's short-video completion dampening. */
  videoDurationMs?: number;
  /** Recommendation Engine — Step 5 — the viewer's own trusted collaborative-filtering doc, when one exists (see collaborative.ts's getCachedCollaborativeProfile). `undefined`/`null` (no doc yet, or the account is ineligible/cold-start) means this dimension contributes exactly 0 — see scoreCollaborativeAffinity. */
  collaborativeProfile?: CollaborativeProfile | null;
  /**
   * For You ranking integration — Reels only. This candidate's own
   * `hashtags` (the exact Reel.hashtags array — never fetched separately;
   * omit/empty for a legacy Reel with none, or for any non-Reel content
   * type, which correctly scores 0 via scoreHashtagRelevance's own empty-
   * input guard) paired with the viewer's already-loaded top hashtag
   * interests (see hashtagInterestCache.ts's getCachedHashtagInterestMap
   * — ONE bounded read per batch, reused for every candidate here, never
   * refetched per item). Both omitted together is the correct shape for
   * a brand-new user (empty map) or content with no hashtags (empty
   * array) — scoreHashtagRelevance returns exactly 0 for either.
   */
  reelHashtags?: readonly string[];
  hashtagInterests?: ReadonlyMap<string, number>;
};

export type ScoreResult = {
  totalScore: number;
  excluded: boolean;
  breakdown: {
    interest: number;
    creatorAffinity: number;
    location: number;
    time: number;
    freshness: number;
    popularity: number;
    collaborativeAffinity: number;
    hashtagRelevance: number;
  };
};

/**
 * Recommendation Engine — Step 4, Step 23 — the "popularity" breakdown
 * slot's actual fallback hierarchy, shared by both branches of
 * computeItemScore below: trusted stats (scoreEventQuality/
 * scoreContentQuality) when a stats doc exists, else the pre-Step-4 live-
 * count formula (scorePopularity) — never a bespoke third value, since
 * scorePopularity's own Bayesian shrinkage already reads as neutral for
 * genuinely zero-data content.
 */
function resolveQualityScore(context: ScoreContext, isEvent: boolean): number {
  if (context.engagementStats) {
    return isEvent ? scoreEventQuality(context.engagementStats) : scoreContentQuality(context.engagementStats, !!context.hasVideo, context.videoDurationMs);
  }
  return scorePopularity(context.likeCount, context.commentCount);
}

/**
 * The single entry point candidateGenerator/recommendationEngine call per
 * candidate — combines every Step 7-11 signal into one weighted score.
 * `time` is scoreEventTime for an Event, or 1 (neutral — no special time
 * dimension) for an ordinary Reel/Post, so the SAME weighted-sum formula
 * covers both without a separate code path per content type.
 */
export function computeItemScore(
  context: ScoreContext,
  profile: RecommendationProfile,
  scope: BrowseScope,
  homeCityKey: string,
  homeCountryCode: string,
  nowMs: number
): ScoreResult {
  // Recommendation Engine — Step 3 — computed once per call from the
  // already-in-memory profile (no extra Firestore read: cityScores is
  // already part of `profile`). Cheap even at MAX_TRACKED_CITIES (50)
  // entries — see normalizeCityAffinity's own doc comment.
  const normalizedCityAffinity = normalizeCityAffinity(profile.cityScores);

  if (context.event) {
    const eventTime = scoreEventTime(context.event.startsAtMs, context.event.endsAtMs, nowMs);
    if (eventTime.excluded) {
      return {
        totalScore: -Infinity,
        excluded: true,
        breakdown: { interest: 0, creatorAffinity: 0, location: 0, time: 0, freshness: 0, popularity: 0, collaborativeAffinity: 0, hashtagRelevance: 0 },
      };
    }
    const breakdown = {
      interest: scoreInterest(context.categoryId, profile),
      creatorAffinity: scoreCreatorAffinity(context.creatorId, profile, context.isFollowingCreator),
      location: scoreLocation(context.cityKey, context.countryCode, scope, homeCityKey, homeCountryCode, normalizedCityAffinity),
      time: eventTime.score,
      freshness: scoreEventFreshness(context.publishedAtMs, nowMs),
      popularity: resolveQualityScore(context, true),
      collaborativeAffinity: scoreCollaborativeAffinity(context.categoryId, profile, context.collaborativeProfile),
      // Events have no hashtags field at all (Step 1's scope was Reel-
      // only) — scoreHashtagRelevance's own empty-array guard already
      // returns exactly 0 here without any event-specific special-casing.
      hashtagRelevance: scoreHashtagRelevance(context.reelHashtags ?? [], context.hashtagInterests ?? EMPTY_HASHTAG_INTEREST_MAP),
    };
    const respondedPenalty = scoreRespondedEventPenalty(!!context.hasRespondedToEvent);
    return { totalScore: weightedSum(breakdown, true) * respondedPenalty, excluded: false, breakdown };
  }

  const breakdown = {
    interest: scoreInterest(context.categoryId, profile),
    creatorAffinity: scoreCreatorAffinity(context.creatorId, profile, context.isFollowingCreator),
    location: scoreLocation(context.cityKey, context.countryCode, scope, homeCityKey, homeCountryCode, normalizedCityAffinity),
    time: 1, // no special event-time dimension for ordinary content
    freshness: scoreFreshness(context.publishedAtMs, nowMs) + scoreNewContentBoost(context.publishedAtMs, nowMs),
    popularity: resolveQualityScore(context, false),
    collaborativeAffinity: scoreCollaborativeAffinity(context.categoryId, profile, context.collaborativeProfile),
    hashtagRelevance: scoreHashtagRelevance(context.reelHashtags ?? [], context.hashtagInterests ?? EMPTY_HASHTAG_INTEREST_MAP),
  };
  const exposurePenalty = context.exposure
    ? scoreRepeatExposurePenalty(context.exposure.impressionCount, context.exposure.hasStrongEngagement)
    : 1;
  return { totalScore: weightedSum(breakdown, false) * exposurePenalty, excluded: false, breakdown };
}

/**
 * Recommendation Engine — Step 3, Step 7 — `isEvent` scales UP location's
 * own weight (never any other dimension) via EVENT_LOCATION_WEIGHT_MULTIPLIER
 * — "can I actually get there" matters more for an Event than for a Reel/
 * Post — without duplicating this whole function or RANKING_WEIGHTS
 * itself per content type (Step 7's own "do not duplicate ranking logic
 * unnecessarily" instruction).
 */
function weightedSum(breakdown: ScoreResult['breakdown'], isEvent: boolean): number {
  const locationWeight = RANKING_WEIGHTS.location * (isEvent ? EVENT_LOCATION_WEIGHT_MULTIPLIER : 1);
  return (
    breakdown.interest * RANKING_WEIGHTS.interest +
    breakdown.location * locationWeight +
    breakdown.time * RANKING_WEIGHTS.time +
    breakdown.creatorAffinity * RANKING_WEIGHTS.creatorAffinity +
    breakdown.freshness * RANKING_WEIGHTS.freshness +
    breakdown.popularity * (RANKING_WEIGHTS.popularity + RANKING_WEIGHTS.quality) + // quality folded into the same engagement-derived signal for v1 — see RANKING_WEIGHTS' own doc comment
    // Recommendation Engine — Step 5, Step 16 — collaborative affinity is
    // its own, deliberately small dimension (COLLABORATIVE_WEIGHT, see
    // that constant's own doc comment for why it can never overpower
    // `interest`) — added on top of, never replacing, every existing
    // dimension above.
    breakdown.collaborativeAffinity * COLLABORATIVE_WEIGHT +
    // For You ranking integration — hashtag relevance is likewise its own
    // small, ADDITIVE dimension (HASHTAG_RELEVANCE_WEIGHT, see that
    // constant's own doc comment in hashtagInterestConfig.ts for the full
    // comparison against every weight above) — never replacing category
    // interest/location/freshness/quality, only nudging a topically-
    // relevant candidate upward within whatever those already decided.
    breakdown.hashtagRelevance * HASHTAG_RELEVANCE_WEIGHT
  );
}
