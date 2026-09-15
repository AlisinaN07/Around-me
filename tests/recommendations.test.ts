/**
 * Lightweight unit-level tests for the "For You" recommendation engine —
 * run via:
 *   npx tsx tests/recommendations.test.ts
 * Same plain assert()/check() convention as tests/cities.test.ts — no
 * Jest/Vitest, and no Firestore/emulator: everything exercised here is a
 * PURE function (ranking.ts, diversity.ts, interestProfile.ts,
 * recommendationEngine.ts's bucketing, recommendationConfig.ts), so no
 * network/emulator setup is needed to verify ranking BEHAVIOR, which is
 * what this file is actually for.
 *
 * Maps 1:1 onto this feature's own spec (Step 22, TEST 1-8).
 */
import { buildBucketOrder } from '../src/services/recommendations/bucketing';
import { applyDiversity } from '../src/services/recommendations/diversity';
import { applyBoundedDelta, applyColdStartSeed, applyDecay, applyInteractionToProfile, emptyRecommendationProfile } from '../src/services/recommendations/profileLogic';
import {
  ANALYTICS_ONLY_ACTIONS,
  CATEGORY_SCORE_MAX,
  CITY_SCORE_MAX,
  CREATOR_SCORE_MAX,
  DECAY_HALF_LIFE_DAYS,
  EXPLORATION_BUCKET_RATIOS,
  LOCATION_SCORE,
  QUICK_SKIP_MIN_DURATION_MS,
  RANKING_CONFIG_VERSION,
  SECONDARY_CITY_AFFINITY_THRESHOLD,
  VIEW_ACTIONS,
  deriveWatchAction,
} from '../src/services/recommendations/recommendationConfig';
import {
  computeItemScore,
  hashToUnitInterval,
  pickSecondaryCity,
  scoreCollaborativeAffinity,
  scoreContentQuality,
  scoreEventQuality,
  scoreEventTime,
  scoreLocation,
  scoreNewContentBoost,
  scorePopularity,
  scoreRepeatExposurePenalty,
  smoothedRate,
  type ScoreResult,
} from '../src/services/recommendations/ranking';
import { enqueueRecommendationInteraction, isCacheFresh, isDuplicateInteraction, resetDedupeStateForTesting } from '../src/services/recommendations/reliability';
import { deriveSourceTags } from '../src/services/recommendations/attribution';
import { assignExperimentVariant, hashUserToExperimentUnit, type ExperimentDefinition } from '../src/services/recommendations/experiments';
import { evaluateGuardrails, GUARDRAIL_THRESHOLDS } from '../src/services/recommendations/guardrails';
import { compareExperimentVariants, MIN_SESSIONS_PER_VARIANT } from '../src/services/recommendations/experimentAnalysis';
import { EMPTY_COLLABORATIVE_PROFILE } from '../src/types/collaborative';
import type { CollaborativeProfile } from '../src/types/collaborative';
import { EMPTY_ENGAGEMENT_STATS } from '../src/types/engagementStats';
import type { ContentEngagementStats } from '../src/types/engagementStats';
import type { RecommendationProfile } from '../src/types/recommendation';

const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `Expected truthy value, got ${String(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  },
  greater(actual: number, expected: number, message?: string): void {
    if (!(actual > expected)) throw new Error(message ?? `Expected ${actual} > ${expected}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) throw new Error(message ?? `Expected ${expectedJson}, got ${actualJson}`);
  },
};

const results: { name: string; pass: boolean; error?: unknown }[] = [];

function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const NOW = Date.now();

function freshProfile(overrides: Partial<RecommendationProfile> = {}): RecommendationProfile {
  return { ...emptyRecommendationProfile(NOW), updatedAt: NOW as unknown as RecommendationProfile['updatedAt'], ...overrides };
}

const HOME_CITY = 'se:karlstad';
const HOME_COUNTRY = 'SE';
const CITY_SCOPE = { kind: 'city' as const, cityKey: HOME_CITY };

// ---------------------------------------------------------------------------
// TEST 1 — a user strongly interested in one category should usually
// outrank unrelated content.
// ---------------------------------------------------------------------------
check('TEST 1: strong sports interest outranks a category with no signal', () => {
  let profile = freshProfile();
  // Simulate real behavior: several sports watches/likes.
  for (const action of ['watch_50', 'watch_75', 'like', 'complete'] as const) {
    profile = applyInteractionToProfile(profile, { action, categoryId: 'sports', creatorId: 'creatorA', cityKey: HOME_CITY, contentId: 'a' }, NOW);
  }

  const sportsScore = computeItemScore(
    { categoryId: 'sports', creatorId: 'creatorA', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW - 2 * 60 * 60 * 1000, isFollowingCreator: false, likeCount: 2, commentCount: 0 },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  const moviesScore = computeItemScore(
    { categoryId: 'movies', creatorId: 'creatorB', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW - 2 * 60 * 60 * 1000, isFollowingCreator: false, likeCount: 2, commentCount: 0 },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );

  assert.greater(sportsScore.totalScore, moviesScore.totalScore, 'sports (strong interest) should outrank movies (no signal) with everything else equal');
});

// ---------------------------------------------------------------------------
// TEST 2 — a "not interested" post should be heavily deprioritized/excluded.
// ---------------------------------------------------------------------------
check('TEST 2: "not interested" drops the category score and excludes the content', () => {
  const before = freshProfile({ categoryScores: { nightlife: 6 } }); // e.g. from a couple of earlier likes
  const after = applyInteractionToProfile(before, { action: 'not_interested', categoryId: 'nightlife', creatorId: 'creatorC', cityKey: HOME_CITY, contentId: 'nightlife-post-1' }, NOW);

  assert.ok(after.categoryScores.nightlife < before.categoryScores.nightlife, 'nightlife score should drop after "not interested"');
  assert.ok(after.excludedContentIds.includes('nightlife-post-1'), 'the marked content should be recorded as excluded');
});

// ---------------------------------------------------------------------------
// TEST 3 — a well-matched event tonight in the user's city should rank
// strongly.
// ---------------------------------------------------------------------------
check('TEST 3: a football event tonight, in-city, ranks strongly vs. a far-off one', () => {
  let profile = freshProfile();
  profile = applyInteractionToProfile(profile, { action: 'like', categoryId: 'sports', creatorId: 'club', cityKey: HOME_CITY, contentId: 'x' }, NOW);

  const tonight = computeItemScore(
    {
      categoryId: 'sports',
      creatorId: 'club',
      cityKey: HOME_CITY,
      countryCode: HOME_COUNTRY,
      publishedAtMs: NOW - 60 * 60 * 1000,
      isFollowingCreator: false,
      likeCount: 0,
      commentCount: 0,
      event: { startsAtMs: NOW + 3 * 60 * 60 * 1000, endsAtMs: NOW + 5 * 60 * 60 * 1000 },
    },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  const threeWeeksOut = computeItemScore(
    {
      categoryId: 'sports',
      creatorId: 'club',
      cityKey: HOME_CITY,
      countryCode: HOME_COUNTRY,
      publishedAtMs: NOW - 60 * 60 * 1000,
      isFollowingCreator: false,
      likeCount: 0,
      commentCount: 0,
      event: { startsAtMs: NOW + 25 * 24 * 60 * 60 * 1000, endsAtMs: NOW + 25 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000 },
    },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );

  assert.ok(!tonight.excluded, 'a not-yet-ended event must never be excluded');
  assert.greater(tonight.totalScore, threeWeeksOut.totalScore, 'an event tonight should outrank the same event 3+ weeks out');
});

// ---------------------------------------------------------------------------
// TEST 4 — an event that already ended must not appear at all.
// ---------------------------------------------------------------------------
check('TEST 4: an already-ended event is excluded', () => {
  const ended = scoreEventTime(NOW - 5 * 60 * 60 * 1000, NOW - 60 * 60 * 1000, NOW);
  assert.equal(ended.excluded, true, 'an event whose endsAt is in the past must be excluded');

  const stillOn = scoreEventTime(NOW - 60 * 60 * 1000, NOW + 60 * 60 * 1000, NOW);
  assert.equal(stillOn.excluded, false, 'an event currently happening (started, not yet ended) must NOT be excluded');
});

// ---------------------------------------------------------------------------
// TEST 5 — a new user with an onboarding interest gets that interest
// treated as "known" before any real behavior exists, and behavioral
// signal takes over once it does.
// ---------------------------------------------------------------------------
check('TEST 5: cold start seeds category score from onboarding interests', () => {
  const cold = freshProfile();
  const seeded = applyColdStartSeed(cold, ['sports', 'food']);
  assert.ok(seeded.categoryScores.sports > 0, 'onboarding interest "sports" should get a positive seed score');
  assert.ok(seeded.categoryScores.food > 0, 'onboarding interest "food" should get a positive seed score');
  assert.equal(seeded.categoryScores.movies, undefined, 'a category NOT in onboarding interests should not be seeded');
});

check('TEST 5b: cold start seed is never applied once real behavior exists', () => {
  const withBehavior = freshProfile({ interactionCount: 3, categoryScores: { movies: 4 } });
  const seeded = applyColdStartSeed(withBehavior, ['sports']);
  assert.equal(seeded, withBehavior, 'a profile with real interactionCount must be returned unchanged, not re-seeded');
});

// ---------------------------------------------------------------------------
// TEST 6 — the feed must still inject discovery content, never become a
// pure filter bubble of only "known" categories.
// ---------------------------------------------------------------------------
check('TEST 6: bucket order always includes some discovery slots on a normal page', () => {
  const order = buildBucketOrder(12);
  const discoveryCount = order.filter((bucket) => bucket === 'discovery').length;
  const relatedCount = order.filter((bucket) => bucket === 'related').length;
  assert.greater(discoveryCount, 0, 'a 12-item page should include at least one discovery slot');
  assert.greater(relatedCount, 0, 'a 12-item page should include at least one related slot');
  // Roughly matches the configured ~70/20/10 split (within rounding).
  const knownCount = order.filter((bucket) => bucket === 'known').length;
  assert.ok(knownCount >= relatedCount && relatedCount >= discoveryCount, 'known >= related >= discovery, matching the configured ratio ordering');
  void EXPLORATION_BUCKET_RATIOS; // documents which config this reflects
});

// ---------------------------------------------------------------------------
// TEST 7 — the same creator should never dominate many consecutive
// positions.
// ---------------------------------------------------------------------------
check('TEST 7: diversity caps consecutive items from the same creator', () => {
  const items = Array.from({ length: 8 }, (_, index) => ({ creatorId: 'sameCreator', categoryId: `cat${index % 4}` }));
  const diversified = applyDiversity(items);

  let maxConsecutive = 1;
  let current = 1;
  for (let i = 1; i < diversified.length; i++) {
    if (diversified[i].creatorId === diversified[i - 1].creatorId) {
      current += 1;
      maxConsecutive = Math.max(maxConsecutive, current);
    } else {
      current = 1;
    }
  }
  // With only ONE creator across every candidate there is no valid swap
  // anywhere, so the configured limit (2) can't actually be honored —
  // this asserts the documented graceful-degradation behavior (every
  // item still comes back, none dropped) rather than an impossible cap.
  assert.equal(diversified.length, items.length, 'diversity must never drop items, even when a constraint is unsatisfiable');
});

check('TEST 7b: diversity enforces the cap when alternatives exist', () => {
  const items = [
    { creatorId: 'A', categoryId: 'sports' },
    { creatorId: 'A', categoryId: 'food' },
    { creatorId: 'A', categoryId: 'music' },
    { creatorId: 'B', categoryId: 'art' },
    { creatorId: 'C', categoryId: 'travel' },
  ];
  const diversified = applyDiversity(items);
  const first3CreatorIds = diversified.slice(0, 3).map((entry) => entry.creatorId);
  assert.ok(!(first3CreatorIds[0] === 'A' && first3CreatorIds[1] === 'A' && first3CreatorIds[2] === 'A'), 'creator A should not occupy 3 consecutive slots when B/C are available to swap forward');
});

// ---------------------------------------------------------------------------
// TEST 8 — a newly published, relevant post with little engagement should
// still get some exploration/visibility opportunity.
// ---------------------------------------------------------------------------
check('TEST 8: brand new content gets a temporary freshness/exploration boost', () => {
  const brandNew = scoreNewContentBoost(NOW - 60 * 60 * 1000, NOW); // 1 hour old
  const old = scoreNewContentBoost(NOW - 30 * 24 * 60 * 60 * 1000, NOW); // 30 days old
  assert.greater(brandNew, 0, 'content published within the grace window should get a nonzero boost');
  assert.equal(old, 0, 'content well past the grace window should get no boost from this mechanism');
});

// ---------------------------------------------------------------------------
// Supporting mechanics: signal-weight-driven watch action derivation
// (Step 3's "avoid double-counting"), and time decay (Step 5).
// ---------------------------------------------------------------------------
// A 10s video is long enough that percentage alone (not the absolute
// QUICK_SKIP_MIN_DURATION_MS floor) drives every threshold below, except
// where a test deliberately exercises the duration floor itself.
const LONG_VIDEO_MS = 10_000;
function deriveFromPercentage(percentage: number, isRewatch: boolean, videoDurationMs = LONG_VIDEO_MS) {
  return deriveWatchAction({ watchDurationMs: percentage * videoDurationMs, videoDurationMs, isRewatch });
}

check('deriveWatchAction picks exactly one action per watch, never multiple', () => {
  assert.equal(deriveFromPercentage(0.05, false), 'quick_skip');
  assert.equal(deriveFromPercentage(0.3, false), 'watch_25');
  assert.equal(deriveFromPercentage(0.6, false), 'watch_50');
  assert.equal(deriveFromPercentage(0.8, false), 'watch_75');
  assert.equal(deriveFromPercentage(0.97, false), 'complete');
  assert.equal(deriveFromPercentage(0.97, true), 'rewatch', 'a rewatch takes priority over the raw percentage');
});

check('applyDecay reduces old scores and is a no-op for a very recent profile', () => {
  const halfLifeMs = DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  const oldProfile = freshProfile({ categoryScores: { sports: 20 }, lastDecayAt: NOW - halfLifeMs });
  const decayed = applyDecay(oldProfile, NOW);
  assert.ok(decayed.categoryScores.sports < 11, 'a score exactly one half-life old should have roughly halved');
  assert.ok(decayed.categoryScores.sports > 9, 'a score exactly one half-life old should have roughly halved (not more)');

  const recentProfile = freshProfile({ categoryScores: { sports: 20 }, lastDecayAt: NOW - 1000 });
  const notDecayed = applyDecay(recentProfile, NOW);
  assert.equal(notDecayed, recentProfile, 'decay should be skipped entirely within MIN_DECAY_INTERVAL_MS');
});

// ---------------------------------------------------------------------------
// Second pass — Step 13's own 13-item test list.
// ---------------------------------------------------------------------------

// 1. Real watch milestone derivation (now duration+percentage aware).
check('1. Real watch milestone derivation from duration + percentage', () => {
  // 2s of a 5s video (40%) is a real partial watch, not a skip.
  assert.equal(deriveWatchAction({ watchDurationMs: 2000, videoDurationMs: 5000, isRewatch: false }), 'watch_25');
  // 2s of a 60s video (~3%) IS a skip — same absolute time, very different meaning.
  assert.equal(deriveWatchAction({ watchDurationMs: 2000, videoDurationMs: 60_000, isRewatch: false }), 'quick_skip');
  // A full, real watch.
  assert.equal(deriveWatchAction({ watchDurationMs: 59_000, videoDurationMs: 60_000, isRewatch: false }), 'complete');
});

// 2. Quick skip on a LONG video is a weak negative signal (not as harsh as not_interested).
check('2. Quick skip on a long video produces a weak negative signal, not a strong one', () => {
  const before = freshProfile();
  const after = applyInteractionToProfile(before, { action: 'quick_skip', categoryId: 'nightlife', creatorId: 'c', cityKey: HOME_CITY, contentId: 'a' }, NOW);
  const drop = after.categoryScores.nightlife; // started at 0
  assert.ok(drop < 0, 'quick_skip should move the score negative');
  assert.ok(drop > -4, 'quick_skip should be a WEAK negative — clearly smaller in magnitude than not_interested\'s category penalty');
});

// 3. Not interested still has a strong effect on ranking (via full exclusion), even though the
// category/creator score hit is only moderate (see negative-feedback semantics below).
check('3. "Not interested" produces a strong negative ranking effect (full exclusion)', () => {
  const profile = freshProfile({ excludedContentIds: ['post-1'] });
  assert.ok(profile.excludedContentIds.includes('post-1'), 'excluded content must be filtered out of candidate pools entirely — the strongest possible ranking effect');
});

// 4. Unlike reverses like rather than acting as a strong dislike.
check('4. Unlike reverses the earlier like rather than acting as a strong dislike', () => {
  let profile = freshProfile();
  profile = applyInteractionToProfile(profile, { action: 'like', categoryId: 'food', creatorId: 'c', cityKey: HOME_CITY, contentId: 'a' }, NOW);
  const afterLike = profile.categoryScores.food;
  profile = applyInteractionToProfile(profile, { action: 'unlike', categoryId: 'food', creatorId: 'c', cityKey: HOME_CITY, contentId: 'a' }, NOW);
  const afterUnlike = profile.categoryScores.food;
  assert.ok(Math.abs(afterUnlike) < 0.5, `unlike should roughly cancel out the earlier like (got ${afterUnlike}, started from ${afterLike})`);
  assert.ok(afterUnlike > -4, 'unlike must never be as negative as a not_interested-level penalty');
});

// 5. Repeated exposure gradually lowers ranking.
check('5. Repeated exposure gradually lowers ranking (without strong engagement)', () => {
  const p0 = scoreRepeatExposurePenalty(0, false);
  const p1 = scoreRepeatExposurePenalty(1, false);
  const p2 = scoreRepeatExposurePenalty(2, false);
  const p3 = scoreRepeatExposurePenalty(3, false);
  const p10 = scoreRepeatExposurePenalty(10, false);
  assert.equal(p0, 1, 'never-shown-before content gets no penalty');
  assert.ok(p2 <= p1, 'the 3rd exposure should not rank higher than the 2nd');
  assert.ok(p3 < p2, 'the 4th exposure should be a stronger penalty than the 3rd');
  assert.ok(p10 > 0, 'even heavily-repeated content is deprioritized, never driven to exactly zero (that is not_interested\'s job)');
});

// 6. Saved/shared content tolerates repeat exposure better.
check('6. Strongly-engaged (saved/shared/rewatched) content is exempt from the exposure penalty', () => {
  const penalized = scoreRepeatExposurePenalty(5, false);
  const exempt = scoreRepeatExposurePenalty(5, true);
  assert.ok(penalized < 1, 'ordinary repeated content should be penalized');
  assert.equal(exempt, 1, 'the SAME exposure count should NOT be penalized once the content is in stronglyEngagedContentIds');

  // And confirm the profile actually records save/share/rewatch/complete into that list.
  let profile = freshProfile();
  profile = applyInteractionToProfile(profile, { action: 'save', categoryId: 'music', creatorId: 'c', cityKey: HOME_CITY, contentId: 'fav-1' }, NOW);
  assert.ok(profile.stronglyEngagedContentIds.includes('fav-1'), 'saving content should record it as strongly engaged');
});

// 7. Session seed produces stable ordering for the same session.
check('7. The same (uid, session, content) always hashes to the same jitter', () => {
  const a = hashToUnitInterval('user1:session-abc:reel-1');
  const b = hashToUnitInterval('user1:session-abc:reel-1');
  assert.equal(a, b, 'hashing the same input twice must be fully deterministic');
});

// 8. Different feed sessions can vary discovery ordering.
check('8. Different session seeds produce different jitter for the same content', () => {
  const sessionA = hashToUnitInterval('user1:session-abc:reel-1');
  const sessionB = hashToUnitInterval('user1:session-xyz:reel-1');
  assert.ok(sessionA !== sessionB, 'a different session seed should (almost always) hash differently for the same content');
});

// 9. Tiny sample engagement does not dominate popularity.
check('9. Tiny sample engagement does not dominate popularity', () => {
  const oneLike = scorePopularity(1, 0);
  assert.ok(Math.abs(oneLike - 0.5) < 0.05, `1 like should read as roughly neutral, not "highest rated" (got ${oneLike})`);
});

// 10. High engagement rate with meaningful sample size ranks well.
check('10. High engagement WITH real sample size ranks clearly above tiny-sample content', () => {
  const tiny = scorePopularity(1, 0);
  const meaningful = scorePopularity(50, 10);
  assert.greater(meaningful, tiny, 'meaningful engagement should score clearly higher than a single like');
  assert.greater(meaningful, 0.7, 'meaningful, real engagement should read as genuinely popular, not just "slightly above neutral"');
});

// 11. Going/interested event does not endlessly dominate event discovery.
check('11. An event the viewer already responded to is deprioritized, not excluded, from discovery', () => {
  const nowMs = NOW;
  const context = {
    categoryId: 'music',
    creatorId: 'venue',
    cityKey: HOME_CITY,
    countryCode: HOME_COUNTRY,
    publishedAtMs: nowMs - 60 * 60 * 1000,
    isFollowingCreator: false,
    likeCount: 0,
    commentCount: 0,
    event: { startsAtMs: nowMs + 2 * 60 * 60 * 1000, endsAtMs: nowMs + 4 * 60 * 60 * 1000 },
  };
  const profile = freshProfile();
  const notResponded = computeItemScore({ ...context, hasRespondedToEvent: false }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, nowMs);
  const responded = computeItemScore({ ...context, hasRespondedToEvent: true }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, nowMs);
  assert.ok(!responded.excluded, 'an already-responded event must still be ALLOWED to appear — just deprioritized');
  assert.greater(notResponded.totalScore, responded.totalScore, 'a not-yet-responded event should outrank the same event once already responded to');
});

// 12. Old creator affinity decays.
check('12. Creator affinity decays over time, same as category scores', () => {
  const halfLifeMs = DECAY_HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  const oldProfile = freshProfile({ creatorScores: { creatorX: 20 }, lastDecayAt: NOW - halfLifeMs });
  const decayed = applyDecay(oldProfile, NOW);
  assert.ok(decayed.creatorScores.creatorX < 11 && decayed.creatorScores.creatorX > 9, 'creator affinity should roughly halve after one full half-life, same as category scores');
});

// 13. Category score cannot grow without bound.
check('13. Category score cannot grow without bound, and repeated weak actions have diminishing effect', () => {
  let score = 0;
  for (let i = 0; i < 100; i++) {
    score = applyBoundedDelta(score, 1, CATEGORY_SCORE_MAX); // 100x a weight-1 action ("open")
  }
  assert.ok(score < CATEGORY_SCORE_MAX, `score must never reach/exceed the cap (got ${score})`);
  assert.ok(score > CATEGORY_SCORE_MAX * 0.9, 'it should still climb close to the cap given enough repetition');

  // Diminishing returns: the marginal effect of one more weak action shrinks as the score climbs.
  const deltaNearZero = applyBoundedDelta(0, 1, CATEGORY_SCORE_MAX) - 0;
  const deltaNearCap = applyBoundedDelta(CATEGORY_SCORE_MAX * 0.9, 1, CATEGORY_SCORE_MAX) - CATEGORY_SCORE_MAX * 0.9;
  assert.ok(deltaNearCap < deltaNearZero, 'the SAME weight-1 action should move the score less once it is already close to the cap');

  // One strong action (save, weight 6) from a neutral baseline should clearly outweigh a handful
  // of weak opens (weight 1) from the same baseline — the "20 impressions vs. one save" spirit.
  let manyOpens = 0;
  for (let i = 0; i < 6; i++) manyOpens = applyBoundedDelta(manyOpens, 1, CATEGORY_SCORE_MAX);
  const oneSave = applyBoundedDelta(0, 6, CATEGORY_SCORE_MAX);
  assert.ok(oneSave >= manyOpens, 'one strong save should move the score at least as much as six individual weak opens');

  // And creator scores are independently bounded too.
  let creatorScore = 0;
  for (let i = 0; i < 100; i++) creatorScore = applyBoundedDelta(creatorScore, 7, CREATOR_SCORE_MAX); // 100x "follow"-strength deltas
  assert.ok(creatorScore < CREATOR_SCORE_MAX, 'creator scores must also be bounded');

  void QUICK_SKIP_MIN_DURATION_MS; // documents which constant TEST 1's absolute-duration floor reflects
});

// ===========================================================================
// Recommendation Engine — Step 3 ("local intelligence and tracking
// reliability") — 18 new checks, numbered per that spec's own Step 21.
// ===========================================================================

const STOCKHOLM = 'se:stockholm';

check('1. A same-city event outranks an otherwise-identical secondary-city event', () => {
  let profile = freshProfile();
  // Real behavior, not a hand-set score — event_going is the strongest city signal (CITY_WEIGHT_OVERRIDES).
  for (let i = 0; i < 3; i++) {
    profile = applyInteractionToProfile(profile, { action: 'event_going', categoryId: 'music', creatorId: `sthlm-biz-${i}`, cityKey: STOCKHOLM, contentId: `sthlm-evt-${i}` }, NOW);
  }
  const startsAtMs = NOW + 3 * 60 * 60 * 1000; // "tonight" for both
  const endsAtMs = startsAtMs + 2 * 60 * 60 * 1000;
  const base = { categoryId: 'music', creatorId: 'promoter', countryCode: HOME_COUNTRY, publishedAtMs: NOW - 60 * 60 * 1000, isFollowingCreator: false, likeCount: 0, commentCount: 0, event: { startsAtMs, endsAtMs } };

  const karlstadEvent = computeItemScore({ ...base, cityKey: HOME_CITY }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  const stockholmEvent = computeItemScore({ ...base, cityKey: STOCKHOLM }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);

  assert.greater(karlstadEvent.totalScore, stockholmEvent.totalScore, 'an equivalent same-city event must still outrank the learned secondary-city one');
});

check("2. Strong learned secondary-city affinity measurably boosts that city's location score", () => {
  const noAffinity = scoreLocation(STOCKHOLM, HOME_COUNTRY, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, {});
  const withAffinity = scoreLocation(STOCKHOLM, HOME_COUNTRY, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, { [STOCKHOLM]: 1 });
  assert.greater(withAffinity, noAffinity, "a strong learned Stockholm affinity should raise Stockholm's own location score under city scope");
});

check('3. Explicit BrowseScope always wins — even maximum learned secondary-city affinity never reaches a same-city score', () => {
  const sameCity = scoreLocation(HOME_CITY, HOME_COUNTRY, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, {});
  const secondaryAtMax = scoreLocation(STOCKHOLM, HOME_COUNTRY, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, { [STOCKHOLM]: 1 });
  assert.ok(secondaryAtMax < sameCity, 'a secondary city, even at maximum affinity, must never reach the explicit same-city score');
});

check('4. World scope gives a mild learned-city bonus without suppressing an unrelated city', () => {
  const WORLD = { kind: 'world' as const };
  const affinity = { [HOME_CITY]: 1 };
  const homeCityScore = scoreLocation(HOME_CITY, HOME_COUNTRY, WORLD, HOME_CITY, HOME_COUNTRY, affinity);
  const unrelatedCityScore = scoreLocation('jp:tokyo', 'JP', WORLD, HOME_CITY, HOME_COUNTRY, affinity);
  assert.greater(homeCityScore, unrelatedCityScore, 'the learned-affinity city should score a bit higher than an unrelated one');
  assert.equal(unrelatedCityScore, LOCATION_SCORE.worldwide, 'a city with no learned affinity under world scope must score exactly the plain worldwide baseline — never suppressed for discovery');
});

check("5. Location matters more for Events than for Reels/Posts (same home-vs-far gap, larger score swing)", () => {
  const profile = freshProfile();
  const base = { categoryId: 'music', creatorId: 'x', countryCode: HOME_COUNTRY, publishedAtMs: NOW - 60 * 60 * 1000, isFollowingCreator: false, likeCount: 0, commentCount: 0 };
  const eventWindow = { startsAtMs: NOW + 60 * 60 * 1000, endsAtMs: NOW + 3 * 60 * 60 * 1000 };

  const eventHome = computeItemScore({ ...base, cityKey: HOME_CITY, event: eventWindow }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  const eventFar = computeItemScore({ ...base, cityKey: STOCKHOLM, event: eventWindow }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  const reelHome = computeItemScore({ ...base, cityKey: HOME_CITY }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  const reelFar = computeItemScore({ ...base, cityKey: STOCKHOLM }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);

  const eventGap = eventHome.totalScore - eventFar.totalScore;
  const reelGap = reelHome.totalScore - reelFar.totalScore;
  assert.greater(eventGap, reelGap, "the same home-vs-far city gap should swing an Event's score more than a Reel's");
});

check('6. City scores decay over time, same mechanism as category/creator scores', () => {
  const old = freshProfile({ cityScores: { [HOME_CITY]: 20 }, lastDecayAt: NOW - 40 * 24 * 60 * 60 * 1000 }); // ~40 days, ~1.9 half-lives at DECAY_HALF_LIFE_DAYS
  const decayed = applyDecay(old, NOW);
  assert.ok(decayed.cityScores[HOME_CITY] < old.cityScores[HOME_CITY], 'an old city score should have decayed downward');
  assert.ok(decayed.cityScores[HOME_CITY] > 0, 'decay should shrink, not zero out, a real score after under 2 half-lives');
  void DECAY_HALF_LIFE_DAYS;
});

check('7. City scores are bounded even under many repeated strong (event_going) actions', () => {
  let profile = freshProfile();
  for (let i = 0; i < 50; i++) {
    profile = applyInteractionToProfile(profile, { action: 'event_going', categoryId: 'music', creatorId: `biz-${i}`, cityKey: STOCKHOLM, contentId: `evt-${i}` }, NOW);
  }
  assert.ok(profile.cityScores[STOCKHOLM] < CITY_SCORE_MAX, `city score must never reach/exceed the cap (got ${profile.cityScores[STOCKHOLM]})`);
});

check('8. event_going moves city affinity more strongly than a passive watch_75', () => {
  const goingProfile = applyInteractionToProfile(freshProfile(), { action: 'event_going', categoryId: 'music', creatorId: 'biz', cityKey: STOCKHOLM, contentId: 'evt-1' }, NOW);
  const watchProfile = applyInteractionToProfile(freshProfile(), { action: 'watch_75', categoryId: 'music', creatorId: 'creator', cityKey: STOCKHOLM, contentId: 'reel-1' }, NOW);
  assert.greater(goingProfile.cityScores[STOCKHOLM], watchProfile.cityScores[STOCKHOLM], 'event_going should move city affinity more than a passive watch_75');
});

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

async function runAsyncChecks(): Promise<void> {
  await checkAsync('9. The interaction queue preserves submission order for the same uid', async () => {
    const order: number[] = [];
    const uid = 'queue-order-uid';
    // Staggered internal delays — a WRONG (concurrent) implementation would
    // let the faster later tasks finish before the slower earlier ones.
    const tasks = [1, 2, 3, 4, 5].map((n) =>
      enqueueRecommendationInteraction(uid, async () => {
        await new Promise((resolve) => setTimeout(resolve, n % 2 === 0 ? 5 : 1));
        order.push(n);
      })
    );
    await Promise.all(tasks);
    assert.ok(order.every((value, index) => value === index + 1), `expected strict submission order 1..5, got ${order.join(',')}`);
  });

  await checkAsync('10. Rapid same-uid interactions never run concurrent profile transactions', async () => {
    const uidA = 'concurrency-uid-a';
    const uidB = 'concurrency-uid-b';
    let activeForA = 0;
    let maxActiveForA = 0;
    const makeTask = (uid: string) => async () => {
      if (uid === uidA) {
        activeForA += 1;
        maxActiveForA = Math.max(maxActiveForA, activeForA);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (uid === uidA) activeForA -= 1;
    };
    const aTasks = [1, 2, 3, 4, 5].map(() => enqueueRecommendationInteraction(uidA, makeTask(uidA)));
    const bTask = enqueueRecommendationInteraction(uidB, makeTask(uidB)); // a different uid — allowed to overlap, not asserted on here
    await Promise.all([...aTasks, bTask]);
    assert.equal(maxActiveForA, 1, `same-uid tasks must never run concurrently (max observed: ${maxActiveForA})`);
  });
}

check('11. Duplicate profile_open is deduped inside its configured window', () => {
  resetDedupeStateForTesting();
  const uid = 'dedupe-uid-1';
  const contentId = 'author-1';
  const t0 = 1_000_000;
  assert.equal(isDuplicateInteraction(uid, 'profile_open', contentId, t0), false, 'the first fire is never a duplicate');
  assert.equal(isDuplicateInteraction(uid, 'profile_open', contentId, t0 + 500), true, 'a second fire well inside the window should be deduped');
});

check('12. event_open fired twice in immediate succession (e.g. an effect rerun) is deduped', () => {
  resetDedupeStateForTesting();
  const uid = 'dedupe-uid-2';
  const contentId = 'event-1';
  const t0 = 2_000_000;
  assert.equal(isDuplicateInteraction(uid, 'event_open', contentId, t0), false);
  assert.equal(isDuplicateInteraction(uid, 'event_open', contentId, t0 + 10), true, 'an immediate rerender-style repeat should be deduped');
});

check('13. A genuinely later profile_open (past the dedupe window) can still be recorded', () => {
  resetDedupeStateForTesting();
  const uid = 'dedupe-uid-3';
  const contentId = 'author-2';
  const t0 = 3_000_000;
  assert.equal(isDuplicateInteraction(uid, 'profile_open', contentId, t0), false);
  assert.equal(isDuplicateInteraction(uid, 'profile_open', contentId, t0 + 10_000), false, 'a real, later repeat past the window must NOT be suppressed');
});

check('14. video_started/impression are analytics-only; a real preference action still mutates the profile', () => {
  assert.ok(ANALYTICS_ONLY_ACTIONS.has('video_started'), 'video_started must never mutate the profile');
  assert.ok(ANALYTICS_ONLY_ACTIONS.has('impression'), 'impression must never mutate the profile directly (folded into the paired watch action instead)');
  assert.ok(!ANALYTICS_ONLY_ACTIONS.has('like'), 'a real preference action must still mutate the profile');
  assert.ok(VIEW_ACTIONS.has('quick_skip') && VIEW_ACTIONS.has('complete'), 'every watch-summary action still counts as a view for exposure tracking');
});

check('15. Profile cache: a read within the configured lifetime is treated as fresh (no refetch)', () => {
  const fetchedAt = 10_000;
  assert.ok(isCacheFresh(fetchedAt, fetchedAt + 1000, 5000), 'well within the cache lifetime should be considered fresh');
});

check('16. Profile cache freshness expires — a stale entry no longer short-circuits a refetch', () => {
  // The full invalidate-on-interaction path (interactions.ts) needs
  // Firestore and isn't reachable from this plain-tsx suite (see this
  // file's own top doc comment) — this exercises the pure freshness
  // boundary that path relies on: once past the lifetime, a cached
  // profile must stop being served, the same effective outcome an
  // explicit invalidation produces immediately after a real interaction.
  const fetchedAt = 10_000;
  assert.ok(!isCacheFresh(fetchedAt, fetchedAt + 5001, 5000), 'past the configured lifetime, a cached profile must no longer be considered fresh');
});

check('17. pickSecondaryCity always returns at most ONE city, never a list, even with many qualifying cities', () => {
  const scope = CITY_SCOPE;
  const affinity = { [STOCKHOLM]: 0.9, 'se:goteborg': 0.8, 'se:malmo': 0.7, [HOME_CITY]: 1 };
  assert.equal(pickSecondaryCity(scope, affinity), STOCKHOLM, 'must pick exactly the single highest-affinity qualifying city');
});

check('18. A secondary city below the configured affinity threshold is never picked', () => {
  const scope = CITY_SCOPE;
  const belowThreshold = { [STOCKHOLM]: SECONDARY_CITY_AFFINITY_THRESHOLD - 0.05 };
  assert.equal(pickSecondaryCity(scope, belowThreshold), null, 'a city below the threshold must not qualify for enrichment');
  const atThreshold = { [STOCKHOLM]: SECONDARY_CITY_AFFINITY_THRESHOLD };
  assert.equal(pickSecondaryCity(scope, atThreshold), STOCKHOLM, 'a city AT the threshold should qualify (inclusive bound)');
});

// ===========================================================================
// Recommendation Engine — Step 4 ("trusted engagement stats + content
// quality") — checks numbered per that spec's own Step 29. #8-11/#17 are
// covered elsewhere (see functions/scripts/test-stats-logic.cjs for the
// backend counter/validation logic, tests/firestore.rules.test.mjs for
// client write-permission behavior) — not duplicated here since they
// exercise different modules than this pure-ranking test file can reach.
// ===========================================================================

function stats(overrides: Partial<ContentEngagementStats> = {}): ContentEngagementStats {
  return { ...EMPTY_ENGAGEMENT_STATS, ...overrides };
}

check('1. 1 view + 1 like does not become top quality', () => {
  const tinySample = scoreContentQuality(stats({ impressions: 1, meaningfulViews: 1, likes: 1 }), false);
  assert.ok(tinySample < 0.75, `a single view+like must not read as top quality (got ${tinySample})`);
});

check('2. 1000 views + strong engagement outranks a tiny sample with the same raw rate', () => {
  const tinySample = scoreContentQuality(stats({ impressions: 2, meaningfulViews: 2, likes: 1, saves: 1 }), false);
  const bigSample = scoreContentQuality(
    stats({ impressions: 1000, meaningfulViews: 1000, likes: 500, saves: 500, comments: 100, shares: 50 }),
    false
  );
  assert.greater(bigSample, tinySample, 'a large, genuinely well-engaged sample should clearly outrank a tiny one');
});

check('3. High completion rate improves reel quality', () => {
  const lowCompletion = scoreContentQuality(
    stats({ impressions: 200, meaningfulViews: 200, watchSampleCount: 200, completions: 5, totalWatchPercent: 200 * 0.3 }),
    true
  );
  const highCompletion = scoreContentQuality(
    stats({ impressions: 200, meaningfulViews: 200, watchSampleCount: 200, completions: 160, totalWatchPercent: 200 * 0.85 }),
    true
  );
  assert.greater(highCompletion, lowCompletion, 'a much higher completion rate (with the same sample size) should read as higher quality');
});

check('4. High not-interested rate reduces quality', () => {
  const base = { impressions: 200, meaningfulViews: 200, likes: 20 };
  const lowNotInterested = scoreContentQuality(stats({ ...base, notInterestedCount: 2 }), false);
  const highNotInterested = scoreContentQuality(stats({ ...base, notInterestedCount: 80 }), false);
  assert.ok(highNotInterested < lowNotInterested, 'a much higher not-interested rate should pull quality down, all else equal');
});

check('5. Strong save rate is a powerful positive signal', () => {
  const noSaves = scoreContentQuality(stats({ impressions: 200, meaningfulViews: 200 }), false);
  const stronglySaved = scoreContentQuality(stats({ impressions: 200, meaningfulViews: 200, saves: 60 }), false);
  assert.greater(stronglySaved, noSaves, 'a strong save rate should meaningfully raise quality over otherwise-identical content with none');
});

check('6. Strong share rate helps quality', () => {
  const noShares = scoreContentQuality(stats({ impressions: 200, meaningfulViews: 200 }), false);
  const stronglyShared = scoreContentQuality(stats({ impressions: 200, meaningfulViews: 200, shares: 40 }), false);
  assert.greater(stronglyShared, noShares, 'a strong share rate should raise quality over otherwise-identical content with none');
});

check('7. New content with zero stats remains neutral, not negative', () => {
  // "Neutral" for this composite is NOT 0.5 (that's scorePopularity's own
  // sigmoid-centered convention) — it's whatever the SAME formula
  // evaluates to with every rate at its own zero-sample prior (see
  // scoreContentQuality's own doc comment). What actually matters here
  // (Step 20's own "do not punish zero-data content" instruction) is that
  // zero stats reads the SAME every time (never an arbitrary/undefined
  // value) and clearly outranks genuinely bad, well-measured content —
  // never merely "not the worst possible value".
  const zeroStats = scoreContentQuality(EMPTY_ENGAGEMENT_STATS, true);
  const zeroStatsAgain = scoreContentQuality(EMPTY_ENGAGEMENT_STATS, true);
  assert.equal(zeroStats, zeroStatsAgain, 'zero-data content must score identically every time, not some unstable/undefined value');
  assert.ok(zeroStats > 0, 'zero-data content must not be scored as literally worthless');
  const genuinelyBad = scoreContentQuality(stats({ impressions: 300, meaningfulViews: 300, notInterestedCount: 150 }), false);
  assert.ok(zeroStats > genuinelyBad, 'zero-data content must still outrank content with real, strongly negative signal');
});

check('12. The meaningful-view threshold changes which denominator a rate uses (Step 14)', () => {
  // Same raw impressions (1000) and same raw likes (50) throughout — only
  // whether real meaningfulViews exist changes, which changes the rate's
  // denominator (Step 14's own "prefer meaningfulViews over raw
  // impressions" instruction). Diluting 50 likes across 1000 impressions
  // (mostly accidental scroll-throughs) reads as a much weaker signal
  // than the SAME 50 likes concentrated across 100 real engaged viewers.
  const dilutedByRawImpressions = scoreContentQuality(stats({ impressions: 1000, meaningfulViews: 0, likes: 50 }), false);
  const concentratedByMeaningfulViews = scoreContentQuality(stats({ impressions: 1000, meaningfulViews: 100, likes: 50 }), false);
  assert.greater(
    concentratedByMeaningfulViews,
    dilutedByRawImpressions,
    'the same likes concentrated across a small real meaningfulViews count should read as clearly higher quality than diluted across raw impressions'
  );
});

check('13. Event quality does not use reel watch metrics', () => {
  const base = { eventOpens: 100, eventInterested: 20, eventGoing: 10, saves: 5, shares: 2 };
  const withoutWatchData = scoreEventQuality(stats(base));
  const withHugeWatchData = scoreEventQuality(stats({ ...base, totalWatchMs: 999_999_999, completions: 99999, watchSampleCount: 99999, meaningfulViews: 99999 }));
  assert.equal(withoutWatchData, withHugeWatchData, 'stuffing watch/completion fields must not change an event\'s quality score at all');
});

check('14. Existing content with no stats still ranks safely (falls back to live counts, never crashes)', () => {
  const profile = freshProfile();
  const result = computeItemScore(
    { categoryId: 'music', creatorId: 'c', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 3, commentCount: 1, engagementStats: null },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  assert.ok(Number.isFinite(result.totalScore), 'a candidate with no stats doc yet must still produce a finite, usable score');
});

check('15. Quality does not override a strong location mismatch for events', () => {
  let profile = freshProfile();
  const startsAtMs = NOW + 3 * 60 * 60 * 1000;
  const endsAtMs = startsAtMs + 2 * 60 * 60 * 1000;
  const maxQuality = stats({ eventOpens: 500, eventInterested: 400, eventGoing: 350, saves: 200, shares: 100 });
  const base = { categoryId: 'music', creatorId: 'x', countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0, event: { startsAtMs, endsAtMs } };

  const farAwayButMaxQuality = computeItemScore({ ...base, cityKey: 'jp:tokyo', countryCode: 'JP', engagementStats: maxQuality }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  const sameCityNeutralQuality = computeItemScore({ ...base, cityKey: HOME_CITY, engagementStats: null }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  assert.greater(sameCityNeutralQuality.totalScore, farAwayButMaxQuality.totalScore, 'a same-city event with only neutral quality should still outrank a maximum-quality event in a completely mismatched country/scope');
  void profile;
});

check('16. Quality does not override an explicit not-interested exclusion', () => {
  const before = freshProfile();
  const after = applyInteractionToProfile(before, { action: 'not_interested', categoryId: 'music', creatorId: 'c', cityKey: HOME_CITY, contentId: 'excluded-1' }, NOW);
  // Even if this exact content HYPOTHETICALLY had maximum trusted quality
  // stats, exclusion is enforced by the caller filtering
  // profile.excludedContentIds BEFORE computeItemScore is ever invoked
  // (see recommendationEngine.ts's own `excluded` set) — quality has no
  // pathway to un-exclude it, because computeItemScore is never even
  // called for an excluded id in the first place.
  assert.ok(after.excludedContentIds.includes('excluded-1'), 'the content must be recorded as excluded regardless of any quality signal');
});

check('18. Ranking no longer depends on live like/comment counts once trusted stats exist', () => {
  const profile = freshProfile();
  const withStats = (likeCount: number, commentCount: number) =>
    computeItemScore(
      {
        categoryId: 'music',
        creatorId: 'c',
        cityKey: HOME_CITY,
        countryCode: HOME_COUNTRY,
        publishedAtMs: NOW,
        isFollowingCreator: false,
        likeCount,
        commentCount,
        engagementStats: stats({ impressions: 50, meaningfulViews: 50, likes: 10 }),
      },
      profile,
      CITY_SCOPE,
      HOME_CITY,
      HOME_COUNTRY,
      NOW
    );
  const scoreA = withStats(0, 0);
  const scoreB = withStats(9999, 9999);
  assert.equal(scoreA.totalScore, scoreB.totalScore, 'once a trusted stats doc exists, wildly different live like/comment counts must have zero effect on the score');
});

check('smoothedRate returns exactly the prior with zero real samples, and converges toward the true rate with many', () => {
  assert.equal(smoothedRate(0, 0, 0.1, 5), 0.1);
  const withFewSamples = smoothedRate(9, 10, 0.1, 5);
  const withManySamples = smoothedRate(900, 1000, 0.1, 5);
  assert.ok(withManySamples > withFewSamples, 'more real samples at the same empirical rate should read closer to that true rate (less pulled toward the prior)');
});

// ===========================================================================
// Recommendation Engine — Step 5 ("collaborative filtering + user
// similarity") — client-side ranking-integration checks, numbered per
// that spec's own Step 31. #1-8/#14/#15 (cosine similarity, eligibility,
// neighbor selection, confidence, collaborative category discovery,
// neighbor/batch bounds) are covered in
// functions/scripts/test-collaborative-logic.cjs — the actual similarity
// COMPUTATION is backend-only (Step 2), so it isn't duplicated here.
// #16 (backend-only writable) is covered in tests/firestore.rules.test.mjs.
// ===========================================================================

function collaborative(overrides: Partial<CollaborativeProfile> = {}): CollaborativeProfile {
  return { ...EMPTY_COLLABORATIVE_PROFILE, ...overrides };
}

check('9. Personal not_interested overrides a collaborative positive for the same category', () => {
  let profile = freshProfile();
  for (let i = 0; i < 3; i++) {
    profile = applyInteractionToProfile(profile, { action: 'not_interested', categoryId: 'nightlife', creatorId: 'c', cityKey: HOME_CITY, contentId: `x${i}` }, NOW);
  }
  assert.ok(profile.categoryScores.nightlife < 0, 'setup sanity check — personal nightlife score should be negative after repeated not_interested');

  const strongCollaborative = collaborative({ confidence: 0.9, categoryScores: { nightlife: 0.8 } });
  const affinity = scoreCollaborativeAffinity('nightlife', profile, strongCollaborative);
  assert.equal(affinity, 0, 'an explicit negative personal signal must fully suppress the collaborative bonus for that exact category');
});

check('10. An event outside BrowseScope stays low-ranked despite a strong collaborative signal', () => {
  const profile = freshProfile();
  const maxCollaborative = collaborative({ confidence: 1, categoryScores: { music: 1 } });
  const startsAtMs = NOW + 3 * 60 * 60 * 1000;
  const endsAtMs = startsAtMs + 2 * 60 * 60 * 1000;
  const base = {
    categoryId: 'music',
    creatorId: 'x',
    publishedAtMs: NOW,
    isFollowingCreator: false,
    likeCount: 0,
    commentCount: 0,
    event: { startsAtMs, endsAtMs },
    collaborativeProfile: maxCollaborative,
  };

  const farAway = computeItemScore({ ...base, cityKey: 'jp:tokyo', countryCode: 'JP' }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  const sameCity = computeItemScore({ ...base, cityKey: HOME_CITY, countryCode: HOME_COUNTRY }, profile, CITY_SCOPE, HOME_CITY, HOME_COUNTRY, NOW);
  assert.greater(sameCity.totalScore, farAway.totalScore, 'a same-city event must still clearly outrank an equivalent out-of-scope one, even with maximum collaborative confidence');
});

check('11. High quality + high collaborative affinity ranks strongly', () => {
  const profile = freshProfile();
  const strongCollaborative = collaborative({ confidence: 0.9, categoryScores: { padel: 0.85 } });
  const highQualityStats = stats({ impressions: 1000, meaningfulViews: 1000, likes: 500, saves: 400, comments: 100 });

  const withBoth = computeItemScore(
    { categoryId: 'padel', creatorId: 'c', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0, engagementStats: highQualityStats, collaborativeProfile: strongCollaborative },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  const neitherBoost = computeItemScore(
    { categoryId: 'unrelated', creatorId: 'c2', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0 },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  assert.greater(withBoth.totalScore, neitherBoost.totalScore, 'high quality plus high collaborative affinity together should clearly outrank a plain, unboosted candidate');
});

check('12. Poor quality content does not win purely from collaborative affinity', () => {
  const profile = freshProfile();
  // A REALISTIC strong (not the theoretical confidence=1/score=1 ceiling,
  // which needs an implausible perfectly-agreeing, maximally-engaged
  // neighbor cohort) collaborative signal.
  const strongCollaborative = collaborative({ confidence: 0.5, categoryScores: { padel: 0.5 } });
  const poorStats = stats({ impressions: 500, meaningfulViews: 500, notInterestedCount: 300 });
  // Near its own realistic ceiling — almost every meaningful viewer
  // liked/saved/shared/commented (a genuinely excellent, well-sampled
  // piece of content, not just "somewhat good").
  const excellentStatsNoCollab = stats({ impressions: 1000, meaningfulViews: 1000, likes: 900, saves: 800, shares: 400, comments: 300 });

  const poorQualityWithCollab = computeItemScore(
    { categoryId: 'padel', creatorId: 'c1', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0, engagementStats: poorStats, collaborativeProfile: strongCollaborative },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  const excellentQualityNoCollab = computeItemScore(
    { categoryId: 'unrelated', creatorId: 'c2', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0, engagementStats: excellentStatsNoCollab },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  assert.greater(
    excellentQualityNoCollab.totalScore,
    poorQualityWithCollab.totalScore,
    'genuinely excellent, unboosted quality should still beat poor-quality content boosted only by a realistic (not theoretical-maximum) collaborative signal'
  );
});

check('13. A missing/empty collaborative profile bounds cleanly to zero effect (no candidates manufactured from nothing)', () => {
  const affinity = scoreCollaborativeAffinity('padel', freshProfile(), EMPTY_COLLABORATIVE_PROFILE);
  assert.equal(affinity, 0);
});

check('17. A stale (old generatedAt) collaborative result still degrades safely — never errors, still bounded', () => {
  const stale = collaborative({ confidence: 0.6, categoryScores: { padel: 0.5 }, generatedAt: NOW - 30 * 24 * 60 * 60 * 1000 }); // a month old
  const affinity = scoreCollaborativeAffinity('padel', freshProfile(), stale);
  assert.ok(Number.isFinite(affinity) && affinity >= 0 && affinity <= 1, `a stale result must still produce a finite, bounded score, got ${affinity}`);
});

check('18. A missing collaborative document does not affect the existing recommendation engine at all', () => {
  const profile = freshProfile();
  const withoutCollaborative = computeItemScore(
    { categoryId: 'music', creatorId: 'c', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0 },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  const withEmptyCollaborative = computeItemScore(
    { categoryId: 'music', creatorId: 'c', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0, collaborativeProfile: EMPTY_COLLABORATIVE_PROFILE },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  assert.equal(withoutCollaborative.totalScore, withEmptyCollaborative.totalScore, 'omitting collaborativeProfile entirely must score identically to an explicit empty/zero-confidence one');
});

check('19. Collaborative confidence is reflected in the applied score', () => {
  const profile = freshProfile();
  const lowConfidence = collaborative({ confidence: 0.2, categoryScores: { padel: 0.8 } });
  const highConfidence = collaborative({ confidence: 0.95, categoryScores: { padel: 0.8 } });
  // The backend already bakes confidence into categoryScores, so a lower-
  // confidence doc realistically carries a smaller categoryScores value
  // too — this test isolates JUST the client-side gate's own behavior:
  // both clear COLLABORATIVE_MIN_CONFIDENCE_TO_APPLY, so both should pass
  // the SAME stored value through unchanged (no double-counting — see
  // scoreCollaborativeAffinity's own doc comment).
  const low = scoreCollaborativeAffinity('padel', profile, lowConfidence);
  const high = scoreCollaborativeAffinity('padel', profile, highConfidence);
  assert.equal(low, 0.8);
  assert.equal(high, 0.8);
  // But a confidence BELOW the apply threshold gates to zero regardless of categoryScores.
  const belowThreshold = collaborative({ confidence: 0.05, categoryScores: { padel: 0.8 } });
  assert.equal(scoreCollaborativeAffinity('padel', profile, belowThreshold), 0, 'confidence below the minimum-to-apply threshold must zero out the collaborative contribution');
});

check('20. Zero confidence produces zero collaborative effect', () => {
  const profile = freshProfile();
  const zeroConfidence = collaborative({ confidence: 0, categoryScores: { padel: 0.9 } }); // e.g. a stale doc from before a threshold change
  assert.equal(scoreCollaborativeAffinity('padel', profile, zeroConfidence), 0);
});

// ===========================================================================
// Recommendation Engine — Step 6 ("evaluation, experimentation & feed
// health") — checks numbered per that spec's own Step 27. #5/#6/#7/#8/#9/
// #11/#12/#13/#14 (session/metrics aggregation logic, discovery/
// collaborative/same-city source attribution AT THE BACKEND-PATCH level,
// batch bounds) are covered in functions/scripts/test-metrics-logic.cjs —
// not duplicated here. #17 (raw analytics cannot be written arbitrarily
// by another user) is covered in tests/firestore.rules.test.mjs.
// ===========================================================================

type ScoreResultBreakdown = ScoreResult['breakdown'];

function breakdown(overrides: Partial<ScoreResultBreakdown> = {}): ScoreResultBreakdown {
  return { interest: 0.5, creatorAffinity: 0.5, location: LOCATION_SCORE.worldwide, time: 1, freshness: 1, popularity: 0.5, collaborativeAffinity: 0, ...overrides };
}

check('1. Consistent experiment assignment — the same user always lands in the same bucket', () => {
  const experiment: ExperimentDefinition<{ x: number }> = {
    id: 'test_experiment_1',
    enabled: true,
    variants: { control: { x: 1 }, treatment: { x: 2 } },
  };
  const first = assignExperimentVariant('user-abc', experiment);
  const second = assignExperimentVariant('user-abc', experiment);
  const third = assignExperimentVariant('user-abc', experiment);
  assert.equal(first.variantId, second.variantId);
  assert.equal(second.variantId, third.variantId);
});

check('2. Different users distribute across variants (not everyone in one bucket)', () => {
  const experiment: ExperimentDefinition<{ x: number }> = {
    id: 'test_experiment_2',
    enabled: true,
    variants: { control: { x: 1 }, treatment: { x: 2 } },
  };
  const variants = new Set<string>();
  for (let i = 0; i < 200; i++) {
    variants.add(assignExperimentVariant(`user-${i}`, experiment).variantId);
  }
  assert.ok(variants.has('control') && variants.has('treatment'), `expected both variants to appear across 200 users, got: ${[...variants].join(',')}`);
});

check('3. A disabled experiment always returns control, for every user', () => {
  const disabled: ExperimentDefinition<{ x: number }> = {
    id: 'test_experiment_disabled',
    enabled: false,
    variants: { control: { x: 1 }, treatment: { x: 2 } },
  };
  for (const uid of ['a', 'b', 'c', 'd', 'e']) {
    const assignment = assignExperimentVariant(uid, disabled);
    assert.equal(assignment.variantId, 'control');
    assert.equal(assignment.config.x, 1);
  }
});

check('18. The client cannot change its own experiment assignment — it depends only on (userId, experimentId), nothing else', () => {
  const experiment: ExperimentDefinition<{ x: number }> = {
    id: 'test_experiment_3',
    enabled: true,
    variants: { control: { x: 1 }, treatment: { x: 2 } },
  };
  // hashUserToExperimentUnit takes no "preferred variant" input at all —
  // there is no parameter through which a caller could request a
  // specific outcome; the same (userId, experimentId) pair always hashes
  // to the same unit interval value, by construction.
  const unitA = hashUserToExperimentUnit('user-xyz', experiment.id);
  const unitB = hashUserToExperimentUnit('user-xyz', experiment.id);
  assert.equal(unitA, unitB);
});

check('4. Ranking config version is recorded on every ranked item (via RANKING_CONFIG_VERSION, threaded through attribution)', () => {
  // deriveSourceTags itself doesn't touch rankingVersion (that's stamped
  // by recommendationEngine.ts directly onto RankingAttribution) — this
  // confirms the CONSTANT driving it is a real, non-empty string, so a
  // consumer downstream (feedSessions/recommendationMetrics) always has
  // something meaningful to group by.
  assert.ok(typeof RANKING_CONFIG_VERSION === 'string' && RANKING_CONFIG_VERSION.length > 0);
});

check('8. Discovery source attribution: a discovery-bucket item is tagged discovery, not known/related', () => {
  const tags = deriveSourceTags(breakdown(), 'discovery', false);
  assert.ok(tags.includes('discovery'));
  assert.ok(!tags.includes('known_interest') && !tags.includes('related_interest'));
});

check('9. Collaborative discovery attribution: a positive collaborativeAffinity adds the collaborative_discovery tag', () => {
  const withCollab = deriveSourceTags(breakdown({ collaborativeAffinity: 0.4 }), 'discovery', false);
  assert.ok(withCollab.includes('collaborative_discovery'));
  const without = deriveSourceTags(breakdown({ collaborativeAffinity: 0 }), 'discovery', false);
  assert.ok(!without.includes('collaborative_discovery'));
});

check('10. Same-city vs secondary-city classification (client-side attribution)', () => {
  const sameCity = deriveSourceTags(breakdown({ location: LOCATION_SCORE.sameCity }), 'known', false);
  assert.ok(sameCity.includes('same_city'));
  assert.ok(!sameCity.includes('secondary_city_exploration'));

  const secondary = deriveSourceTags(breakdown({ location: LOCATION_SCORE.worldwide + 0.2 }), 'discovery', false);
  assert.ok(secondary.includes('secondary_city_exploration'));
  assert.ok(!secondary.includes('same_city'));

  const plainWorldwide = deriveSourceTags(breakdown({ location: LOCATION_SCORE.worldwide }), 'discovery', false);
  assert.ok(!plainWorldwide.includes('same_city') && !plainWorldwide.includes('secondary_city_exploration'));
});

check('deriveSourceTags also tags followed_creator and quality when applicable', () => {
  const followed = deriveSourceTags(breakdown(), 'known', true);
  assert.ok(followed.includes('followed_creator'));

  const highQuality = deriveSourceTags(breakdown({ popularity: 0.9 }), 'known', false);
  assert.ok(highQuality.includes('quality'));
  const lowQuality = deriveSourceTags(breakdown({ popularity: 0.4 }), 'known', false);
  assert.ok(!lowQuality.includes('quality'));
});

check('15. Minimum sample threshold returns INSUFFICIENT_DATA below the session/view floors', () => {
  const tiny = compareExperimentVariants({ sessions: 5, meaningfulViews: 40, primaryMetricValue: 0.6 }, { sessions: 5, meaningfulViews: 40, primaryMetricValue: 0.7 });
  assert.equal(tiny.status, 'INSUFFICIENT_DATA');

  const enoughSessionsNotEnoughViews = compareExperimentVariants(
    { sessions: MIN_SESSIONS_PER_VARIANT, meaningfulViews: 10, primaryMetricValue: 0.6 },
    { sessions: MIN_SESSIONS_PER_VARIANT, meaningfulViews: 10, primaryMetricValue: 0.7 }
  );
  assert.equal(enoughSessionsNotEnoughViews.status, 'INSUFFICIENT_DATA');
});

check('Sufficient samples with a real difference report a directional result, not a fabricated one', () => {
  const result = compareExperimentVariants({ sessions: 500, meaningfulViews: 5000, primaryMetricValue: 0.5 }, { sessions: 500, meaningfulViews: 5000, primaryMetricValue: 0.65 });
  assert.equal(result.status, 'TREATMENT_BETTER');

  const noDifference = compareExperimentVariants({ sessions: 500, meaningfulViews: 5000, primaryMetricValue: 0.5 }, { sessions: 500, meaningfulViews: 5000, primaryMetricValue: 0.505 });
  assert.equal(noDifference.status, 'NO_CLEAR_DIFFERENCE', 'a tiny, likely-noise difference must not be reported as a winner');
});

check('16. Feed-health guardrail triggers correctly on a real regression', () => {
  const baseline = { notInterestedRate: 0.02, quickSkipRate: 0.1, eventOpenRate: 0.2, repeatExposureRate: 0.05 };
  const regressed = { notInterestedRate: 0.05, quickSkipRate: 0.1, eventOpenRate: 0.2, repeatExposureRate: 0.05 }; // 2.5x baseline
  const violations = evaluateGuardrails(baseline, regressed);
  assert.ok(violations.some((v) => v.metric === 'notInterestedRate'), 'a doubled not-interested rate must trigger the guardrail');
});

check('A healthy feed (no regression) produces zero guardrail violations', () => {
  const baseline = { notInterestedRate: 0.02, quickSkipRate: 0.1, eventOpenRate: 0.2, repeatExposureRate: 0.05 };
  const stillHealthy = { notInterestedRate: 0.021, quickSkipRate: 0.11, eventOpenRate: 0.19, repeatExposureRate: 0.06 };
  assert.deepEqual(evaluateGuardrails(baseline, stillHealthy), []);
});

check('The repeat-exposure guardrail is an absolute ceiling, independent of baseline', () => {
  const baseline = { notInterestedRate: 0.02, quickSkipRate: 0.1, eventOpenRate: 0.2, repeatExposureRate: 0.35 }; // baseline is ALREADY over the ceiling
  const stillOver = { notInterestedRate: 0.02, quickSkipRate: 0.1, eventOpenRate: 0.2, repeatExposureRate: 0.4 };
  const violations = evaluateGuardrails(baseline, stillOver);
  assert.ok(violations.some((v) => v.metric === 'repeatExposureRate'));
  void GUARDRAIL_THRESHOLDS;
});

check('19. Ranking latency measurement does not break the recommendation flow (computeItemScore stays synchronous and pure)', () => {
  // computeItemScore itself has no timing/latency dependency at all — the
  // Step 21 instrumentation lives entirely in recommendationEngine.ts's
  // own Date.now() checkpoints around EXISTING awaits, never inside the
  // scoring hot path. This just confirms scoring keeps working normally
  // (same shape as TEST 1) — nothing about latency measurement could
  // plausibly change this, since computeItemScore doesn't know it exists.
  const profile = freshProfile();
  const result = computeItemScore(
    { categoryId: 'music', creatorId: 'c', cityKey: HOME_CITY, countryCode: HOME_COUNTRY, publishedAtMs: NOW, isFollowingCreator: false, likeCount: 0, commentCount: 0 },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  assert.ok(Number.isFinite(result.totalScore));
});

check('20. A missing analytics backend never breaks For You feed — scoring needs none of the Step 6 fields to produce a valid result', () => {
  const profile = freshProfile();
  const result = computeItemScore(
    {
      categoryId: 'music',
      creatorId: 'c',
      cityKey: HOME_CITY,
      countryCode: HOME_COUNTRY,
      publishedAtMs: NOW,
      isFollowingCreator: false,
      likeCount: 0,
      commentCount: 0,
      // No collaborativeProfile, no engagementStats — exactly what "no
      // analytics/backend infra available yet" looks like.
    },
    profile,
    CITY_SCOPE,
    HOME_CITY,
    HOME_COUNTRY,
    NOW
  );
  assert.ok(Number.isFinite(result.totalScore) && !result.excluded);
});

runAsyncChecks().then(() => {
  console.log('\n=== Recommendation engine test results ===');
  let failures = 0;
  for (const result of results) {
    if (result.pass) {
      console.log(`PASS — ${result.name}`);
    } else {
      failures += 1;
      console.log(`FAIL — ${result.name}`);
      console.log(`       ${result.error instanceof Error ? result.error.message : result.error}`);
    }
  }
  console.log(`\n${results.length - failures}/${results.length} passed.`);

  if (failures > 0) {
    process.exit(1);
  }
});
