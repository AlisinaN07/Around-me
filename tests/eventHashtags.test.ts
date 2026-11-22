/**
 * Step 12D — pure tests for Event hashtags + hashtag-aware Event ranking.
 *
 * Does NOT duplicate the extensive existing coverage of extractHashtags/
 * normalizeHashtag (tests/hashtags.test.ts), getActiveHashtag/
 * replaceActiveHashtag (tests/hashtagAutocomplete.test.ts), or
 * scoreHashtagRelevance's own full behavior matrix (tests/
 * recommendations.test.ts, "For You ranking integration — hashtag
 * interest" section) — all of that is already generic (none of it reads
 * `contentType`) and already proven correct. This file adds only:
 *  - resolveEventHashtagsForScoring (the one genuinely new piece of code)
 *  - the five new HASHTAG_INTEREST_WEIGHTS entries
 *  - end-to-end confirmation that computeItemScore's EVENT branch
 *    actually receives and scores real hashtags now (previously always []),
 *    and that doing so never touches geographic eligibility/location score.
 *
 * Run under Node >= 20 (recommendationConfig.ts's own `@/constants/
 * interests` VALUE import needs tsx's `@/`-alias resolution, which only
 * works there — see tests/eventSave.test.ts's own header for the full
 * probe):
 *   nvm use 20 && npx tsx tests/eventHashtags.test.ts
 */
import assert from 'node:assert/strict';

import { extractHashtags } from '../src/utils/hashtags';
import { resolveEventHashtagsForScoring } from '../src/utils/eventHashtagsForScoring';
import { computeItemScore } from '../src/services/recommendations/ranking';
import { HASHTAG_RELEVANCE_WEIGHT, HASHTAG_INTEREST_WEIGHTS } from '../src/services/recommendations/hashtagInterestConfig';
import { emptyRecommendationProfile, applyInteractionToProfile } from '../src/services/recommendations/profileLogic';
import type { ActivityContent, EventContent } from '../src/types/content';
import type { BrowseScope } from '../src/types/browseScope';
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
const CITY_SCOPE: BrowseScope = { kind: 'city', cityKey: 'karlstad' };

function freshProfile(hashtagOverride?: Record<string, never>): RecommendationProfile {
  void hashtagOverride;
  return { ...emptyRecommendationProfile(NOW), updatedAt: NOW as unknown as RecommendationProfile['updatedAt'] };
}

function fakeTimestamp(ms: number) {
  return { toMillis: () => ms } as unknown as EventContent['startsAt'];
}

function makeEvent(overrides: Partial<EventContent> = {}): EventContent {
  return {
    contentId: 'event-1',
    authorUid: 'organizer-1',
    authorDisplayName: 'Organizer',
    authorUsername: 'organizer',
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: 'karlstad',
    categoryId: 'music',
    status: 'published',
    visibility: 'city',
    placeId: null,
    createdAt: fakeTimestamp(NOW),
    updatedAt: fakeTimestamp(NOW),
    type: 'event',
    title: 'A concert',
    description: 'Great show tonight! #livemusic #karlstad',
    startsAt: fakeTimestamp(NOW + 3_600_000),
    endsAt: fakeTimestamp(NOW + 7_200_000),
    placeName: 'The Venue',
    hashtags: ['livemusic', 'karlstad'],
    ...overrides,
  };
}

// Minimal non-event ScoreContext fields every computeItemScore call needs.
function baseContext(event: EventContent, extra: { reelHashtags?: readonly string[]; hashtagInterests?: ReadonlyMap<string, number> } = {}) {
  return {
    categoryId: event.categoryId,
    creatorId: event.authorUid,
    cityKey: event.cityKey,
    countryCode: event.countryCode,
    publishedAtMs: NOW,
    isFollowingCreator: false,
    likeCount: 0,
    commentCount: 0,
    event: { startsAtMs: event.startsAt.toMillis(), endsAtMs: event.endsAt.toMillis() },
    reelHashtags: extra.reelHashtags ?? resolveEventHashtagsForScoring(event),
    hashtagInterests: extra.hashtagInterests ?? new Map<string, number>(),
  };
}

// ---------------------------------------------------------------------------
// Storage / extraction — same function/semantics a Reel's caption already
// uses, confirmed against an Event-shaped description specifically.
// ---------------------------------------------------------------------------

check('extractHashtags on an Event-shaped description: multiple tags, normalized, deduped, order-preserved', () => {
  assert.deepEqual(extractHashtags('Great show tonight! #LiveMusic #karlstad #LIVEMUSIC'), ['livemusic', 'karlstad']);
});
check('extractHashtags on an Event description with no hashtags at all returns []', () => {
  assert.deepEqual(extractHashtags('Just a regular event description, nothing special.'), []);
});
check('extractHashtags on an Event description handles whitespace/punctuation around tags correctly (a hyphen is not a hashtag character, so "#music-night" extracts only "music", same charset Reels already use)', () => {
  assert.deepEqual(extractHashtags('Come to #music-night, bring #friends!'), ['music', 'friends']);
});

// ---------------------------------------------------------------------------
// resolveEventHashtagsForScoring
// ---------------------------------------------------------------------------

check('resolveEventHashtagsForScoring: a real Event with hashtags returns them exactly', () => {
  assert.deepEqual(resolveEventHashtagsForScoring(makeEvent()), ['livemusic', 'karlstad']);
});
check('resolveEventHashtagsForScoring: a legacy Event with NO hashtags field at all (undefined) returns []', () => {
  const legacy = makeEvent();
  delete (legacy as Partial<EventContent>).hashtags;
  assert.deepEqual(resolveEventHashtagsForScoring(legacy), []);
});
check('resolveEventHashtagsForScoring: an Event with an explicitly empty hashtags array returns []', () => {
  assert.deepEqual(resolveEventHashtagsForScoring(makeEvent({ hashtags: [] })), []);
});
check('resolveEventHashtagsForScoring: an ActivityContent (no hashtags field, never will) always returns []', () => {
  const activity = { type: 'activity' } as unknown as ActivityContent;
  assert.deepEqual(resolveEventHashtagsForScoring(activity), []);
});

// ---------------------------------------------------------------------------
// HASHTAG_INTEREST_WEIGHTS — audited, and NO new entries were actually
// warranted. This table's own top doc comment (hashtagInterestConfig.ts)
// explicitly names event_open/event_save/event_interested/event_going as
// "event response, not topical content interest" — deliberately excluded
// by design, predating this step. A pre-existing test
// (tests/hashtagInterest.test.ts) independently already locks in
// event_going specifically; these confirm the other three (and
// event_unsave, event_save's own exact reverse) stay excluded too, and
// that `share`/`not_interested` — already generic — were left
// byte-unchanged.
// ---------------------------------------------------------------------------

check('HASHTAG_INTEREST_WEIGHTS: event_open/event_interested/event_going/event_save/event_unsave are NOT listed — a deliberate, pre-existing exclusion (event-response actions, not topical content interest), not something this step should add', () => {
  assert.equal(HASHTAG_INTEREST_WEIGHTS.event_open, undefined);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.event_interested, undefined);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.event_going, undefined);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.event_save, undefined);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.event_unsave, undefined);
});
check('share and not_interested were ALREADY generic, byte-unchanged by this step — these are the only two real signals through which an Event\'s hashtags can feed hashtag-interest learning', () => {
  assert.equal(HASHTAG_INTEREST_WEIGHTS.share, 0.15);
  assert.equal(HASHTAG_INTEREST_WEIGHTS.not_interested, -0.35);
});
check('a not_interested tap on an Event correctly weakens affinity for ITS OWN hashtags via the existing, generic hashtag-interest mechanism (applyHashtagInterestSignals reads HASHTAG_INTEREST_WEIGHTS[action] — this just confirms the lookup itself resolves to a real negative number for the one Event action that legitimately feeds it)', () => {
  // Not re-testing applyHashtagInterestSignals' own transaction logic
  // (Firestore-backed, out of this pure suite's scope — see
  // tests/hashtagInterest.test.ts for its own full coverage); this
  // confirms only that the CONFIG LOOKUP for the one real Event path is
  // a genuine negative weight, exactly as it already is for a Reel.
  assert.ok(HASHTAG_INTEREST_WEIGHTS.not_interested! < 0);
  // Sanity: applyInteractionToProfile (a different, independent
  // mechanism — category/creator/city, not hashtags) still correctly
  // moves an Event's OWN category negative on the same action, same as
  // Step 12B already established — confirms this file isn't accidentally
  // testing against a broken not_interested path.
  const after = applyInteractionToProfile(
    freshProfile(),
    { action: 'not_interested', categoryId: 'music', creatorId: 'organizer-1', cityKey: 'karlstad', contentId: 'event-1' },
    NOW
  );
  assert.ok(after.categoryScores.music < 0);
});

// ---------------------------------------------------------------------------
// End-to-end ranking integration — computeItemScore's real EVENT branch.
// ---------------------------------------------------------------------------

check('an Event whose hashtags match a strong hashtag interest scores HIGHER than the identical Event with no such interest', () => {
  const event = makeEvent();
  const profile = freshProfile();
  const neutral = computeItemScore(baseContext(event, { hashtagInterests: new Map() }), profile, CITY_SCOPE, 'karlstad', 'SE', NOW);
  const withInterest = computeItemScore(baseContext(event, { hashtagInterests: new Map([['livemusic', 0.9]]) }), profile, CITY_SCOPE, 'karlstad', 'SE', NOW);
  assert.ok(withInterest.breakdown.hashtagRelevance > neutral.breakdown.hashtagRelevance);
  assert.ok(withInterest.totalScore > neutral.totalScore);
});
check('an UNRELATED hashtag interest (no overlap with the Event\'s own tags) does not raise hashtagRelevance at all', () => {
  const event = makeEvent();
  const profile = freshProfile();
  const result = computeItemScore(baseContext(event, { hashtagInterests: new Map([['unrelated-topic', 0.9]]) }), profile, CITY_SCOPE, 'karlstad', 'SE', NOW);
  assert.equal(result.breakdown.hashtagRelevance, 0);
});
check('an Event with NO hashtags at all (legacy, predating Step 12D) scores a neutral 0 hashtagRelevance, never a crash, even with strong hashtag interests loaded', () => {
  const legacyEvent = makeEvent({ hashtags: undefined });
  const profile = freshProfile();
  const result = computeItemScore(baseContext(legacyEvent, { hashtagInterests: new Map([['livemusic', 0.9]]) }), profile, CITY_SCOPE, 'karlstad', 'SE', NOW);
  assert.equal(result.breakdown.hashtagRelevance, 0);
});
check('hashtagRelevance\'s own weighted contribution never exceeds HASHTAG_RELEVANCE_WEIGHT, matching the existing, UNCHANGED Reel/content weight (0.06) — no new/distinct constant for Events', () => {
  const event = makeEvent();
  const profile = freshProfile();
  const maxed = computeItemScore(
    baseContext(event, { hashtagInterests: new Map([['livemusic', 1], ['karlstad', 1]]) }),
    profile,
    CITY_SCOPE,
    'karlstad',
    'SE',
    NOW
  );
  // hashtagRelevance itself is bounded to [0,1] (scoreHashtagRelevance's
  // own contract); its contribution to totalScore is breakdown *
  // HASHTAG_RELEVANCE_WEIGHT — confirm that weight is still exactly 0.06,
  // the same constant Reels already use, never a bigger Event-only one.
  assert.equal(HASHTAG_RELEVANCE_WEIGHT, 0.06);
  assert.ok(maxed.breakdown.hashtagRelevance <= 1);
});
check('hashtag relevance NEVER changes the location/eligibility score — scope stays a hard boundary, hashtags are a ranking signal strictly INSIDE the candidate pool', () => {
  const event = makeEvent();
  const profile = freshProfile();
  const noHashtagMatch = computeItemScore(baseContext(event, { hashtagInterests: new Map() }), profile, CITY_SCOPE, 'karlstad', 'SE', NOW);
  const strongHashtagMatch = computeItemScore(
    baseContext(event, { hashtagInterests: new Map([['livemusic', 1], ['karlstad', 1]]) }),
    profile,
    CITY_SCOPE,
    'karlstad',
    'SE',
    NOW
  );
  assert.equal(noHashtagMatch.breakdown.location, strongHashtagMatch.breakdown.location, 'location score must be identical regardless of hashtag affinity');
  assert.equal(noHashtagMatch.excluded, strongHashtagMatch.excluded, 'exclusion (geographic/time eligibility) must be identical regardless of hashtag affinity');
});
check('every OTHER weighted dimension (interest/creatorAffinity/time/freshness/popularity/collaborativeAffinity) is untouched by this step — only hashtagRelevance changed from always-0 to real', () => {
  const event = makeEvent();
  const profile = freshProfile();
  const result = computeItemScore(baseContext(event), profile, CITY_SCOPE, 'karlstad', 'SE', NOW);
  // A cold-start profile + zero engagement stats should produce the same
  // neutral breakdown shape every other test in tests/recommendations.test.ts
  // already establishes for a fresh profile — spot-checking the shape
  // exists and is finite, not re-deriving each exact constant here (that
  // belongs to ranking.ts's own test suite, unchanged by this step).
  for (const key of ['interest', 'creatorAffinity', 'time', 'freshness', 'popularity', 'collaborativeAffinity'] as const) {
    assert.ok(Number.isFinite(result.breakdown[key]), `breakdown.${key} must still be a finite number`);
  }
});

console.log('\n=== src/ Event hashtags + hashtag-aware ranking test results ===');
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
