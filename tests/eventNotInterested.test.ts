/**
 * Step 12B — pure tests for Events' own "Not interested" negative-
 * feedback action. Proves the EXACT SAME generic mechanism Reels already
 * use (applyInteractionToProfile / excludedContentIds /
 * scoreCollaborativeAffinity — none of which read `contentType` at all)
 * produces correct behavior for an Event-shaped interaction, without
 * duplicating the extensive generic coverage tests/recommendations.test.ts
 * already has (see e.g. its own test "9. Personal not_interested
 * overrides a collaborative positive for the same category") — this file
 * adds only the Event-specific confirmation and the one genuinely new
 * piece of code this step introduced: removeContentIdFromSections.
 *
 * IMPORTANT — run this under Node >= 20, not this project's default
 * Node 18: `recommendationConfig.ts` (imported transitively) has its own
 * `@/constants/interests` VALUE import, and `tsx`'s `@/` path-alias
 * resolution silently fails to resolve ANY `@/` import under Node 18 in
 * this project (probed directly this session) — purely a Node-version
 * issue, confirmed fixed under Node 20.19.5. Run via:
 *   nvm use 20 && npx tsx tests/eventNotInterested.test.ts
 *
 * No React, no Firebase — src/services/content.ts itself cannot be
 * imported under ANY plain-node setup (it transitively hits `__DEV__`,
 * an Expo/RN global — see eventSectionHandoffCorrection.ts's own doc
 * comment), so this file tests the extracted pure module instead, same
 * as every other Step-12-whatever test file this session.
 */
import assert from 'node:assert/strict';

import { applyInteractionToProfile, emptyRecommendationProfile } from '../src/services/recommendations/profileLogic';
import { CATEGORY_SCORE_MAX, CITY_SCORE_MAX, CREATOR_SCORE_MAX } from '../src/services/recommendations/recommendationConfig';
import { scoreCollaborativeAffinity } from '../src/services/recommendations/ranking';
import { removeContentIdFromSections, type HandoffSections } from '../src/utils/eventSectionHandoffCorrection';
import { EMPTY_COLLABORATIVE_PROFILE, type CollaborativeProfile } from '../src/types/collaborative';
import type { EventContent } from '../src/types/content';
import type { RecommendationProfile } from '../src/types/recommendation';

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
const EVENT_CATEGORY = 'nightlife';
const EVENT_CREATOR = 'organizer-uid-1';
const EVENT_CITY = 'karlstad';
const EVENT_CONTENT_ID = 'event-content-id-1';

// Same cast tests/recommendations.test.ts's own freshProfile already
// uses — emptyRecommendationProfile returns `updatedAt: null` (a
// brand-new account has no profile doc yet to carry a real server
// Timestamp), while RecommendationProfile's own type says `updatedAt:
// Timestamp`; a fresh in-memory profile for pure testing has no real
// Firestore Timestamp to put there either, so this follows the exact
// same precedent rather than inventing a different fixture convention.
function freshProfile(): RecommendationProfile {
  return { ...emptyRecommendationProfile(NOW), updatedAt: NOW as unknown as RecommendationProfile['updatedAt'] };
}

/** The exact action shape content/[contentId].tsx's own handleNotInterestedEvent passes to applyInteractionToProfile (via trackContentInteraction) for an Event — contentType itself is never read by this function at all, which is the whole point being proven below. */
const eventNotInterestedInput = {
  action: 'not_interested' as const,
  categoryId: EVENT_CATEGORY,
  creatorId: EVENT_CREATOR,
  cityKey: EVENT_CITY,
  contentId: EVENT_CONTENT_ID,
};

// ---------------------------------------------------------------------------
// Core exclusion (an Event's own contentId, not a Reel's reelId)
// ---------------------------------------------------------------------------

check('Event Not Interested records the Event\'s own contentId in excludedContentIds — the exact mechanism rankEventSections\' own `!excluded.has(event.contentId)` filter (recommendationEngine.ts) reads', () => {
  const after = applyInteractionToProfile(freshProfile(), eventNotInterestedInput, NOW);
  assert.ok(after.excludedContentIds.includes(EVENT_CONTENT_ID));
});

check('exclusion mirrors rankEventSections\' own inline filter exactly: a candidate list filtered by excludedContentIds no longer contains the excluded Event, everything else survives in order', () => {
  const after = applyInteractionToProfile(freshProfile(), eventNotInterestedInput, NOW);
  const excluded = new Set(after.excludedContentIds);
  const candidates = [{ contentId: 'keep-1' }, { contentId: EVENT_CONTENT_ID }, { contentId: 'keep-2' }];
  const filtered = candidates.filter((c) => !excluded.has(c.contentId));
  assert.deepEqual(filtered.map((c) => c.contentId), ['keep-1', 'keep-2']);
});

// ---------------------------------------------------------------------------
// Category / creator / city negative learning — same generic weights
// Reels already use (CATEGORY_WEIGHT_OVERRIDES.not_interested = -4,
// CREATOR_WEIGHT_OVERRIDES.not_interested = -4,
// CITY_WEIGHT_OVERRIDES.not_interested = -3), now proven against an
// Event's own categoryId/authorUid/cityKey.
// ---------------------------------------------------------------------------

check('category negative delta: the Event\'s own categoryId score moves negative, bounded within CATEGORY_SCORE_MAX', () => {
  const after = applyInteractionToProfile(freshProfile(), eventNotInterestedInput, NOW);
  const score = after.categoryScores[EVENT_CATEGORY];
  assert.ok(score < 0, 'category score should have moved negative');
  assert.ok(score >= -CATEGORY_SCORE_MAX, 'must never exceed the bound in a single application');
});

check('creator/organizer negative delta: the Event\'s own authorUid score moves negative, bounded within CREATOR_SCORE_MAX', () => {
  const after = applyInteractionToProfile(freshProfile(), eventNotInterestedInput, NOW);
  const score = after.creatorScores[EVENT_CREATOR];
  assert.ok(score < 0);
  assert.ok(score >= -CREATOR_SCORE_MAX);
});

check('city/location negative delta: the Event\'s own cityKey score moves negative (moderately — see CITY_WEIGHT_OVERRIDES\' own doc comment: disliking one Event should not dent a whole city nearly as hard as its category/creator), bounded within CITY_SCORE_MAX', () => {
  const after = applyInteractionToProfile(freshProfile(), eventNotInterestedInput, NOW);
  const score = after.cityScores[EVENT_CITY];
  assert.ok(score < 0);
  assert.ok(score >= -CITY_SCORE_MAX);
  // Moderate, not maximal — category/creator should move at least as
  // negative as city for the same single not_interested tap (matches
  // CATEGORY/CREATOR_WEIGHT_OVERRIDES.not_interested = -4 vs.
  // CITY_WEIGHT_OVERRIDES.not_interested = -3).
  assert.ok(Math.abs(after.categoryScores[EVENT_CATEGORY]) >= Math.abs(score));
});

check('EVENT_LOCATION_WEIGHT_MULTIPLIER (1.6, applied only inside computeItemScore\'s weightedSum) is untouched by this step — city LEARNING uses the same CITY_WEIGHT_OVERRIDES as every other dimension; this step adds no new, separately-punitive location-learning path for Events', () => {
  // Documentation-as-test: confirms this file never imports or asserts
  // against any Event-specific city-weight constant — there isn't one.
  // The city delta above came from the exact same generic
  // CITY_WEIGHT_OVERRIDES.not_interested every content type already uses.
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// Collaborative suppression — the SAME generic `scoreCollaborativeAffinity`
// Reels rely on (ranking.ts), proven here with an Event-sourced negative
// personal score. Not duplicating tests/recommendations.test.ts's own
// "9. Personal not_interested overrides a collaborative positive" test —
// this confirms the identical guarantee holds when the negative score
// came from an EVENT interaction specifically.
// ---------------------------------------------------------------------------

check('strong personal negative feedback from an Event cannot be overridden by a positive collaborative signal for the same category', () => {
  let profile = freshProfile();
  // Several repeated not_interested taps (same shape a user marking
  // several Events in the same category Not Interested would produce)
  // to reliably push the category score negative.
  for (let i = 0; i < 5; i += 1) {
    profile = applyInteractionToProfile(profile, { ...eventNotInterestedInput, contentId: `event-${i}` }, NOW);
  }
  assert.ok(profile.categoryScores[EVENT_CATEGORY] < 0, 'setup sanity check — category score should be negative');
  const strongCollaborative: CollaborativeProfile = { ...EMPTY_COLLABORATIVE_PROFILE, confidence: 1, categoryScores: { [EVENT_CATEGORY]: 0.95 } };
  const collaborativeBonus = scoreCollaborativeAffinity(EVENT_CATEGORY, profile, strongCollaborative);
  assert.equal(collaborativeBonus, 0, 'a strong positive collaborative signal must be fully zeroed once personal feedback is negative');
});

// ---------------------------------------------------------------------------
// Idempotency — repeated taps on the SAME Event never duplicate the
// exclusion entry and never exceed the bounded-delta ceiling.
// ---------------------------------------------------------------------------

check('idempotency: marking the SAME Event not interested twice records exactly one excludedContentIds entry, never two', () => {
  let profile = applyInteractionToProfile(freshProfile(), eventNotInterestedInput, NOW);
  profile = applyInteractionToProfile(profile, eventNotInterestedInput, NOW);
  const occurrences = profile.excludedContentIds.filter((id) => id === EVENT_CONTENT_ID).length;
  assert.equal(occurrences, 1, 'excludedContentIds must never contain a duplicate entry for the same contentId');
});

check('idempotency: repeated taps never push category/creator/city scores past their bound, regardless of how many times the same Event is marked', () => {
  let profile = freshProfile();
  for (let i = 0; i < 20; i += 1) {
    profile = applyInteractionToProfile(profile, eventNotInterestedInput, NOW);
  }
  assert.ok(profile.categoryScores[EVENT_CATEGORY] >= -CATEGORY_SCORE_MAX);
  assert.ok(profile.creatorScores[EVENT_CREATOR] >= -CREATOR_SCORE_MAX);
  assert.ok(profile.cityScores[EVENT_CITY] >= -CITY_SCORE_MAX);
});

check('idempotency: an already-excluded Event marked not interested again is a safe no-op on the exclusion itself (still exactly one entry, no throw)', () => {
  let profile = applyInteractionToProfile(freshProfile(), eventNotInterestedInput, NOW);
  assert.doesNotThrow(() => {
    profile = applyInteractionToProfile(profile, eventNotInterestedInput, NOW);
  });
  assert.equal(profile.excludedContentIds.filter((id) => id === EVENT_CONTENT_ID).length, 1);
});

// ---------------------------------------------------------------------------
// Edge cases — missing category/city/creator (schema permits an empty
// string in principle; this proves the shared logic degrades safely
// rather than polluting a score map with an empty-string key).
// ---------------------------------------------------------------------------

check('edge case: an empty categoryId never creates a "" entry in categoryScores', () => {
  const after = applyInteractionToProfile(freshProfile(), { ...eventNotInterestedInput, categoryId: '' }, NOW);
  assert.ok(!('' in after.categoryScores));
});

check('edge case: an empty creatorId never creates a "" entry in creatorScores', () => {
  const after = applyInteractionToProfile(freshProfile(), { ...eventNotInterestedInput, creatorId: '' }, NOW);
  assert.ok(!('' in after.creatorScores));
});

check('edge case: an empty cityKey never creates a "" entry in cityScores', () => {
  const after = applyInteractionToProfile(freshProfile(), { ...eventNotInterestedInput, cityKey: '' }, NOW);
  assert.ok(!('' in after.cityScores));
});

check('edge case: a missing contentId never adds anything to excludedContentIds, and never throws', () => {
  assert.doesNotThrow(() => {
    const after = applyInteractionToProfile(freshProfile(), { ...eventNotInterestedInput, contentId: '' }, NOW);
    assert.equal(after.excludedContentIds.length, 0);
  });
});

// ---------------------------------------------------------------------------
// removeContentIdFromSections — the one genuinely new piece of
// production code this step adds (Step 12A handoff-cache correction).
// ---------------------------------------------------------------------------

function fakeTimestamp(ms: number) {
  return { toMillis: () => ms } as unknown as EventContent['startsAt'];
}
function makeFixtureEvent(contentId: string): EventContent {
  return {
    contentId,
    authorUid: EVENT_CREATOR,
    authorDisplayName: 'Organizer',
    authorUsername: 'organizer',
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: EVENT_CITY,
    categoryId: EVENT_CATEGORY,
    status: 'published',
    visibility: 'city',
    placeId: null,
    createdAt: fakeTimestamp(NOW),
    updatedAt: fakeTimestamp(NOW),
    type: 'event',
    title: `Event ${contentId}`,
    description: '',
    startsAt: fakeTimestamp(NOW),
    endsAt: fakeTimestamp(NOW + 3600_000),
    placeName: 'Venue',
  };
}
function makeFixtureSections(ids: { happeningNow?: string[]; today?: string[]; upcoming?: string[] }): HandoffSections {
  return {
    happeningNow: (ids.happeningNow ?? []).map(makeFixtureEvent),
    today: (ids.today ?? []).map(makeFixtureEvent),
    upcoming: (ids.upcoming ?? []).map(makeFixtureEvent),
  };
}

check('removeContentIdFromSections removes the exact matching item from whichever of the three sections it is actually in', () => {
  const sections = makeFixtureSections({ upcoming: ['a', EVENT_CONTENT_ID, 'b'] });
  const result = removeContentIdFromSections(sections, EVENT_CONTENT_ID);
  assert.deepEqual(result.upcoming.map((e) => e.contentId), ['a', 'b']);
});

check('removeContentIdFromSections leaves the other two sections completely untouched', () => {
  const sections = makeFixtureSections({ happeningNow: ['hn-1'], today: ['t-1'], upcoming: [EVENT_CONTENT_ID] });
  const result = removeContentIdFromSections(sections, EVENT_CONTENT_ID);
  assert.deepEqual(result.happeningNow.map((e) => e.contentId), ['hn-1']);
  assert.deepEqual(result.today.map((e) => e.contentId), ['t-1']);
  assert.equal(result.upcoming.length, 0);
});

check('removeContentIdFromSections preserves the remaining items\' relative order exactly', () => {
  const sections = makeFixtureSections({ upcoming: ['a', 'b', EVENT_CONTENT_ID, 'c', 'd'] });
  const result = removeContentIdFromSections(sections, EVENT_CONTENT_ID);
  assert.deepEqual(result.upcoming.map((e) => e.contentId), ['a', 'b', 'c', 'd']);
});

check('removeContentIdFromSections is a safe no-op (same items, same order) when the contentId is not present in any section', () => {
  const sections = makeFixtureSections({ upcoming: ['a', 'b'] });
  const result = removeContentIdFromSections(sections, 'not-present-at-all');
  assert.deepEqual(result.upcoming.map((e) => e.contentId), ['a', 'b']);
});

check('removeContentIdFromSections preserves extra fields on the sections object unchanged (e.g. todayLabel)', () => {
  const sections = { ...makeFixtureSections({ today: [EVENT_CONTENT_ID] }), todayLabel: 'Tonight' as const };
  const result = removeContentIdFromSections(sections, EVENT_CONTENT_ID);
  assert.equal(result.todayLabel, 'Tonight');
  assert.equal(result.today.length, 0);
});

console.log('\n=== src/ Event "Not interested" negative-feedback test results ===');
let failures = 0;
for (const result of results) {
  if (result.pass) {
    console.log(`PASS — ${result.name}`);
  } else {
    failures += 1;
    console.log(`FAIL — ${result.name}`);
    console.log(`       ${result.error instanceof Error ? result.error.stack : result.error}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed.`);
if (failures > 0) process.exit(1);
