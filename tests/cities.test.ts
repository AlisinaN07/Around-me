/**
 * Lightweight unit-level tests for the city catalog (Step 21) — run via:
 *   npx tsx tests/cities.test.ts
 * Same plain assert()/check() convention as tests/firestore.rules.test.mjs,
 * deliberately not a full test framework (Jest/Vitest) for one small file.
 * Uses a tiny local assert instead of node:assert/strict — this project's
 * tsconfig (moduleResolution: bundler, no explicit "types") doesn't resolve
 * Node's built-in module typings, and this file is the only place that
 * would need them.
 */
import { buildCityKey } from '../src/utils/cityKey';
import { CITIES, findCityByKey, searchCities } from '../src/constants/cities';

const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `Expected truthy value, got ${String(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
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

check('catalog is non-empty and includes the launch city, Karlstad', () => {
  assert.ok(CITIES.length >= 10);
  assert.ok(CITIES.some((city) => city.cityName === 'Karlstad'));
});

check('every cityKey is unique', () => {
  const keys = CITIES.map((city) => city.cityKey);
  assert.equal(new Set(keys).size, keys.length);
});

check('every cityKey is fully lowercase', () => {
  for (const city of CITIES) {
    assert.equal(city.cityKey, city.cityKey.toLowerCase());
  }
});

check('every cityKey matches buildCityKey(countryCode, cityName) exactly', () => {
  for (const city of CITIES) {
    assert.equal(city.cityKey, buildCityKey(city.countryCode, city.cityName));
  }
});

check('countryCode is stable (SE) for this Sweden-focused launch catalog', () => {
  for (const city of CITIES) {
    assert.equal(city.countryCode, 'SE');
    assert.equal(city.countryName, 'Sweden');
  }
});

check('no duplicate (cityName, countryCode) pairs', () => {
  const pairs = CITIES.map((city) => `${city.countryCode}:${city.cityName.toLowerCase()}`);
  assert.equal(new Set(pairs).size, pairs.length);
});

check('findCityByKey resolves a real catalog city', () => {
  const karlstad = findCityByKey('se:karlstad');
  assert.ok(karlstad);
  assert.equal(karlstad?.cityName, 'Karlstad');
});

check('findCityByKey returns null for an unknown/invalid key', () => {
  assert.equal(findCityByKey('se:nonexistentcity'), null);
  assert.equal(findCityByKey(''), null);
});

check('searchCities is case-insensitive', () => {
  const lower = searchCities('stockholm');
  assert.ok(lower.some((city) => city.cityName === 'Stockholm'));
  const upper = searchCities('STOCKHOLM');
  assert.ok(upper.some((city) => city.cityName === 'Stockholm'));
});

check('searchCities normalizes diacritics — "Goteborg" finds "Göteborg"', () => {
  const matches = searchCities('Goteborg');
  assert.ok(matches.some((city) => city.cityName === 'Göteborg'));
});

check('searchCities with an empty query returns the full catalog', () => {
  assert.equal(searchCities('').length, CITIES.length);
  assert.equal(searchCities('   ').length, CITIES.length);
});

check('searchCities with no matches returns an empty array, not an error', () => {
  assert.equal(searchCities('zzznotarealcityzzz').length, 0);
});

console.log('\n=== City catalog test results ===');
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
