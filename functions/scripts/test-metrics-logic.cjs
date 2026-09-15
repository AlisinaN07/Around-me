/**
 * Recommendation Engine — Step 6, Step 27 — plain-Node tests for
 * metrics.ts's pure aggregation-patch logic. Runs against the COMPILED
 * lib/ output (`npm run build` first — see the `test` script in
 * package.json).
 */
const assert = require('node:assert/strict');
const { buildReelMetricsPatch, buildEventMetricsPatch, buildSessionPatch, addUnique, bump, bumpNested } = require('../lib/metrics.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

// ---------------------------------------------------------------------------
// Reel metrics.
// ---------------------------------------------------------------------------
check('an impression increments impressions and its bucket', () => {
  const patch = buildReelMetricsPatch({}, { action: 'impression', bucket: 'known', sourceTags: '' });
  assert.equal(patch.impressions, 1);
  assert.deepEqual(patch.known, { impressions: 1 });
});

check('8. discovery source attribution: a discovery-bucket impression increments the discovery bucket, not known/related', () => {
  const patch = buildReelMetricsPatch({}, { action: 'impression', bucket: 'discovery', sourceTags: '' });
  assert.deepEqual(patch.discovery, { impressions: 1 });
  assert.equal(patch.known, undefined);
  assert.equal(patch.related, undefined);
});

check('9. collaborative discovery attribution: an impression tagged collaborative_discovery increments that bucket', () => {
  const patch = buildReelMetricsPatch({}, { action: 'impression', bucket: 'discovery', sourceTags: 'discovery,collaborative_discovery' });
  assert.deepEqual(patch.collaborativeDiscovery, { impressions: 1 });
});

check('10. same-city vs secondary-city classification (reels): sourceTags select the right counter', () => {
  const sameCity = buildReelMetricsPatch({}, { action: 'impression', bucket: 'known', sourceTags: 'known_interest,same_city' });
  assert.equal(sameCity.sameCityImpressions, 1);
  assert.equal(sameCity.secondaryCityImpressions, undefined);

  const secondaryCity = buildReelMetricsPatch({}, { action: 'impression', bucket: 'discovery', sourceTags: 'discovery,secondary_city_exploration' });
  assert.equal(secondaryCity.secondaryCityImpressions, 1);
  assert.equal(secondaryCity.sameCityImpressions, undefined);
});

check('a quick_skip increments quickSkips and the watch-percent sum, but not meaningfulViews', () => {
  const patch = buildReelMetricsPatch({}, { action: 'quick_skip', watchPercentage: 0.05 });
  assert.equal(patch.quickSkips, 1);
  assert.equal(patch.meaningfulViews, undefined);
  assert.equal(patch.watchSampleCount, 1);
  assert.ok(Math.abs(patch.totalWatchPercentSum - 0.05) < 1e-9);
});

check('7. impossible watch percentage is clamped, not trusted as-is', () => {
  const over = buildReelMetricsPatch({}, { action: 'open', watchPercentage: 8.0 });
  assert.ok(Math.abs(over.totalWatchPercentSum - 1) < 1e-9, 'a >100% value must be clamped to 1');
  const under = buildReelMetricsPatch({ totalWatchPercentSum: 0 }, { action: 'open', watchPercentage: -3 });
  assert.ok(Math.abs(under.totalWatchPercentSum - 0) < 1e-9, 'a negative value must be clamped to 0');
});

check('a complete increments completions and meaningfulViews together', () => {
  const patch = buildReelMetricsPatch({ meaningfulViews: 5, completions: 2 }, { action: 'complete', bucket: 'known', watchPercentage: 1 });
  assert.equal(patch.meaningfulViews, 6);
  assert.equal(patch.completions, 3);
});

check('a save increments saves and, when present, its bucket/collaborative counters', () => {
  const patch = buildReelMetricsPatch({}, { action: 'save', bucket: 'related', sourceTags: 'related_interest,collaborative_discovery' });
  assert.equal(patch.saves, 1);
  assert.deepEqual(patch.related, { saves: 1 });
  assert.deepEqual(patch.collaborativeDiscovery, { saves: 1 });
});

check('a not_interested increments notInterested and its bucket', () => {
  const patch = buildReelMetricsPatch({}, { action: 'not_interested', bucket: 'discovery' });
  assert.equal(patch.notInterested, 1);
  assert.deepEqual(patch.discovery, { notInterested: 1 });
});

check('an unrelated action (profile_open) does not produce a Reel metrics patch', () => {
  assert.equal(buildReelMetricsPatch({}, { action: 'profile_open' }), null);
});

// ---------------------------------------------------------------------------
// 14. Event funnel metrics.
// ---------------------------------------------------------------------------
check('14. event_open/event_interested/event_going each increment their own funnel counter', () => {
  const opened = buildEventMetricsPatch({}, { action: 'event_open', sourceTags: 'same_city' });
  assert.equal(opened.opens, 1);
  assert.equal(opened.sameCityOpens, 1);

  const interested = buildEventMetricsPatch({ opens: 10 }, { action: 'event_interested' });
  assert.equal(interested.interested, 1);
  assert.equal(interested.opens, undefined, 'this call only patches the field for THIS action — the caller merges patches over time');

  const going = buildEventMetricsPatch({}, { action: 'event_going' });
  assert.equal(going.going, 1);
});

check('10. same-city vs secondary-city classification (events)', () => {
  const secondary = buildEventMetricsPatch({}, { action: 'event_open', sourceTags: 'secondary_city_exploration' });
  assert.equal(secondary.secondaryCityOpens, 1);
  assert.equal(secondary.sameCityOpens, undefined);
});

check('an ambiguous content action (not_interested/share on a text Post) never contributes to the Events funnel', () => {
  assert.equal(buildEventMetricsPatch({}, { action: 'not_interested' }), null);
  assert.equal(buildEventMetricsPatch({}, { action: 'share' }), null);
});

// ---------------------------------------------------------------------------
// 5. Session metrics.
// ---------------------------------------------------------------------------
check('5. session metrics aggregate correctly across several interactions', () => {
  let session = {};
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', categoryId: 'sports', creatorId: 'c1' }, 'u1') };
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', categoryId: 'music', creatorId: 'c2' }, 'u1') };
  session = { ...session, ...buildSessionPatch(session, { action: 'complete', categoryId: 'sports', creatorId: 'c1' }, 'u1') };
  session = { ...session, ...buildSessionPatch(session, { action: 'save', categoryId: 'sports', creatorId: 'c1' }, 'u1') };

  assert.equal(session.itemsShown, 2);
  assert.equal(session.meaningfulViews, 1);
  assert.equal(session.saves, 1);
  assert.equal(session.userId, 'u1');
  assert.ok(session.startedAt <= session.lastEventAt);
});

check('11. creator diversity: uniqueCreatorIds only grows for genuinely new creators', () => {
  let session = {};
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', creatorId: 'c1' }, 'u1') };
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', creatorId: 'c1' }, 'u1') };
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', creatorId: 'c2' }, 'u1') };
  assert.deepEqual(session.uniqueCreatorIds.sort(), ['c1', 'c2']);
});

check('12. category diversity: uniqueCategoryIds only grows for genuinely new categories', () => {
  let session = {};
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', categoryId: 'sports' }, 'u1') };
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', categoryId: 'sports' }, 'u1') };
  session = { ...session, ...buildSessionPatch(session, { action: 'impression', categoryId: 'music' }, 'u1') };
  assert.deepEqual(session.uniqueCategoryIds.sort(), ['music', 'sports']);
});

check('addUnique never grows a list past its bound', () => {
  let list = [];
  for (let i = 0; i < 60; i++) list = addUnique(list, `id-${i}`);
  assert.ok(list.length <= 50, `expected a bounded list, got ${list.length}`);
});

check('4. ranking config version / variant are recorded on the session once seen', () => {
  const patch = buildSessionPatch({}, { action: 'impression', rankingVersion: 'v1.0', experimentVariant: 'control' }, 'u1');
  assert.equal(patch.rankingVersion, 'v1.0');
  assert.equal(patch.variantId, 'control');
});

check('bump/bumpNested are pure — never mutate the `current` object passed in', () => {
  const current = { likes: 3, known: { impressions: 2 } };
  const snapshot = JSON.parse(JSON.stringify(current));
  bump(current, 'likes');
  bumpNested(current, 'known', 'impressions');
  assert.deepEqual(current, snapshot, 'the input object must never be mutated in place');
});

console.log('\n=== functions/ metrics logic test results ===');
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
