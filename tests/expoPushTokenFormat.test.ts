/**
 * Plain unit tests for src/utils/expoPushTokenFormat.ts's
 * isLikelyExpoPushToken — the pure client-side mirror of
 * firestore.rules' own isValidExpoPushTokenFormat. Run via:
 *   npx tsx tests/expoPushTokenFormat.test.ts
 * Same plain assert()/check() convention as tests/mediaProvider.test.ts.
 */
import { isLikelyExpoPushToken } from '../src/utils/expoPushTokenFormat';

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

check('a real ExponentPushToken[...] value is accepted', () => {
  assert.equal(isLikelyExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true);
});

check('the OTHER documented Expo variant, ExpoPushToken[...], is ALSO accepted — not just one hardcoded prefix', () => {
  assert.equal(isLikelyExpoPushToken('ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true);
});

check('empty brackets are rejected (no actual token content)', () => {
  assert.equal(isLikelyExpoPushToken('ExponentPushToken[]'), false);
});

check('a missing closing bracket is rejected', () => {
  assert.equal(isLikelyExpoPushToken('ExponentPushToken[abc'), false);
});

check('an unrelated string is rejected, never trusted', () => {
  assert.equal(isLikelyExpoPushToken('not-a-real-token'), false);
});

check('an FCM/APNs-shaped raw device token (no Expo wrapper at all) is rejected — this app only ever stores Expo-brokered tokens', () => {
  assert.equal(isLikelyExpoPushToken('dQw4w9WgXcQ:APA91bF...'), false);
});

check('an empty string is rejected', () => {
  assert.equal(isLikelyExpoPushToken(''), false);
});

check('an oversized value is rejected', () => {
  assert.equal(isLikelyExpoPushToken(`ExponentPushToken[${'x'.repeat(500)}]`), false);
});

console.log('\n=== Expo push-token format test results ===');
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
