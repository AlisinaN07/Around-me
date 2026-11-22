/**
 * Plain unit tests for src/utils/pushTokenOwnership.ts's
 * isTokenCurrentlyOwnedBy — and specifically, the exact shared-device
 * privacy property this whole mechanism exists to prove. Run via:
 *   npx tsx tests/pushTokenOwnership.test.ts
 * Same plain assert()/check() convention as tests/mediaProvider.test.ts.
 *
 * IMPORTANT — what this file does and does NOT prove: this proves the
 * DATA-LEVEL property — that once the ownership registry is correctly
 * reassigned, a check against it correctly refuses a stale recipient,
 * REGARDLESS of whether that recipient's own per-user document was ever
 * cleaned up. It does NOT prove that any real send-process actually
 * performs this check (no send-side code exists in this codebase yet —
 * see src/services/pushTokens.ts's own top doc comment on why that's an
 * explicit, out-of-scope limitation of this step) — and it is NOT a
 * test of the local retry/pending-cleanup helpers (pendingPushTokenCleanup.ts),
 * which are a separate, best-effort convenience, not this guarantee's
 * actual mechanism.
 */
import { isTokenCurrentlyOwnedBy, type PushTokenOwnershipRecord } from '../src/utils/pushTokenOwnership';

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

check('a token never registered (no ownership record) is owned by nobody', () => {
  const ownership: PushTokenOwnershipRecord = null;
  assert.equal(isTokenCurrentlyOwnedBy(ownership, userA), false);
  assert.equal(isTokenCurrentlyOwnedBy(ownership, userB), false);
});

check('after User A registers, the token is owned by A and ONLY A', () => {
  const ownership: PushTokenOwnershipRecord = { uid: userA };
  assert.equal(isTokenCurrentlyOwnedBy(ownership, userA), true);
  assert.equal(isTokenCurrentlyOwnedBy(ownership, userB), false);
});

check(
  'THE SHARED-DEVICE PRIVACY PROPERTY — after User B registers the SAME physical token (overwriting the registry), a check for User A is now false, EVEN THOUGH User A never explicitly released it',
  () => {
    // Model exactly the scenario this step exists to fix: A registers,
    // A's own logout cleanup FAILS (we never even need to model that
    // failure explicitly — the point is the registry's correctness does
    // not depend on it), then B registers on the same device. The
    // registry is simply overwritten — this IS what a real registration
    // does (see ensurePushTokenRegistered's own atomic batch.set on
    // pushTokenOwners).
    let ownership: PushTokenOwnershipRecord = { uid: userA };
    assert.equal(isTokenCurrentlyOwnedBy(ownership, userA), true, 'sanity: A owns it before B registers');

    // User B registers the same physical token.
    ownership = { uid: userB };

    // A's stale per-user document (users/uid-A/pushTokens/{deviceId}) is
    // EXPLICITLY NOT modeled here at all — that is the entire point:
    // this check never looks at it, and must still correctly refuse A.
    assert.equal(isTokenCurrentlyOwnedBy(ownership, userA), false, 'A must NEVER be treated as the current owner once B has registered');
    assert.equal(isTokenCurrentlyOwnedBy(ownership, userB), true, 'B is now the sole current owner');
  }
);

check('a released token (ownership cleared, e.g. a clean logout) is owned by nobody until the next real registration', () => {
  let ownership: PushTokenOwnershipRecord = { uid: userA };
  ownership = null; // A's own clean logout released it
  assert.equal(isTokenCurrentlyOwnedBy(ownership, userA), false);
  assert.equal(isTokenCurrentlyOwnedBy(ownership, userB), false);
});

console.log('\n=== Push token ownership (shared-device privacy property) test results ===');
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
