/**
 * Plain unit tests for src/utils/pushTokenPlatformSupport.ts's
 * resolvePushTokenPlatform. Run via:
 *   npx tsx tests/pushTokenPlatformSupport.test.ts
 * Same plain assert()/check() convention as tests/mediaProvider.test.ts.
 *
 * Covers "unsupported platforms" from this step's own test requirements
 * directly, rather than only by code review.
 */
import { resolvePushTokenPlatform } from '../src/utils/pushTokenPlatformSupport';

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

check('ios is supported', () => {
  assert.equal(resolvePushTokenPlatform('ios'), 'ios');
});

check('android is supported', () => {
  assert.equal(resolvePushTokenPlatform('android'), 'android');
});

check('UNSUPPORTED PLATFORM — web is not supported', () => {
  assert.equal(resolvePushTokenPlatform('web'), null);
});

check('UNSUPPORTED PLATFORM — an unrecognized/future OS name defaults to unsupported, never throws', () => {
  assert.equal(resolvePushTokenPlatform('windows'), null);
});

console.log('\n=== Push token platform-support test results ===');
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
