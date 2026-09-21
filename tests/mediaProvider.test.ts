/**
 * Step 4 (storage-provider foundation) — plain unit tests for
 * src/services/media/config.ts's getMediaStorageProvider() and
 * src/services/media/types.ts's interpretMediaProvider(). Run via:
 *   npx tsx tests/mediaProvider.test.ts
 * Same plain assert()/check() convention as tests/hashtags.test.ts.
 *
 * Both functions under test are deliberately free of any Firebase/`@/`-
 * aliased import (see config.ts's/types.ts's own doc comments), so this
 * file — unlike tests/recommendations.test.ts or tests/cities.test.ts —
 * does not depend on any Firebase-coupled module chain.
 */
import { getMediaStorageProvider } from '../src/services/media/config';
import { interpretMediaProvider } from '../src/services/media/types';

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

// ---------------------------------------------------------------------------
// getMediaStorageProvider — must never crash, must always default safely.
// ---------------------------------------------------------------------------

const ENV_KEY = 'EXPO_PUBLIC_MEDIA_STORAGE_PROVIDER';
const originalEnvValue = process.env[ENV_KEY];
function restoreEnv() {
  if (originalEnvValue === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalEnvValue;
}

check('getMediaStorageProvider defaults to "firebase" when the env var is unset', () => {
  delete process.env[ENV_KEY];
  assert.equal(getMediaStorageProvider(), 'firebase');
});

check('getMediaStorageProvider defaults to "firebase" for an unrecognized value — never throws', () => {
  process.env[ENV_KEY] = 'not-a-real-provider';
  assert.equal(getMediaStorageProvider(), 'firebase');
});

check('getMediaStorageProvider defaults to "firebase" for an empty string', () => {
  process.env[ENV_KEY] = '';
  assert.equal(getMediaStorageProvider(), 'firebase');
});

check('getMediaStorageProvider returns "r2" only when explicitly and exactly set to "r2"', () => {
  process.env[ENV_KEY] = 'r2';
  assert.equal(getMediaStorageProvider(), 'r2');
});

check('getMediaStorageProvider returns "firebase" when explicitly set to "firebase"', () => {
  process.env[ENV_KEY] = 'firebase';
  assert.equal(getMediaStorageProvider(), 'firebase');
});

restoreEnv();

// ---------------------------------------------------------------------------
// interpretMediaProvider — the backward-compatible defaulting rule a
// future migration step relies on for documents that never write this
// (not-yet-existing) field at all.
// ---------------------------------------------------------------------------

check('interpretMediaProvider defaults to "firebase" for a document with no mediaProvider field at all (every real document today)', () => {
  assert.equal(interpretMediaProvider({}), 'firebase');
});

check('interpretMediaProvider defaults to "firebase" for an explicit but unrecognized value', () => {
  assert.equal(interpretMediaProvider({ mediaProvider: 'something-else' }), 'firebase');
});

check('interpretMediaProvider returns "r2" only for the exact literal "r2"', () => {
  assert.equal(interpretMediaProvider({ mediaProvider: 'r2' }), 'r2');
});

console.log('\n=== Media storage-provider foundation test results ===');
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
if (failures > 0) process.exit(1);
