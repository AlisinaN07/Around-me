/**
 * Local, per-uid marker for a push-token logout cleanup that was
 * attempted but did not confirm success — same exact pattern as
 * src/utils/deletionPending.ts (a proven, existing convention in this
 * codebase), reused here for a different purpose.
 *
 * NOT itself a security boundary. The actual cross-account privacy
 * guarantee (see src/services/pushTokens.ts's own top doc comment) comes
 * from the SERVER-SIDE `pushTokenOwners/{token}` registry being correctly
 * reassigned on every REAL registration, regardless of whether any
 * cleanup here ever succeeds. This marker's only job is to let an
 * INTERRUPTED logout (offline, app killed mid-flow) retry its own
 * cleanup the next time THIS SAME uid's session is available to retry it
 * as itself — which is only possible before that session truly ends.
 * Once the uid has genuinely signed out (and especially once a DIFFERENT
 * user has signed in on this device), this marker can no longer be
 * resolved by retrying — see pushTokens.ts's own doc comment on exactly
 * why that's fine and expected, not a gap this file needs to also cover.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY_PREFIX = 'aroundme.pendingPushTokenCleanup.';

function keyForUid(uid: string): string {
  return `${STORAGE_KEY_PREFIX}${uid}`;
}

export async function markPushTokenCleanupPending(uid: string): Promise<void> {
  await AsyncStorage.setItem(keyForUid(uid), '1');
}

export async function clearPushTokenCleanupPending(uid: string): Promise<void> {
  await AsyncStorage.removeItem(keyForUid(uid));
}

export async function isPushTokenCleanupPending(uid: string): Promise<boolean> {
  const value = await AsyncStorage.getItem(keyForUid(uid));
  return value === '1';
}
