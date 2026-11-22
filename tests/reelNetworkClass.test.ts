/**
 * Step 11D.1 — pure tests for src/utils/reelNetworkClass.ts's own
 * mapExpoNetworkStateToReelNetworkClass: `expo-network`'s NetworkState ->
 * this app's ReelNetworkClass. No React, no expo-network's real native
 * module (the file under test only TYPE-imports `expo-network` — see its
 * own doc comment for why — so this runs under plain `tsx` exactly like
 * tests/reelPreparationPolicy.test.ts), run via:
 *   npx tsx tests/reelNetworkClass.test.ts
 */
import assert from 'node:assert/strict';

import { mapExpoNetworkStateToReelNetworkClass } from '../src/utils/reelNetworkClass';

const results: { name: string; pass: boolean; error?: unknown }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

check('wifi + connected + internet reachable -> wifi', () => {
  assert.equal(
    mapExpoNetworkStateToReelNetworkClass({ type: 'WIFI' as never, isConnected: true, isInternetReachable: true }),
    'wifi'
  );
});

check('cellular + connected + internet reachable -> cellular', () => {
  assert.equal(
    mapExpoNetworkStateToReelNetworkClass({ type: 'CELLULAR' as never, isConnected: true, isInternetReachable: true }),
    'cellular'
  );
});

check('type NONE (expo-network\'s own "no active connection" value) -> offline, driven by isConnected rather than the type string itself', () => {
  assert.equal(
    mapExpoNetworkStateToReelNetworkClass({ type: 'NONE' as never, isConnected: false, isInternetReachable: false }),
    'offline'
  );
});

check('isConnected explicitly false -> offline, even if type still claims WIFI (a stale/inconsistent read should never be trusted over isConnected)', () => {
  assert.equal(
    mapExpoNetworkStateToReelNetworkClass({ type: 'WIFI' as never, isConnected: false, isInternetReachable: true }),
    'offline'
  );
});

check('isInternetReachable explicitly false -> offline, even with isConnected true and type WIFI (connected to a Wi-Fi router with no upstream internet)', () => {
  assert.equal(
    mapExpoNetworkStateToReelNetworkClass({ type: 'WIFI' as never, isConnected: true, isInternetReachable: false }),
    'offline'
  );
});

check('unresolved connection type (expo-network\'s own NetworkStateType.UNKNOWN) with a real connection -> unknown, NEVER guessed as wifi', () => {
  assert.equal(
    mapExpoNetworkStateToReelNetworkClass({ type: 'UNKNOWN' as never, isConnected: true, isInternetReachable: true }),
    'unknown'
  );
});

check('every other real OS type (ETHERNET/BLUETOOTH/VPN/WIMAX/OTHER) falls back to unknown, never wifi or cellular', () => {
  for (const type of ['ETHERNET', 'BLUETOOTH', 'VPN', 'WIMAX', 'OTHER']) {
    assert.equal(
      mapExpoNetworkStateToReelNetworkClass({ type: type as never, isConnected: true, isInternetReachable: true }),
      'unknown',
      `type=${type} should be unknown`
    );
  }
});

check('a missing `type` field entirely (isConnected/isInternetReachable still present) -> unknown', () => {
  assert.equal(mapExpoNetworkStateToReelNetworkClass({ isConnected: true, isInternetReachable: true }), 'unknown');
});

check('an entirely empty state object -> unknown (not offline — absence of fields is not the same as a confirmed-false read)', () => {
  assert.equal(mapExpoNetworkStateToReelNetworkClass({}), 'unknown');
});

check('null state (the initial-read-not-resolved-yet case, or a rejected getNetworkStateAsync call) -> unknown', () => {
  assert.equal(mapExpoNetworkStateToReelNetworkClass(null), 'unknown');
});

check('undefined state -> unknown, same as null', () => {
  assert.equal(mapExpoNetworkStateToReelNetworkClass(undefined), 'unknown');
});

check('isInternetReachable undefined (field simply not reported, e.g. some Android/web paths) with type WIFI and isConnected true -> wifi, not offline — only an EXPLICIT false means offline', () => {
  assert.equal(
    mapExpoNetworkStateToReelNetworkClass({ type: 'WIFI' as never, isConnected: true, isInternetReachable: undefined }),
    'wifi'
  );
});

check('pure: identical input always produces identical output', () => {
  const input = { type: 'CELLULAR' as never, isConnected: true, isInternetReachable: true };
  assert.equal(mapExpoNetworkStateToReelNetworkClass(input), mapExpoNetworkStateToReelNetworkClass(input));
});

console.log('\n=== src/ Reel network-class mapping test results ===');
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
