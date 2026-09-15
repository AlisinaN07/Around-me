/**
 * Recommendation Engine — Step 5, Step 31 — plain-Node tests for
 * collaborative.ts's pure (no Firestore Admin call) logic: vector
 * normalization, eligibility, cosine similarity, neighbor selection,
 * confidence, and collaborative category-score discovery. Runs against
 * the COMPILED lib/ output (`npm run build` first — see the `test`
 * script in package.json, which now runs this alongside
 * test-stats-logic.cjs).
 *
 * Does NOT stand up the Firestore emulator — runCollaborativeRefresh
 * itself (the Admin-SDK-touching orchestration) is exercised via live
 * validation instead (see this feature's own final report).
 */
const assert = require('node:assert/strict');
const {
  buildNormalizedVector,
  isEligibleForCollaborative,
  cosineSimilarity,
  findTopNeighbors,
  computeConfidence,
  computeCollaborativeCategoryScores,
  groupByCountry,
} = require('../lib/collaborative.js');
const { MIN_NEIGHBORS_FOR_CONFIDENCE, MAX_NEIGHBORS, MAX_COUNTRY_GROUP_SIZE, MAX_COLLABORATIVE_CATEGORIES, SIMILARITY_MIN_THRESHOLD } = require('../lib/collaborativeConfig.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function vec(obj) {
  return buildNormalizedVector(obj);
}

// ---------------------------------------------------------------------------
// Step 31, #1-3 — cosine similarity.
// ---------------------------------------------------------------------------
check('1. Identical category vectors have similarity ≈ 1', () => {
  const a = vec({ sports: 30, nightlife: 20 });
  const b = vec({ sports: 30, nightlife: 20 });
  const similarity = cosineSimilarity(a, b);
  assert.ok(Math.abs(similarity - 1) < 1e-9, `expected ~1, got ${similarity}`);
});

check('2. Completely unrelated vectors have low (zero) similarity', () => {
  const a = vec({ sports: 30 });
  const b = vec({ food: 25 });
  assert.equal(cosineSimilarity(a, b), 0);
});

check('3. Partially related vectors have middle similarity', () => {
  const a = vec({ sports: 30, nightlife: 20 });
  const b = vec({ sports: 30, food: 25 });
  const similarity = cosineSimilarity(a, b);
  assert.ok(similarity > 0 && similarity < 0.99, `expected a middle value, got ${similarity}`);
});

// ---------------------------------------------------------------------------
// Step 31, #4 — minimum data requirement.
// ---------------------------------------------------------------------------
check('4. A low-interaction user does not activate the collaborative model', () => {
  const thinVector = vec({ sports: 30, nightlife: 20 }); // only 2 categories, and few interactions
  assert.equal(isEligibleForCollaborative(3, thinVector), false, 'too few interactions must be ineligible');
  const richVector = vec({ sports: 30, nightlife: 20, food: 10, music: 15 });
  assert.equal(isEligibleForCollaborative(20, richVector), true, 'enough interactions and category diversity must be eligible');
});

// ---------------------------------------------------------------------------
// Step 31, #5-6, #14 — neighbor selection + confidence.
// ---------------------------------------------------------------------------
check('5. A small neighbor group produces low/zero confidence', () => {
  const neighbors = [
    { uid: 'n1', similarity: 0.9, vector: {} },
    { uid: 'n2', similarity: 0.85, vector: {} },
  ]; // below MIN_NEIGHBORS_FOR_CONFIDENCE
  assert.ok(neighbors.length < MIN_NEIGHBORS_FOR_CONFIDENCE, 'test setup sanity check');
  assert.equal(computeConfidence(neighbors), 0, 'too few neighbors must force confidence to exactly 0');
});

check('6. Strong neighbor agreement (many, highly similar) produces high confidence', () => {
  const neighbors = Array.from({ length: MAX_NEIGHBORS }, (_, i) => ({ uid: `n${i}`, similarity: 0.95, vector: {} }));
  const confidence = computeConfidence(neighbors);
  assert.ok(confidence > 0.8, `expected high confidence with a full, highly-similar neighbor list, got ${confidence}`);
});

check('14. Neighbor count is bounded to MAX_NEIGHBORS regardless of candidate pool size', () => {
  const target = { uid: 'viewer', vector: vec({ sports: 30 }) };
  const candidates = Array.from({ length: 500 }, (_, i) => ({ uid: `c${i}`, vector: vec({ sports: 30 }) })); // all maximally similar
  const neighbors = findTopNeighbors(target, candidates);
  assert.ok(neighbors.length <= MAX_NEIGHBORS, `expected at most ${MAX_NEIGHBORS}, got ${neighbors.length}`);
  assert.equal(neighbors.length, MAX_NEIGHBORS, 'with 500 qualifying candidates, the cap should actually bind');
});

check('findTopNeighbors excludes anyone below SIMILARITY_MIN_THRESHOLD', () => {
  const target = { uid: 'viewer', vector: vec({ sports: 30 }) };
  const candidates = [
    { uid: 'close', vector: vec({ sports: 30 }) }, // similarity 1
    { uid: 'far', vector: vec({ food: 30 }) }, // similarity 0
  ];
  const neighbors = findTopNeighbors(target, candidates);
  assert.ok(neighbors.every((n) => n.similarity >= SIMILARITY_MIN_THRESHOLD));
  assert.ok(!neighbors.some((n) => n.uid === 'far'));
});

// ---------------------------------------------------------------------------
// Step 31, #7-8 — collaborative category discovery.
// ---------------------------------------------------------------------------
check('7. A category the viewer already strongly likes does not dominate discovery output', () => {
  const viewer = vec({ football: 35 }); // ~0.875, already "strong"
  const neighbors = Array.from({ length: 10 }, (_, i) => ({
    uid: `n${i}`,
    similarity: 0.9,
    vector: vec({ football: 35, padel: 28 }),
  }));
  const confidence = computeConfidence(neighbors);
  const scores = computeCollaborativeCategoryScores(viewer, neighbors, confidence);
  assert.ok(!('football' in scores), 'an already-strong personal category must be excluded from collaborative discovery output');
});

check("8. A new adjacent category (the spec's own padel example) receives a collaborative boost", () => {
  const viewer = vec({ football: 36, nightlife: 24, padel: 2 }); // padel barely present
  const neighbors = Array.from({ length: 10 }, (_, i) => ({
    uid: `n${i}`,
    similarity: 0.85,
    vector: vec({ football: 32, nightlife: 26, padel: 29 }), // neighbors love padel
  }));
  const confidence = computeConfidence(neighbors);
  const scores = computeCollaborativeCategoryScores(viewer, neighbors, confidence);
  assert.ok('padel' in scores, 'padel should surface as a collaborative discovery candidate');
  assert.ok(scores.padel > 0.3, `expected a meaningfully positive padel score, got ${scores.padel}`);
});

check('Zero confidence produces an empty collaborative category map', () => {
  const viewer = vec({ football: 10 });
  const neighbors = [{ uid: 'n1', similarity: 0.9, vector: vec({ padel: 30 }) }]; // below MIN_NEIGHBORS_FOR_CONFIDENCE
  const confidence = computeConfidence(neighbors);
  assert.equal(confidence, 0);
  const scores = computeCollaborativeCategoryScores(viewer, neighbors, confidence);
  assert.deepEqual(scores, {}, 'zero confidence must produce zero collaborative categories, not a weak-but-nonzero guess');
});

check('13. Collaborative category output is bounded to MAX_COLLABORATIVE_CATEGORIES', () => {
  const viewer = vec({}); // no strong personal categories at all
  const manyCategories = {};
  for (let i = 0; i < 30; i++) manyCategories[`category${i}`] = 20 + i; // 30 distinct categories
  const neighbors = Array.from({ length: 10 }, (_, i) => ({ uid: `n${i}`, similarity: 0.8, vector: vec(manyCategories) }));
  const confidence = computeConfidence(neighbors);
  const scores = computeCollaborativeCategoryScores(viewer, neighbors, confidence);
  assert.ok(Object.keys(scores).length <= MAX_COLLABORATIVE_CATEGORIES, `expected at most ${MAX_COLLABORATIVE_CATEGORIES} categories, got ${Object.keys(scores).length}`);
});

// ---------------------------------------------------------------------------
// Step 31, #15 — batch/group size is bounded.
// ---------------------------------------------------------------------------
check('15. Country groups are truncated at MAX_COUNTRY_GROUP_SIZE, never allowed to grow further', () => {
  const users = Array.from({ length: MAX_COUNTRY_GROUP_SIZE + 50 }, (_, i) => ({
    uid: `u${i}`,
    vector: vec({ sports: 20 }),
    countryCode: 'SE',
    interactionCount: 20,
  }));
  const groups = groupByCountry(users);
  const seGroup = groups.get('SE');
  assert.ok(seGroup.length <= MAX_COUNTRY_GROUP_SIZE, `expected at most ${MAX_COUNTRY_GROUP_SIZE}, got ${seGroup.length}`);
  assert.equal(seGroup.length, MAX_COUNTRY_GROUP_SIZE, 'with more candidates than the cap, the cap should actually bind');
});

check('groupByCountry keeps distinct countries in separate, independently-bounded groups', () => {
  const users = [
    { uid: 'se1', vector: vec({ sports: 20 }), countryCode: 'SE', interactionCount: 20 },
    { uid: 'no1', vector: vec({ sports: 20 }), countryCode: 'NO', interactionCount: 20 },
  ];
  const groups = groupByCountry(users);
  assert.equal(groups.size, 2);
  assert.equal(groups.get('SE').length, 1);
  assert.equal(groups.get('NO').length, 1);
});

console.log('\n=== functions/ collaborative-filtering logic test results ===');
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
