/**
 * Pure policy behind "should the app actually show the OS notification
 * permission prompt right now?" — extracted into its own file for the
 * same reason as pushTokenChangeDetection.ts: directly testable without
 * expo-notifications, which has no plain-Node runtime.
 *
 * Covers two explicit requirements for this step: "Handle permission
 * denial gracefully" and "Avoid repeated permission prompts" — both
 * reduce to the same rule: only ever prompt from the 'undetermined'
 * state. iOS itself already blocks a second native prompt after a real
 * user denial (a second call just resolves 'denied' again, instantly,
 * with no UI) — this function makes the app's OWN logic agree with that
 * platform behavior instead of accidentally relying on it, so the intent
 * is explicit and testable rather than an incidental side effect of
 * calling an OS API repeatedly.
 */
export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

/** `granted` needs no prompt (already allowed); `denied` must never be re-prompted — only `undetermined` (never asked before) should ever trigger the OS permission dialog. */
export function shouldRequestPermissionPrompt(status: PushPermissionStatus): boolean {
  return status === 'undetermined';
}
