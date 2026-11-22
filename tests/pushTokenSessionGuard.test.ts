/**
 * Plain unit tests for src/utils/pushTokenSessionGuard.ts —
 * shouldStartRegistrationAttempt and isRegistrationResultStale. Run via:
 *   npx tsx tests/pushTokenSessionGuard.test.ts
 * Same plain assert()/check() convention as tests/mediaProvider.test.ts.
 *
 * These are the pure decisions behind the authenticated-lifecycle
 * integration (src/services/pushTokens.ts's own
 * syncPushTokenForAuthenticatedSession, wired into AuthProvider) —
 * covering "repeated app startup" (duplicate-call guard), "authentication
 * changes" and "account switching" (stale-result detection) from this
 * step's own test requirements.
 */
import { shouldStartRegistrationAttempt, isRegistrationResultStale } from '../src/utils/pushTokenSessionGuard';

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

const userA = 'uid-A';
const userB = 'uid-B';

// ---------------------------------------------------------------------------
// shouldStartRegistrationAttempt — duplicate-call guard.
// ---------------------------------------------------------------------------

check('REPEATED APP STARTUP — nothing in flight: a fresh attempt should start', () => {
  assert.equal(shouldStartRegistrationAttempt(null, userA), true);
});

check('REPEATED APP STARTUP — the SAME uid already has an attempt in flight: do NOT start a duplicate', () => {
  assert.equal(shouldStartRegistrationAttempt(userA, userA), false);
});

check('ACCOUNT SWITCHING — a DIFFERENT uid than the one in flight should still be allowed to start its own attempt', () => {
  assert.equal(shouldStartRegistrationAttempt(userA, userB), true);
});

// ---------------------------------------------------------------------------
// isRegistrationResultStale — the actual race this step's investigation
// surfaced (a quick logout racing an in-flight registration write).
// ---------------------------------------------------------------------------

check('AUTHENTICATION CHANGES — the session is still the same uid the attempt was for: NOT stale', () => {
  assert.equal(isRegistrationResultStale(userA, userA), false);
});

check('LOGOUT — the session has since become signed-out (null) while this uid\'s attempt was still in flight: STALE', () => {
  assert.equal(isRegistrationResultStale(null, userA), true);
});

check('ACCOUNT SWITCHING — a DIFFERENT uid has since signed in while the original uid\'s attempt was still in flight: STALE', () => {
  assert.equal(isRegistrationResultStale(userB, userA), true);
});

console.log('\n=== Push token session-guard (duplicate/stale registration) test results ===');
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
