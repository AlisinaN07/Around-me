/**
 * A tiny, module-level handoff for exactly one value: the local URI of a
 * just-recorded Reel video, passed from the camera route
 * (src/app/(app)/create/reel/camera.tsx) back to the Create Reel entry
 * screen (src/app/(app)/create/reel/index.tsx) it was pushed from.
 *
 * This exists purely because Expo Router's params are meant for
 * serializable route state, not for handing an ephemeral local-file URI
 * back to the exact screen instance already underneath the camera route on
 * the stack — pushing the entry route again with params would create a
 * second instance instead of updating the one being returned to. A
 * `router.back()` plus this module-level value, read once via
 * `useFocusEffect` when the entry screen regains focus, is the simplest
 * correct fit for a single ephemeral in-memory handoff — no new
 * state-management dependency needed for one value.
 */
let pendingRecordedVideoUri: string | null = null;

export function setPendingRecordedVideoUri(uri: string): void {
  pendingRecordedVideoUri = uri;
}

/** Reads and clears the pending URI in one step, so it's only ever consumed once. */
export function takePendingRecordedVideoUri(): string | null {
  const uri = pendingRecordedVideoUri;
  pendingRecordedVideoUri = null;
  return uri;
}
