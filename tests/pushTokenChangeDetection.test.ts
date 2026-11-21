/**
 * Plain unit tests for src/utils/pushTokenChangeDetection.ts's
 * hasPushTokenChanged. Run via:
 *   npx tsx tests/pushTokenChangeDetection.test.ts
 * Same plain assert()/check() convention as tests/mediaProvider.test.ts.
 */
import { hasPushTokenChanged, isTokenRotation } from '../src/utils/pushTokenChangeDetection';

const assert = {
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

check('first-ever registration (no stored record) always needs a write', () => {
  assert.equal(hasPushTokenChanged(null, { expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' }), true);
});

check('repeated registration with an IDENTICAL token and platform needs no write', () => {
  const record = { expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' as const };
  assert.equal(hasPushTokenChanged(record, { ...record }), false);
});

check('token rotation — same platform, different token string — needs a write', () => {
  assert.equal(
    hasPushTokenChanged({ expoPushToken: 'ExponentPushToken[old]', platform: 'ios' }, { expoPushToken: 'ExponentPushToken[new]', platform: 'ios' }),
    true
  );
});

check('a platform change alone (same token string, hypothetically) still needs a write', () => {
  assert.equal(
    hasPushTokenChanged({ expoPushToken: 'ExponentPushToken[x]', platform: 'ios' }, { expoPushToken: 'ExponentPushToken[x]', platform: 'android' }),
    true
  );
});

// ---------------------------------------------------------------------------
// isTokenRotation — Step 3D: distinguishes a genuine rotation (needs the
// OLD token's ownership record released) from a first-ever registration
// or a platform-only change (neither of which has an old TOKEN to release).
// ---------------------------------------------------------------------------

check('a first-ever registration (no stored record) is NOT a rotation — there is no old token to release', () => {
  assert.equal(isTokenRotation(null, { expoPushToken: 'ExponentPushToken[new]', platform: 'ios' }), false);
});

check('an identical re-registration is NOT a rotation', () => {
  const record = { expoPushToken: 'ExponentPushToken[abc]', platform: 'ios' as const };
  assert.equal(isTokenRotation(record, { ...record }), false);
});

check('a genuine token-value change IS a rotation', () => {
  assert.equal(
    isTokenRotation({ expoPushToken: 'ExponentPushToken[old]', platform: 'ios' }, { expoPushToken: 'ExponentPushToken[new]', platform: 'ios' }),
    true
  );
});

check('a platform-only change (same token string) is NOT a rotation — there is no old TOKEN VALUE to release', () => {
  assert.equal(
    isTokenRotation({ expoPushToken: 'ExponentPushToken[x]', platform: 'ios' }, { expoPushToken: 'ExponentPushToken[x]', platform: 'android' }),
    false
  );
});

console.log('\n=== Push token change-detection test results ===');
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
