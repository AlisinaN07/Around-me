/**
 * Step 11D.1 — pure, dependency-on-types-only mapping from `expo-network`'s
 * own `NetworkState` shape to this app's `ReelNetworkClass`. Deliberately
 * split out of src/hooks/useReelNetworkClass.ts (the native subscription
 * boundary) so this one function — the actual classification DECISION —
 * can be tested with plain objects and no React/native module involved at
 * all, same spirit as reelPreparationPolicy.ts itself.
 *
 * Mapping, in priority order (never guesses an unresolved/unknown
 * connection type as Wi-Fi):
 *   1. `isConnected === false` OR `isInternetReachable === false` ->
 *      `offline` — the device itself (or expo-network's own validation on
 *      Android — see NetworkState's own isInternetReachable doc comment)
 *      is telling us plainly there's no usable connection, regardless of
 *      what `type` says.
 *   2. `type === NetworkStateType.WIFI` -> `wifi`.
 *   3. `type === NetworkStateType.CELLULAR` -> `cellular`.
 *   4. Everything else (`UNKNOWN`, `ETHERNET`, `BLUETOOTH`, `VPN`,
 *      `WIMAX`, `OTHER`, a missing `type`, or no state at all — the
 *      initial-read-not-resolved-yet case) -> `unknown`, this app's own
 *      existing conservative default (see reelPreparationPolicy.ts —
 *      `unknown` already behaves identically to `cellular` there).
 *
 * Deliberately a TYPE-ONLY import of `expo-network` (confirmed by
 * tracing: `expo-network`'s real module chain pulls in `react-native`
 * itself, which `node_modules/react-native/index.js` guards with Flow
 * syntax plain `tsx`/esbuild can't parse outside Metro — the exact same
 * class of constraint this repo's own test convention already works
 * around for the `@/` path alias). A `NetworkStateType` string enum's
 * runtime value for each member IS its own name (`WIFI = "WIFI"`, etc. —
 * confirmed by reading the installed package's own Network.types.d.ts),
 * so comparing `state.type` against the literal strings below is exactly
 * as correct as comparing against the enum member, while keeping this
 * file runnable under plain `tsx` (no React Native bundler) for its own
 * tests — see tests/reelNetworkClass.test.ts.
 */
import type { NetworkState } from 'expo-network';

import type { ReelNetworkClass } from './reelPreparationPolicy';

export function mapExpoNetworkStateToReelNetworkClass(state: NetworkState | null | undefined): ReelNetworkClass {
  if (!state) return 'unknown';

  if (state.isConnected === false || state.isInternetReachable === false) {
    return 'offline';
  }
  if (state.type === 'WIFI') return 'wifi';
  if (state.type === 'CELLULAR') return 'cellular';
  return 'unknown';
}
