/**
 * Pure decision behind "should this device's push-token document actually
 * be written?" — extracted into its own, dependency-free file so it's
 * directly unit-testable under plain tsx (src/services/pushTokens.ts
 * itself can't be: it transitively imports firebase.ts, which references
 * the Expo-only `__DEV__` global, and calls real expo-notifications APIs
 * that don't exist outside a real app runtime).
 *
 * Covers two of the explicit requirements for this step: "Avoid
 * unnecessary writes when token information has not changed" and
 * "Support token rotation" — both are the same comparison, just with a
 * different outcome (false vs. true).
 */
export type StoredPushTokenRecord = {
  expoPushToken: string;
  platform: 'ios' | 'android';
};

/**
 * `storedRecord` is `null` for a device that has never registered before
 * (first-ever registration always needs a write). Comparing BOTH fields —
 * not just the token string — because a device reinstalling the app under
 * a different platform build (practically impossible in reality, but not
 * assumed away here) must still be treated as a real change.
 */
export function hasPushTokenChanged(storedRecord: StoredPushTokenRecord | null, current: StoredPushTokenRecord): boolean {
  if (!storedRecord) return true;
  return storedRecord.expoPushToken !== current.expoPushToken || storedRecord.platform !== current.platform;
}

/**
 * Step 3D — a genuine TOKEN ROTATION specifically (the OS issued a new
 * token value for an ALREADY-registered device), as distinct from a
 * first-ever registration (`storedRecord === null`) or a platform-only
 * change. This is what tells `ensurePushTokenRegistered`
 * (src/services/pushTokens.ts) whether the OLD token's own
 * `pushTokenOwners` entry needs releasing — a stale ownership record for
 * a now-dead token is a real, if low-severity, hygiene gap this step
 * fixes (see that function's own doc comment for the full reasoning).
 */
export function isTokenRotation(storedRecord: StoredPushTokenRecord | null, current: StoredPushTokenRecord): boolean {
  return storedRecord !== null && storedRecord.expoPushToken !== current.expoPushToken;
}
