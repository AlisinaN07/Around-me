/**
 * Step 11E — the PURE half of Reel playback-measurement bookkeeping: zero
 * imports from `expo-video`/`expo-network`/`react-native` (confirmed
 * necessary, not just tidy, by direct tracing before writing this file —
 * both of those native packages transitively pull in react-native's own
 * Flow-typed entry point, which plain `tsx` cannot parse; probed and
 * reproduced the exact failure both steps 11D.1 and this one). Every
 * function here takes its state as a plain argument instead of touching a
 * module-level singleton, so this whole file runs — and is fully tested —
 * under plain `tsx`, exactly like reelPreparationPolicy.ts and
 * reelNetworkClass.ts. The real session-singleton Map, the `__DEV__`
 * gate, and the native cache-size/console.log glue live in
 * src/utils/reelPlaybackMetrics.ts, which imports FROM this file, never
 * the other way around — see that file's own top doc comment.
 */
import type { ReelNetworkClass } from './reelPreparationPolicy';

/** Where a video Reel's playback URL actually came from this attempt — see resolveReelVideoPlaybackUrl's own doc comment in reels.ts. Never a real URL. */
export type ReelPlaybackUrlSource = 'r2-persisted' | 'cache-hit' | 'cache-miss';

/** The ReelPreparationLevel this item was at the instant BEFORE this activation — never `'active'` itself, since that's what it's transitioning TO (see reelPreparationPolicy.ts's own `ReelPreparationLevel`). */
export type PriorReelPreparationLevel = 'warm' | 'light' | 'cold';

/** `'first-view'`: the first time THIS Reel has become the active item this session, by this file's own bounded per-Reel counter. `'scroll-back'`: the 2nd+ time. */
export type ReelStartupType = 'first-view' | 'scroll-back';

/**
 * The bounded, in-memory-only, per-Reel session record this whole
 * measurement system keeps — never persisted, capped at
 * MAX_TRACKED_REELS (see recordActivation).
 */
export type ReelPlaybackSessionRecord = {
  activationCount: number;
  /**
   * The last successfully measured `sourceToReadyMs` for this Reel this
   * session — a PREWARMED completion (see isPrewarmedActivation) has no
   * fresh source-to-ready interval to report for that activation and
   * leaves this unchanged, purely so the dev log's own "previous attempt"
   * comparison (the same role Step 11D's `lastStartupMs` already played)
   * keeps showing the last REAL measured interval rather than being
   * wiped to null by a prewarmed hit.
   */
  lastStartupMs: number | null;
};

/** Same ceiling Step 11D already used for its session map — a long single-session scroll through hundreds of Reels stays bounded; this is a coarse dev aid, not a cache whose eviction POLICY matters, so plain insertion-order eviction is an intentionally simple choice. */
export const MAX_TRACKED_REELS = 200;

/**
 * `activationCount <= 1` deliberately, not `=== 1` — a record that
 * somehow reaches this with a 0 or negative count (defensive; should
 * never happen from real call sites, which always pass a freshly
 * incremented count) still reads as a first view rather than
 * misclassifying as scroll-back.
 */
export function classifyStartupType(activationCount: number): ReelStartupType {
  return activationCount <= 1 ? 'first-view' : 'scroll-back';
}

/**
 * A startup attempt that never reaches `readyToPlay` before the Reel
 * stops being active (a fast scroll-through) must never be logged as a
 * real, completed latency — this is the one-line decision behind that
 * rule, pulled out so it's independently testable rather than left as an
 * inline `if` only the component itself enforces.
 */
export function determineStartupOutcome(input: { reachedReady: boolean }): 'completed' | 'aborted' {
  return input.reachedReady ? 'completed' : 'aborted';
}

/**
 * `true` only when the player was already fully buffered and reporting
 * `readyToPlay` BEFORE this activation happened — meaning the user
 * experiences near-zero real startup latency, and there is no fresh
 * source-assign timestamp to measure a `sourceToReadyMs` from for this
 * specific activation (see ReelFeedItem's own prewarmed completion
 * branch, which reports `activeToReadyMs: 0` and `sourceToReadyMs: null`
 * instead). A `'light'`/`'cold'` prior level can never be prewarmed by
 * construction — no player exists at those levels at all (see
 * reelPreparationPolicy.ts's own `isWithinWarmWindow`) — so the explicit
 * `priorLevel === 'warm'` check here is a second, independent guard
 * against ever trusting a stray `wasAlreadyReady: true` for a level that
 * structurally cannot hold a ready player.
 */
export function isPrewarmedActivation(priorLevel: PriorReelPreparationLevel, wasAlreadyReady: boolean): boolean {
  return priorLevel === 'warm' && wasAlreadyReady;
}

/** Context captured the instant a Reel becomes active, for a startup that is still pending a `readyToPlay` it hasn't reached yet (see isPrewarmedActivation for the other case, which needs no pending record at all). */
export type PendingReelStartup = {
  activatedAt: number;
  priorLevel: PriorReelPreparationLevel;
  startupType: ReelStartupType;
};

/**
 * The exact guard against double-logging one startup attempt: a SECOND
 * `readyToPlay` for the same activation (a mid-playback rebuffer, a
 * brief source hiccup) finds `pending` already cleared by the first call
 * and correctly reports `shouldRecord: false` — see
 * tests/reelPlaybackSessionState.test.ts for the exact two-call sequence
 * this models.
 */
export function consumePendingStartup(pending: PendingReelStartup | null): { shouldRecord: boolean } {
  return { shouldRecord: pending !== null };
}

/**
 * Insertion-order eviction once a bounded Map is at capacity and about to
 * receive a brand-new key — a coarse dev aid, not a cache whose eviction
 * POLICY matters, so "oldest inserted" (not "least recently used") is an
 * intentionally simple choice. A no-op if `key` already exists (updating
 * an existing entry never needs to evict anything) or the map has room.
 */
export function evictOldestIfAtCapacity<K, V>(map: Map<K, V>, key: K, maxSize: number): void {
  if (map.has(key) || map.size < maxSize) return;
  const oldestKey = map.keys().next().value;
  if (oldestKey !== undefined) map.delete(oldestKey);
}

/**
 * Increments (or creates) `reelId`'s bounded session record and returns
 * this activation's classification — the one function that actually
 * grows the shared Map, so every caller (real app code and tests alike)
 * goes through the same eviction guard rather than writing to the map
 * directly. Takes the Map as a plain argument rather than closing over a
 * module singleton, so this is exactly as testable with a throwaway Map
 * as every other pure function in this file.
 */
export function recordActivation(
  sessionMetrics: Map<string, ReelPlaybackSessionRecord>,
  reelId: string,
  maxSize: number = MAX_TRACKED_REELS
): { activationCount: number; startupType: ReelStartupType } {
  evictOldestIfAtCapacity(sessionMetrics, reelId, maxSize);
  const existing = sessionMetrics.get(reelId);
  const activationCount = (existing?.activationCount ?? 0) + 1;
  sessionMetrics.set(reelId, { activationCount, lastStartupMs: existing?.lastStartupMs ?? null });
  return { activationCount, startupType: classifyStartupType(activationCount) };
}

/**
 * Records a freshly measured `sourceToReadyMs` against an already-
 * existing session record (every completion is necessarily preceded by
 * its own `recordActivation` call for the same reelId, so there is
 * always an entry here — the `?? 0`/`?? null` fallbacks are defensive,
 * not an expected path) and returns whatever the PREVIOUS value was, for
 * the dev log's own "previous attempt" comparison.
 */
export function recordStartupMsForReel(
  sessionMetrics: Map<string, ReelPlaybackSessionRecord>,
  reelId: string,
  startupMs: number
): { previousStartupMs: number | null } {
  const existing = sessionMetrics.get(reelId);
  const previousStartupMs = existing?.lastStartupMs ?? null;
  sessionMetrics.set(reelId, { activationCount: existing?.activationCount ?? 0, lastStartupMs: startupMs });
  return { previousStartupMs };
}

/** Everything one completed Reel-playback-startup dev record carries — see ReelFeedItem's two completion call sites (prewarmed and normal) for how each field is actually sourced. */
export type ReelPlaybackCompletionInput = {
  reelId: string;
  networkClass: ReelNetworkClass;
  priorLevel: PriorReelPreparationLevel;
  startupType: ReelStartupType;
  urlSource: ReelPlaybackUrlSource;
  /** `null` if the URL was never freshly resolved this activation (e.g. a prewarmed hit with no new resolution at all). */
  urlResolutionMs: number | null;
  /** `null` for a prewarmed completion — no fresh source-assign timestamp exists for this activation to measure from. */
  sourceToReadyMs: number | null;
  /** `0` for a prewarmed completion (the player was already ready the instant this item became active). */
  activeToReadyMs: number;
  prewarmed: boolean;
};

/** Named separately from `ReelPlaybackCompletionInput` (even though identical today) so the logging glue and tests refer to "the record," not "the input," in case the two shapes ever need to diverge (e.g. a derived field added only at the logging layer). */
export type ReelPlaybackCompletionRecord = ReelPlaybackCompletionInput;

/**
 * A pure, trivial pass-through — exists specifically so the field-
 * fidelity of a completion record (does `networkClass` survive
 * unchanged? does `urlSource`?) is independently testable without
 * importing the native-touching logging glue in reelPlaybackMetrics.ts.
 */
export function buildReelPlaybackCompletionRecord(input: ReelPlaybackCompletionInput): ReelPlaybackCompletionRecord {
  return { ...input };
}
