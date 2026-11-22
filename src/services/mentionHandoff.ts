/**
 * A tiny, module-level handoff for exactly one value: the `PublicProfile`
 * a user picked on the full-page mention picker (src/app/(app)/search.tsx,
 * opened in its `mode=select` variant), passed back to whichever caption
 * screen pushed that screen when the user taps a result there. Same
 * "handoff, not a route param" reasoning as reelCameraHandoff.ts's own
 * doc comment — Expo Router's params are for serializable route state,
 * not for handing back a full profile object, and this is a single
 * ephemeral value consumed exactly once, immediately after the picker
 * screen pops back to its caller.
 *
 * Deliberately its own file rather than folded into reelCameraHandoff.ts:
 * "pick someone to mention" isn't a Reel/Post-camera concept — any future
 * caption/comment surface that wants the same full-page mention picker
 * reuses this same handoff instead of importing something reel-specific.
 */
import type { PublicProfile } from '@/types/social';

let pendingSelectedMention: PublicProfile | null = null;

export function setPendingSelectedMention(profile: PublicProfile): void {
  pendingSelectedMention = profile;
}

/** Reads and clears the pending mention in one step, so it's only ever consumed once. */
export function takePendingSelectedMention(): PublicProfile | null {
  const profile = pendingSelectedMention;
  pendingSelectedMention = null;
  return profile;
}
