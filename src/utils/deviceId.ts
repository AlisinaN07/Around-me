/**
 * A stable, per-install, NON-sensitive device identifier — generated
 * once, locally, and persisted in AsyncStorage for the lifetime of this
 * app install. Deliberately NOT derived from any real hardware/OS
 * identifier (no IDFV, no Android ID, no expo-device/expo-application
 * dependency) — a plain random string is all `users/{uid}/pushTokens/{deviceId}`
 * needs: something distinct per install so a user with multiple devices
 * gets multiple token documents, never something that could identify the
 * physical device across app reinstalls, across different apps, or
 * without the user's own Firebase account.
 *
 * This is also deliberately NEVER the push token itself — see
 * src/services/pushTokens.ts's own doc comment for why the raw Expo push
 * token must never be used as a Firestore document ID (it can rotate,
 * and reusing a rotated token's own string as an ID would leave an
 * orphaned document behind under the OLD id).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'aroundme.deviceId';

function generateDeviceId(): string {
  return `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Returns this install's existing device id, or generates and persists a
 * fresh one on first call. Safe to call repeatedly — always returns the
 * SAME value for the life of this app install (until the user clears app
 * data/reinstalls, which is indistinguishable from a brand-new install,
 * exactly as intended).
 */
export async function getOrCreateDeviceId(): Promise<string> {
  const existing = await AsyncStorage.getItem(STORAGE_KEY);
  if (existing) return existing;
  const generated = generateDeviceId();
  await AsyncStorage.setItem(STORAGE_KEY, generated);
  return generated;
}
