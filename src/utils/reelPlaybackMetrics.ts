/**
 * Step 11D / 11E — DEV-ONLY, in-memory-only Reel playback-startup
 * measurements. No production analytics backend, nothing persisted,
 * nothing sent over the network — every exported function here is
 * `__DEV__`-gated as its own literal first line, before touching any
 * state. Exists purely so a developer scrolling the feed locally can SEE,
 * in the Metro log, whether staged preparation is actually helping.
 *
 * Step 11E split this file in two: ALL the actual classification/
 * eviction DECISIONS now live in the pure, independently-tested
 * src/utils/reelPlaybackSessionState.ts (confirmed to need zero
 * `expo-video`/`expo-network`/react-native imports, and therefore
 * runnable under plain `tsx`). This file is now just the thin, STATEFUL,
 * NATIVE-TOUCHING glue: it owns the one real session-singleton Map, the
 * `__DEV__` gate, the native `getCurrentVideoCacheSize()` read, and the
 * actual `console.log` formatting — none of which can run under plain
 * `tsx` (confirmed by direct probe: `expo-video`, like `expo-network`,
 * transitively requires react-native's own Flow-typed entry point) — so
 * this file is exercised only by the real app, never by
 * tests/reelPlaybackSessionState.test.ts.
 *
 * Step 11E's own audit of Step 11D's metrics found these gaps (see the
 * Step 11E report for the full list): only one latency number existed
 * (source-assigned -> readyToPlay) with no separate URL-resolution
 * timing; no network class was ever recorded on a measurement; no
 * first-view/scroll-back distinction; no prior-preparation-level context
 * (so a WARM-prewarmed activation couldn't be told apart from a cold
 * one — and worse, a WARM player that finished buffering before
 * activation got NO record at all once it became active, since
 * `readyToPlay` had already fired once while merely warm); and no
 * aborted-attempt handling beyond silently dropping the pending ref. All
 * fixed below and in ReelFeedItem.tsx's own completion call sites.
 */
import { getCurrentVideoCacheSize } from 'expo-video';
import { Platform } from 'react-native';

import {
  buildReelPlaybackCompletionRecord,
  MAX_TRACKED_REELS,
  recordActivation,
  recordStartupMsForReel,
  type ReelPlaybackCompletionInput,
  type ReelPlaybackSessionRecord,
  type ReelStartupType,
} from './reelPlaybackSessionState';

const sessionMetrics = new Map<string, ReelPlaybackSessionRecord>();

/**
 * The native video cache's own last-read size, purely so the dev log can
 * show a trivial delta alongside the absolute size (Step 11E — "record
 * ... optionally delta from previous sample if trivial"). Dev-only,
 * unbounded-but-trivial (two numbers, never per-Reel), reset is
 * unnecessary since a stale previous reading just makes the very next
 * delta label read `n/a` once, never wrong.
 */
let lastCacheSizeBytes: number | null = null;

/**
 * Reads the native video cache's own current total size — a coarse,
 * app-wide proxy (never per-Reel, never a per-request cache-hit signal —
 * see this function's own callers) for whether Step 11A's 300MB budget
 * is being approached. Not implemented on web (see expo-video's own
 * NativeVideoModule.web.ts, confirmed empty for this call) and the
 * underlying native call could in principle throw on a platform/version
 * edge case — guarded accordingly, returning `null` rather than ever
 * throwing out of a dev log.
 */
function readNativeVideoCacheSizeBytes(): number | null {
  if (Platform.OS === 'web') return null;
  try {
    return getCurrentVideoCacheSize();
  } catch {
    return null;
  }
}

/** Formats the native cache's absolute size and, when a previous reading exists this session, its delta — e.g. `"118.4MB (+6.2MB)"`. Never claims per-request cache-hit meaning (see readNativeVideoCacheSizeBytes's own doc comment) — this is a coarse growth signal only. */
function formatCacheLabel(): string {
  const sizeBytes = readNativeVideoCacheSizeBytes();
  if (sizeBytes == null) return 'n/a';
  const sizeMb = sizeBytes / (1024 * 1024);
  let label = `${sizeMb.toFixed(1)}MB`;
  if (lastCacheSizeBytes != null) {
    const deltaMb = (sizeBytes - lastCacheSizeBytes) / (1024 * 1024);
    label += ` (${deltaMb >= 0 ? '+' : ''}${deltaMb.toFixed(1)}MB)`;
  }
  lastCacheSizeBytes = sizeBytes;
  return label;
}

/**
 * Call once per genuine isActive(false -> true) transition for a VIDEO
 * Reel (never for a photo — see ReelFeedItem's own `isPhoto` guard at its
 * one call site). Returns the classification the caller needs to build
 * its own pending/prewarmed completion record. A complete no-op in
 * production: the shared session Map is never touched outside `__DEV__`,
 * so there is zero production memory/CPU cost from this whole
 * measurement system — the returned `'first-view'` default is inert in
 * that case (never reaches a real log, since recordReelPlaybackCompletion
 * below is independently `__DEV__`-gated too).
 */
export function recordReelActivation(reelId: string): { startupType: ReelStartupType } {
  if (!__DEV__) return { startupType: 'first-view' };
  const { startupType } = recordActivation(sessionMetrics, reelId, MAX_TRACKED_REELS);
  return { startupType };
}

/**
 * Logs one completed Reel-playback startup — either a genuine
 * source-assigned -> readyToPlay interval, or a `prewarmed` one (the
 * player was already ready the instant this item became active — see
 * ReelPlaybackCompletionInput's own `prewarmed` doc comment). Truncates
 * `reelId` to 8 characters (this codebase's existing "no full identifiers
 * in dev logs" convention) and never logs a URL, token, or full user ID —
 * only the small enum-like fields already carried on the input.
 */
export function recordReelPlaybackCompletion(input: ReelPlaybackCompletionInput): void {
  if (!__DEV__) return;
  const record = buildReelPlaybackCompletionRecord(input);
  const previousStartupMs =
    record.sourceToReadyMs !== null
      ? recordStartupMsForReel(sessionMetrics, record.reelId, record.sourceToReadyMs).previousStartupMs
      : (sessionMetrics.get(record.reelId)?.lastStartupMs ?? null);
  const previousLabel = previousStartupMs != null ? `${Math.round(previousStartupMs)}ms` : 'none yet this session';

  // eslint-disable-next-line no-console
  console.log(
    `[reel-playback] id=${record.reelId.slice(0, 8)} outcome=completed startupType=${record.startupType} ` +
      `network=${record.networkClass} priorLevel=${record.priorLevel} prewarmed=${record.prewarmed} ` +
      `urlSource=${record.urlSource} urlResolutionMs=${record.urlResolutionMs ?? 'n/a'} ` +
      `sourceToReadyMs=${record.sourceToReadyMs ?? 'n/a'} activeToReadyMs=${Math.round(record.activeToReadyMs)} ` +
      `prevSourceToReadyMs=${previousLabel} nativeCache=${formatCacheLabel()}`
  );
}

/**
 * Logs an aborted startup attempt (Reel became active, then the user
 * scrolled away before it ever reached `readyToPlay`) — a single short
 * line, never a fake latency number. Doesn't touch activationCount or
 * lastStartupMs in the session map (the activation itself was already
 * counted by recordReelActivation; an abort has no startup duration to
 * record at all).
 */
export function recordReelPlaybackAborted(reelId: string): void {
  if (!__DEV__) return;
  // eslint-disable-next-line no-console
  console.log(`[reel-playback] id=${reelId.slice(0, 8)} outcome=aborted`);
}
