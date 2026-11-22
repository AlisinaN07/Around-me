/**
 * Step 12A — pure tests for the Events "Show more" ranking-consistency
 * fix: src/utils/eventSectionHandoffKey.ts (cache-key isolation) and
 * src/utils/eventSectionSelection.ts (section-selection/prefix
 * consistency). No React, no Firebase — both files under test are
 * dependency-light enough to run under plain `tsx` (content.ts and
 * section.tsx themselves are NOT — see each pure file's own doc comment
 * for why this test imports the extracted pure modules, not the real
 * screen/service files directly), run via:
 *   npx tsx tests/eventsSectionHandoff.test.ts
 */
import assert from 'node:assert/strict';

import { forYouHandoffKey, followingHandoffKey } from '../src/utils/eventSectionHandoffKey';
import { isSectionKind, selectComingUp, selectItems } from '../src/utils/eventSectionSelection';
import type { BrowseScope } from '../src/types/browseScope';
import type { DiscoverySections } from '../src/services/content';
import type { EventContent } from '../src/types/content';

const results: { name: string; pass: boolean; error?: unknown }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

// ---------------------------------------------------------------------------
// Fixtures — a minimal EventContent-shaped object with a real
// `.toMillis()` (what selectComingUp's weekend split actually calls),
// deliberately NOT a real Firebase Timestamp (importing firebase/
// firestore's VALUE export isn't needed here, and this keeps this file
// free of any import that could jeopardize its plain-`tsx` runnability).
// ---------------------------------------------------------------------------

function fakeTimestamp(ms: number) {
  return { toMillis: () => ms } as unknown as EventContent['startsAt'];
}

// Deliberately far in the past relative to "now" (this test runs in
// 2026+) — guarantees these fixtures never accidentally land inside
// getWeekendWindow()'s real current-time window, so selectComingUp's
// weekend split behaves deterministically (its own `weekendIds.size > 0`
// branch never fires for these fixtures) without needing to fake Date.
const FAR_PAST_MS = new Date('2000-01-01T00:00:00Z').getTime();

function makeEvent(contentId: string, startMs = FAR_PAST_MS): EventContent {
  return {
    contentId,
    authorUid: 'author-1',
    authorDisplayName: 'Author',
    authorUsername: 'author',
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: 'karlstad',
    categoryId: 'music',
    status: 'published',
    visibility: 'city',
    placeId: null,
    createdAt: fakeTimestamp(startMs) as unknown as EventContent['createdAt'],
    updatedAt: fakeTimestamp(startMs) as unknown as EventContent['updatedAt'],
    type: 'event',
    title: `Event ${contentId}`,
    description: '',
    startsAt: fakeTimestamp(startMs),
    endsAt: fakeTimestamp(startMs + 60 * 60 * 1000),
    placeName: 'Some venue',
  };
}

function makeSections(ids: string[]): DiscoverySections {
  return {
    happeningNow: [],
    todayLabel: 'Today',
    today: [],
    upcoming: ids.map((id) => makeEvent(id)),
  };
}

const CITY_A: BrowseScope = { kind: 'city', cityKey: 'karlstad' };
const CITY_B: BrowseScope = { kind: 'city', cityKey: 'stockholm' };
const COUNTRY: BrowseScope = { kind: 'country', countryCode: 'SE' };
const WORLD: BrowseScope = { kind: 'world' };

// ---------------------------------------------------------------------------
// Cache-key isolation (Step 12A sections 6/7)
// ---------------------------------------------------------------------------

check('forYouHandoffKey: identical inputs always produce the identical key (determinism — required for the cache HIT path to actually fire)', () => {
  assert.equal(forYouHandoffKey('uid-1', CITY_A, 15), forYouHandoffKey('uid-1', CITY_A, 15));
});

check('forYouHandoffKey: two different signed-in viewers in the SAME city get DIFFERENT keys — a ranked order never leaks between viewers', () => {
  assert.notEqual(forYouHandoffKey('uid-1', CITY_A, 15), forYouHandoffKey('uid-2', CITY_A, 15));
});

check('forYouHandoffKey: a signed-out viewer (uid \'\') never collides with any real uid\'s key', () => {
  assert.notEqual(forYouHandoffKey('', CITY_A, 15), forYouHandoffKey('uid-1', CITY_A, 15));
});

check('forYouHandoffKey: City A vs City B (same uid) are different keys — no cross-city leak on a scope switch', () => {
  assert.notEqual(forYouHandoffKey('uid-1', CITY_A, 15), forYouHandoffKey('uid-1', CITY_B, 15));
});

check('forYouHandoffKey: City vs Country vs World (same uid) are all pairwise different keys', () => {
  const keys = [forYouHandoffKey('uid-1', CITY_A, 15), forYouHandoffKey('uid-1', COUNTRY, 15), forYouHandoffKey('uid-1', WORLD, 15)];
  assert.equal(new Set(keys).size, 3, 'all three scope kinds must produce distinct keys');
});

check('forYouHandoffKey: a different limitCount (same uid/scope) is a different key', () => {
  assert.notEqual(forYouHandoffKey('uid-1', CITY_A, 15), forYouHandoffKey('uid-1', CITY_A, 20));
});

check('followingHandoffKey: same determinism/isolation properties as forYouHandoffKey, independently', () => {
  assert.equal(followingHandoffKey('uid-1', CITY_A, 15), followingHandoffKey('uid-1', CITY_A, 15));
  assert.notEqual(followingHandoffKey('uid-1', CITY_A, 15), followingHandoffKey('uid-2', CITY_A, 15));
  assert.notEqual(followingHandoffKey('uid-1', CITY_A, 15), followingHandoffKey('uid-1', CITY_B, 15));
});

check('For You and Following keys MAY be textually identical for identical inputs — this is safe BY DESIGN, not a bug: each is only ever looked up in its own separate Map in content.ts (forYouSectionsHandoff vs followingSectionsHandoff), never a shared one', () => {
  assert.equal(forYouHandoffKey('uid-1', CITY_A, 15), followingHandoffKey('uid-1', CITY_A, 15));
});

// ---------------------------------------------------------------------------
// Section-type distinction (Step 12A section 6's "section distinction")
// ---------------------------------------------------------------------------

check('isSectionKind accepts exactly the three real kinds and rejects everything else', () => {
  assert.equal(isSectionKind('happeningNow'), true);
  assert.equal(isSectionKind('today'), true);
  assert.equal(isSectionKind('comingUp'), true);
  assert.equal(isSectionKind('bogus'), false);
  assert.equal(isSectionKind(undefined), false);
});

check('selectItems reads happeningNow/today/comingUp independently — changing one field never affects what another `which` selects', () => {
  const sections: DiscoverySections = {
    happeningNow: [makeEvent('hn-1')],
    todayLabel: 'Today',
    today: [makeEvent('t-1'), makeEvent('t-2')],
    upcoming: [makeEvent('u-1')],
  };
  assert.deepEqual(selectItems(sections, 'happeningNow').map((e) => e.contentId), ['hn-1']);
  assert.deepEqual(selectItems(sections, 'today').map((e) => e.contentId), ['t-1', 't-2']);
  assert.deepEqual(selectItems(sections, 'comingUp').map((e) => e.contentId), ['u-1']);
});

check('selectComingUp with zero weekend-window items returns the full upcoming list unchanged (far-past fixtures never fall in the real current weekend window)', () => {
  const upcoming = [makeEvent('a'), makeEvent('b'), makeEvent('c')];
  assert.deepEqual(selectComingUp(upcoming), upcoming);
});

check('selectComingUp with zero items returns an empty array, never throws', () => {
  assert.deepEqual(selectComingUp([]), []);
});

// ---------------------------------------------------------------------------
// Prefix-order invariant (Step 12A sections 2/9): rail.slice(0, N) must
// equal expanded.slice(0, N) by id, in order — this is the core "For You
// rail -> Show more preserves the same ranked order" guarantee, modeled
// directly against the real production shapes: a rail is
// `rankedArray.slice(0, SECTION_COLLAPSED_LIMIT)` (events.tsx's own
// slice), and the expanded screen is `selectItems(sections, which)` read
// from the SAME cached, already-ranked `sections` object (section.tsx,
// post-Step-12A) — i.e. literally the same underlying array, never a
// second ranking pass.
// ---------------------------------------------------------------------------

const SECTION_COLLAPSED_LIMIT = 5; // mirrors (tabs)/events.tsx's own constant

function assertPrefixInvariant(allIds: string[], collapsedLimit: number) {
  const sections = makeSections(allIds);
  const rail = sections.upcoming.slice(0, collapsedLimit); // what the tab's rail renders
  const expanded = selectComingUp(sections.upcoming); // what "Show more" renders (all far-past, so no weekend split occurs)
  const expandedPrefix = expanded.slice(0, rail.length);
  assert.deepEqual(
    expandedPrefix.map((e) => e.contentId),
    rail.map((e) => e.contentId),
    `expanded.slice(0, rail.length) must equal the rail's own item IDs in order for ${allIds.length} items`
  );
  // No duplicates anywhere in the expanded list.
  const idSet = new Set(expanded.map((e) => e.contentId));
  assert.equal(idSet.size, expanded.length, 'expanded list must contain no duplicate ids');
}

check('prefix invariant: 0 items — rail and expanded are both empty, no throw', () => {
  assertPrefixInvariant([], SECTION_COLLAPSED_LIMIT);
});

check('prefix invariant: 1-4 items (fewer than the collapsed limit) — rail equals the full expanded list', () => {
  assertPrefixInvariant(['a'], SECTION_COLLAPSED_LIMIT);
  assertPrefixInvariant(['a', 'b', 'c'], SECTION_COLLAPSED_LIMIT);
  assertPrefixInvariant(['a', 'b', 'c', 'd'], SECTION_COLLAPSED_LIMIT);
});

check('prefix invariant: exactly 5 items (== collapsed limit) — rail equals the full expanded list exactly', () => {
  assertPrefixInvariant(['a', 'b', 'c', 'd', 'e'], SECTION_COLLAPSED_LIMIT);
});

check('prefix invariant: more than 5 items — the rail is a strict, order-preserving prefix of the expanded list, with real extra items beyond it', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  assertPrefixInvariant(ids, SECTION_COLLAPSED_LIMIT);
  // Also confirm there genuinely ARE extra items beyond the rail (the
  // invariant above would trivially hold even if expanded were
  // accidentally truncated to 5 — this rules that out).
  const sections = makeSections(ids);
  const expanded = selectComingUp(sections.upcoming);
  assert.equal(expanded.length, ids.length);
});

check('prefix invariant holds independently for all three real sections (happeningNow/today/comingUp), not just comingUp', () => {
  const ids = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
  const sections: DiscoverySections = {
    happeningNow: ids.map((id) => makeEvent(`hn-${id}`)),
    todayLabel: 'Today',
    today: ids.map((id) => makeEvent(`t-${id}`)),
    upcoming: ids.map((id) => makeEvent(id)),
  };
  for (const which of ['happeningNow', 'today', 'comingUp'] as const) {
    const full = selectItems(sections, which);
    const rail = full.slice(0, SECTION_COLLAPSED_LIMIT);
    const expandedPrefix = selectItems(sections, which).slice(0, rail.length);
    assert.deepEqual(
      expandedPrefix.map((e) => e.contentId),
      rail.map((e) => e.contentId),
      `prefix must hold for section "${which}"`
    );
  }
});

console.log('\n=== src/ Events "Show more" ranking-consistency test results ===');
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
