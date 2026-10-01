/**
 * Step 11D — pure, dependency-free decision logic for how much a Reel
 * feed item should prepare itself, given only its distance from the
 * currently active item and the device's current network class. No
 * React, no expo-video, no Firestore — this file only ever answers "what
 * LEVEL should the item at `index` be, right now," which
 * ReelFeed.tsx/ReelFeedItem.tsx translate into actual URL resolution/
 * player creation/thumbnail prefetch.
 *
 * AUDIT THAT MOTIVATES THIS DESIGN (see the Step 11D report's own
 * "Current feed/player lifecycle" section for the full trace): this
 * codebase's EXISTING `shouldPrepare = Math.abs(index - activeIndex) <= 1`
 * (ReelFeed.tsx, pre-11D) already IS a correct, working two-tier model —
 * "active" (±0, plays) and "warm" (±1, a real player exists and buffers
 * via expo-video's own native loading, but stays paused) — bounded to at
 * most 3 concurrent VideoPlayer instances. That part is NOT changed here
 * (WARM_WINDOW below is still exactly 1, for every network class — see
 * its own doc comment for why shrinking it was evaluated and rejected).
 * What was MISSING, and what this file actually adds, is a third tier:
 * LIGHT — thumbnail + playback-URL warmup (metadata only, NEVER a real
 * player, NEVER video bytes) for a few positions further out, scaled by
 * how expensive the current connection is to avoid "preload 10 full
 * videos" waste (the pre-11D codebase already had a crude, FORWARD-ONLY,
 * always-on version of this for thumbnails alone — this generalizes it
 * to be symmetric, network-aware, and to also warm the playback URL).
 */

/** `active` plays and autoplays; `warm` holds a real, paused, buffering VideoPlayer; `light` warms a thumbnail + playback URL only (no player, no video bytes); `cold` does nothing. */
export type ReelPreparationLevel = 'active' | 'warm' | 'light' | 'cold';

/**
 * `wifi`/`cellular`/`offline` are the real OS-reported classes a future
 * network-detection library would supply; `unknown` is what every
 * caller in THIS codebase actually passes today, since NO such library
 * is installed (audited — neither `@react-native-community/netinfo` nor
 * `expo-network` appear in package.json or node_modules; adding one is
 * explicitly out of scope for this step). `unknown` is deliberately
 * treated identically to `cellular` below — the conservative choice,
 * never assuming a fast/unmetered connection when this app genuinely
 * cannot tell. The moment a real detector is added, only the one call
 * site that currently hardcodes `CURRENT_NETWORK_CLASS` needs to change
 * — every function here already reacts correctly to whichever class it's
 * given.
 */
export type ReelNetworkClass = 'wifi' | 'cellular' | 'offline' | 'unknown';

export type ReelPreparationPolicyInput = {
  index: number;
  activeIndex: number;
  networkClass: ReelNetworkClass;
};

/**
 * The WARM window never varies by network class — see this file's own
 * top doc comment: it's already the minimum real-player bound this app
 * guarantees (current + one neighbor each side = 3 players max), and
 * Part 4 of the Step 11D spec explicitly values keeping the PREVIOUS
 * Reel warm for scroll-back; shrinking WARM to "next only" on cellular
 * was evaluated and rejected — it would make scroll-back worse exactly
 * when the connection is already the one the user can least afford to
 * re-fetch on, for a player count that's already bounded regardless.
 * What actually scales with network cost is LIGHT, below — pure
 * metadata/thumbnail warmup, never a video byte.
 */
const WARM_WINDOW = 1;

/**
 * How many positions beyond WARM the LIGHT tier reaches, per network
 * class:
 *  - `wifi`: 3 — two extra positions each side get thumbnail + URL
 *    warmup (matches this step's own "±2-3" Wi-Fi guidance).
 *  - `cellular` / `unknown`: 2 — exactly one extra position each side.
 *    Conservative, not zero: a single additional cheap metadata call per
 *    side is a reasonable trade for a meaningfully faster next-scroll
 *    start, and matches this step's own "minimal/light farther warmup"
 *    cellular guidance (never a full video prefetch, which this tier
 *    never does at any network class).
 *  - `offline`: 0 — no LIGHT tier at all; rely entirely on whatever the
 *    native video/image caches already hold, never issue a new
 *    resolution/prefetch call for media this app doesn't already have.
 */
const LIGHT_WINDOW_BY_NETWORK: Record<ReelNetworkClass, number> = {
  wifi: 3,
  cellular: 2,
  unknown: 2,
  offline: 0,
};

/**
 * This codebase has no installed network-connectivity API (see this
 * file's own ReelNetworkClass doc comment) — this is the one honest
 * value every real call site can currently supply. Centralized here so
 * exactly one line changes if/when a real detector is added.
 */
export const CURRENT_NETWORK_CLASS: ReelNetworkClass = 'unknown';

/** The core decision — pure function of index distance and network class. */
export function computeReelPreparationLevel({ index, activeIndex, networkClass }: ReelPreparationPolicyInput): ReelPreparationLevel {
  const distance = Math.abs(index - activeIndex);
  if (distance === 0) return 'active';
  if (distance <= WARM_WINDOW) return 'warm';
  if (distance <= LIGHT_WINDOW_BY_NETWORK[networkClass]) return 'light';
  return 'cold';
}

/**
 * `true` for `active`/`warm` — the exact condition the pre-11D
 * `shouldPrepare` prop already encoded (see ReelFeed.tsx's own render,
 * now computed through this function instead of the old inline
 * `Math.abs(...) <= 1`, with byte-identical results for every network
 * class, since WARM_WINDOW is still 1 unconditionally). Applies equally
 * to photo and video Reels — a photo Reel's OWN "playback URL" is its
 * full image, resolved through the same shouldPrepare-gated effect in
 * ReelFeedItem.
 */
export function isWithinWarmWindow(level: ReelPreparationLevel): boolean {
  return level === 'active' || level === 'warm';
}

/**
 * Part 16 of the Step 11D spec's own requirement, made explicit and
 * testable: a real VideoPlayer is only ever warranted for a VIDEO Reel
 * at `active`/`warm` — never for a photo (nothing to play, regardless of
 * level), and never at `light`/`cold` (no player exists that far out by
 * definition). ReelFeedItem.tsx's own `useVideoPlayer(isPhoto ? null :
 * ..., ...)` ternary already independently enforces the photo half of
 * this (unchanged by Step 11D) — this function exists so the POLICY
 * itself states and tests the same invariant, rather than leaving it
 * implicit in one component's own conditional.
 */
export function shouldPrepareVideoPlayer(level: ReelPreparationLevel, mediaType: 'video' | 'photo'): boolean {
  return mediaType === 'video' && isWithinWarmWindow(level);
}

/**
 * `true` only at `light` — `active`/`warm` already warm their own
 * thumbnail/playback URL via ReelFeedItem's own shouldPrepare-gated
 * effects (unchanged by this step); re-triggering the same warmup from
 * ReelFeed's own light-tier effect for those same indices would be
 * redundant (each resolver already dedupes via its own cache, but there
 * is no reason to call twice). `cold` never warms anything.
 */
export function shouldWarmThumbnailAndUrl(level: ReelPreparationLevel): boolean {
  return level === 'light';
}
