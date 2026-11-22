/**
 * Pure mapping from a raw OS name (react-native's own `Platform.OS`
 * string) to the platform value this app's push-token schema actually
 * accepts — extracted so "which platforms are supported" is directly
 * testable without importing `react-native` itself (which needs
 * Metro's own platform-specific module resolution and cannot run under
 * plain tsx — the same reason every other RN-coupled piece of this
 * foundation stays untested directly; see src/services/pushTokens.ts's
 * own currentPlatform, the real caller of this function).
 *
 * `null` for web (and any other platform this app doesn't build push
 * support for) — every exported function in pushTokens.ts checks this
 * first and returns a clean "unsupported" result rather than ever
 * attempting a Notifications/Firestore call on an unsupported platform.
 */
export type PushTokenPlatform = 'ios' | 'android';

export function resolvePushTokenPlatform(osName: string): PushTokenPlatform | null {
  if (osName === 'ios') return 'ios';
  if (osName === 'android') return 'android';
  return null;
}
