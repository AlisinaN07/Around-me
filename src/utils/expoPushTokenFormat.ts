/**
 * Pure shape check for a real Expo push token string — used client-side
 * (a cheap sanity check before ever writing to Firestore) and mirrored
 * independently, byte-for-byte, by firestore.rules' own
 * isValidPushTokenShape (the server-side, authoritative check — this
 * file is defense in depth, never the only guard).
 *
 * Deliberately accepts BOTH documented Expo token variants —
 * `ExponentPushToken[...]` and `ExpoPushToken[...]` — rather than
 * assuming only one literal prefix (Expo's own tooling, e.g.
 * expo-server-sdk's isExpoPushToken, recognizes both; hardcoding just
 * one would reject a legitimate token shape Expo is free to issue).
 * Intentionally does NOT validate the exact length/charset of the
 * content inside the brackets — Expo has never published that as a
 * fixed, stable contract, and over-constraining it risks rejecting a
 * real future token for no security benefit (the content is opaque to
 * this app either way; only the overall shape is meaningful here).
 */
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[.+\]$/;

export function isLikelyExpoPushToken(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 400 && EXPO_PUSH_TOKEN_PATTERN.test(value);
}
