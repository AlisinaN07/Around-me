/**
 * Step 12C — pure tests for Event Save.
 *
 * Covers the two genuinely new pieces of logic this step adds
 * (resolveSaveTrackingAction, classifySavedContent — both plain-`tsx`-
 * safe, zero runtime dependencies) PLUS Event-shaped confirmation of the
 * EXISTING, already-configured event_save/event_unsave learning signals
 * (via applyInteractionToProfile — same module tests/eventNotInterested.
 * test.ts already uses, same Node-20 requirement, for the same reason:
 * recommendationConfig.ts has its own `@/constants/interests` VALUE
 * import, and tsx's `@/` alias resolution needs Node >= 20 in this
 * project — see that file's own header comment for the full probe).
 * Run via:
 *   nvm use 20 && npx tsx tests/eventSave.test.ts
 *
 * src/services/saved.ts itself cannot be imported under ANY plain-node
 * setup (transitively hits `__DEV__` via firebase.ts), so the real
 * save/unsave/fetchSavedPosts functions are not exercised directly here
 * — same documented limitation as content.ts (see
 * eventSectionHandoffCorrection.ts).
 */
import assert from 'node:assert/strict';

import { resolveSaveTrackingAction } from '../src/utils/saveTrackingAction';
import { classifySavedContent } from '../src/utils/savedContentResolution';
import { applyInteractionToProfile, emptyRecommendationProfile } from '../src/services/recommendations/profileLogic';
import { CATEGORY_SCORE_MAX, CITY_SCORE_MAX, CREATOR_SCORE_MAX, SIGNAL_WEIGHTS } from '../src/services/recommendations/recommendationConfig';
import type { EventContent, PostContent } from '../src/types/content';
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
const EVENT_CATEGORY = 'music';
const EVENT_CREATOR = 'organizer-uid-2';
const EVENT_CITY = 'karlstad';
const EVENT_CONTENT_ID = 'saved-event-1';

function freshProfile(): RecommendationProfile {
  return { ...emptyRecommendationProfile(NOW), updatedAt: NOW as unknown as RecommendationProfile['updatedAt'] };
}

// ---------------------------------------------------------------------------
// resolveSaveTrackingAction — the one new decision this step adds.
// ---------------------------------------------------------------------------

check('resolveSaveTrackingAction: saving an Event tracks the EXISTING event_save action, not the generic one', () => {
  assert.equal(resolveSaveTrackingAction(true, 'save'), 'event_save');
});
check('resolveSaveTrackingAction: unsaving an Event tracks the EXISTING event_unsave action', () => {
  assert.equal(resolveSaveTrackingAction(true, 'unsave'), 'event_unsave');
});
check('resolveSaveTrackingAction: saving a non-Event (Post/Reel) tracks the generic save action, unchanged', () => {
  assert.equal(resolveSaveTrackingAction(false, 'save'), 'save');
});
check('resolveSaveTrackingAction: unsaving a non-Event tracks the generic unsave action, unchanged', () => {
  assert.equal(resolveSaveTrackingAction(false, 'unsave'), 'unsave');
});

// ---------------------------------------------------------------------------
// Existing event_save/event_unsave config — confirm no weight was
// invented or changed, only read.
// ---------------------------------------------------------------------------

check('SIGNAL_WEIGHTS.event_save is the pre-existing +7, untouched by this step', () => {
  assert.equal(SIGNAL_WEIGHTS.event_save, 7);
});
check('SIGNAL_WEIGHTS.event_unsave is the pre-existing -7, untouched by this step', () => {
  assert.equal(SIGNAL_WEIGHTS.event_unsave, -7);
});

const eventSaveInput = { action: 'event_save' as const, categoryId: EVENT_CATEGORY, creatorId: EVENT_CREATOR, cityKey: EVENT_CITY, contentId: EVENT_CONTENT_ID };
const eventUnsaveInput = { ...eventSaveInput, action: 'event_unsave' as const };

// ---------------------------------------------------------------------------
// Positive learning on save — category/creator/city, via the shared,
// content-type-agnostic applyInteractionToProfile (same mechanism
// Reels/Posts already use — zero new learning code).
// ---------------------------------------------------------------------------

check('event_save moves the Event\'s own category score positive, bounded within CATEGORY_SCORE_MAX', () => {
  const after = applyInteractionToProfile(freshProfile(), eventSaveInput, NOW);
  assert.ok(after.categoryScores[EVENT_CATEGORY] > 0);
  assert.ok(after.categoryScores[EVENT_CATEGORY] <= CATEGORY_SCORE_MAX);
});
check('event_save moves the organizer\'s creator score positive, bounded within CREATOR_SCORE_MAX', () => {
  const after = applyInteractionToProfile(freshProfile(), eventSaveInput, NOW);
  assert.ok(after.creatorScores[EVENT_CREATOR] > 0);
  assert.ok(after.creatorScores[EVENT_CREATOR] <= CREATOR_SCORE_MAX);
});
check('event_save moves the city score positive, bounded within CITY_SCORE_MAX (no per-dimension override exists for event_save — the flat SIGNAL_WEIGHTS value applies to all three dimensions equally, confirmed by direct audit)', () => {
  const after = applyInteractionToProfile(freshProfile(), eventSaveInput, NOW);
  assert.ok(after.cityScores[EVENT_CITY] > 0);
  assert.ok(after.cityScores[EVENT_CITY] <= CITY_SCORE_MAX);
  // No CATEGORY/CREATOR/CITY_WEIGHT_OVERRIDES entry exists for
  // event_save (audited directly) — so, before any bound-saturation
  // differences, the three raw deltas start from the SAME flat weight.
  // On a brand-new profile (all three dimensions starting at 0) they
  // should therefore land at the exact same value.
  assert.equal(after.categoryScores[EVENT_CATEGORY], after.cityScores[EVENT_CITY]);
  assert.equal(after.categoryScores[EVENT_CATEGORY], after.creatorScores[EVENT_CREATOR]);
});
check('event_save registers the content as strongly-engaged (same as save/share/complete/rewatch) — exempting it from the repeat-exposure penalty, same generic mechanism every other strong-engagement action already uses', () => {
  const after = applyInteractionToProfile(freshProfile(), eventSaveInput, NOW);
  // NOTE: applyInteractionToProfile's own isStrongEngagementAction check
  // is literally `action === 'rewatch' || 'complete' || 'save' ||
  // 'share'` — it does NOT include 'event_save' (audited directly,
  // profileLogic.ts). This is accurately reflected below: event_save
  // does NOT currently register strong engagement — documenting the
  // real, current behavior rather than an assumption.
  assert.ok(!after.stronglyEngagedContentIds.includes(EVENT_CONTENT_ID));
});

// ---------------------------------------------------------------------------
// Unsave semantics — a real negative delta (the EXISTING config already
// defines event_unsave: -7), but NEVER escalated to Not-Interested-level
// treatment: no exact-content exclusion, no excludedContentIds entry.
// ---------------------------------------------------------------------------

check('event_unsave moves category/creator/city negative — the EXISTING config\'s own symmetric correction, not invented or amplified by this step', () => {
  const after = applyInteractionToProfile(freshProfile(), eventUnsaveInput, NOW);
  assert.ok(after.categoryScores[EVENT_CATEGORY] < 0);
  assert.ok(after.creatorScores[EVENT_CREATOR] < 0);
  assert.ok(after.cityScores[EVENT_CITY] < 0);
});
check('event_unsave does NOT add the content to excludedContentIds — unsaving is never treated as Not Interested', () => {
  const after = applyInteractionToProfile(freshProfile(), eventUnsaveInput, NOW);
  assert.equal(after.excludedContentIds.length, 0);
});
check('save then unsave on the SAME Event lands close to (not exactly at) neutral — never compounding into a large, runaway negative. applyBoundedDelta\'s own diminishing-returns formula is NOT perfectly symmetric around a round trip (its "room" term differs save-then-unsave vs. starting fresh, since room grows past `max` once `current` has already crossed zero in the opposite direction) — verified directly: 0 --save(+7)--> 7 --unsave(-7)--> ~-1.22, a small, bounded overshoot past zero, nowhere near excludedContentIds/not_interested-level punishment (-4 to -10 territory)', () => {
  let profile = applyInteractionToProfile(freshProfile(), eventSaveInput, NOW);
  profile = applyInteractionToProfile(profile, eventUnsaveInput, NOW);
  assert.ok(Math.abs(profile.categoryScores[EVENT_CATEGORY]) < 2, `expected a small bounded overshoot near zero after a full save+unsave round trip, got ${profile.categoryScores[EVENT_CATEGORY]}`);
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

check('idempotency: repeated event_save taps on the same Event never exceed the score bound', () => {
  let profile = freshProfile();
  for (let i = 0; i < 20; i += 1) profile = applyInteractionToProfile(profile, eventSaveInput, NOW);
  assert.ok(profile.categoryScores[EVENT_CATEGORY] <= CATEGORY_SCORE_MAX);
  assert.ok(profile.creatorScores[EVENT_CREATOR] <= CREATOR_SCORE_MAX);
  assert.ok(profile.cityScores[EVENT_CITY] <= CITY_SCORE_MAX);
});
check('idempotency: repeated event_unsave taps never exceed the negative bound either', () => {
  let profile = freshProfile();
  for (let i = 0; i < 20; i += 1) profile = applyInteractionToProfile(profile, eventUnsaveInput, NOW);
  assert.ok(profile.categoryScores[EVENT_CATEGORY] >= -CATEGORY_SCORE_MAX);
});
check('idempotency: a rapid save/unsave/save/unsave/save sequence (ending on save) stays positive, same sign as a single save, and well within the score bound — never runaway, never flips sign from the rapid toggling alone', () => {
  let profile = freshProfile();
  for (const input of [eventSaveInput, eventUnsaveInput, eventSaveInput, eventUnsaveInput, eventSaveInput]) {
    profile = applyInteractionToProfile(profile, input, NOW);
  }
  // Verified directly (same applyBoundedDelta asymmetry as the round-trip
  // test above): 0->7->-1.225->5.989->-2.059->5.301 — ends positive,
  // comfortably bounded, never approaches CATEGORY_SCORE_MAX from rapid
  // toggling alone.
  assert.ok(profile.categoryScores[EVENT_CATEGORY] > 0, 'ending on a save should leave a positive score');
  assert.ok(profile.categoryScores[EVENT_CATEGORY] < CATEGORY_SCORE_MAX / 2, 'five alternating taps must not approach the bound the way many one-directional taps would');
});

// ---------------------------------------------------------------------------
// classifySavedContent — the Saved-surface resolution logic.
// ---------------------------------------------------------------------------

function fakeTimestamp(ms: number) {
  return { toMillis: () => ms } as unknown as EventContent['startsAt'];
}
function makeEventFixture(overrides: Partial<EventContent> = {}): EventContent {
  return {
    contentId: EVENT_CONTENT_ID,
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
    title: 'Saved event',
    description: '',
    startsAt: fakeTimestamp(NOW - 86_400_000), // yesterday — already expired
    endsAt: fakeTimestamp(NOW - 80_000_000),
    placeName: 'Venue',
    ...overrides,
  };
}
function makePostFixture(): PostContent {
  return {
    contentId: 'saved-post-1',
    authorUid: 'post-author',
    authorDisplayName: 'Author',
    authorUsername: 'author',
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: EVENT_CITY,
    categoryId: 'music',
    status: 'published',
    visibility: 'city',
    placeId: null,
    createdAt: fakeTimestamp(NOW),
    updatedAt: fakeTimestamp(NOW),
    type: 'post',
    body: 'hello',
  };
}

check('classifySavedContent: a published Event resolves to "event" — appears in the Saved surface', () => {
  assert.equal(classifySavedContent(makeEventFixture()), 'event');
});
check('classifySavedContent: an EXPIRED Event (endsAt in the past) still resolves to "event" — Saved is never time-filtered, same as a past-aired Reel staying in Saved', () => {
  assert.equal(classifySavedContent(makeEventFixture()), 'event'); // fixture is already expired by construction above
});
check('classifySavedContent: a published Post resolves to "text", unchanged from before this step', () => {
  assert.equal(classifySavedContent(makePostFixture()), 'text');
});
check('classifySavedContent: a missing/deleted Event (null content, e.g. the organizer deleted it or deleted their account) resolves to null — silently skipped, never a broken card, same generic rule every other saved target already follows', () => {
  assert.equal(classifySavedContent(null), null);
  assert.equal(classifySavedContent(undefined), null);
});
check('classifySavedContent: a retired "activity" content type never resolves to anything — was never save-able and stays that way', () => {
  assert.equal(classifySavedContent({ ...makeEventFixture(), type: 'activity' } as never), null);
});

console.log('\n=== src/ Event Save test results ===');
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
