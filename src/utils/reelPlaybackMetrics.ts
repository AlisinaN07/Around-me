/**
 * Step 11D — DEV-ONLY, in-memory-only Reel playback-startup measurements.
 * No production analytics backend, nothing persisted, nothing sent over
 * the network — every call is a no-op outside `__DEV__` (checked first,
 * before touching any state). Exists purely so a developer scrolling the
 * feed locally can SEE, in the Metro log, whether this step's own staged
 * preparation is actually helping: is a scroll-back meaningfully faster
 * than a first arrival, is the native video cache growing unboundedly,
 * was a given Reel's playback URL already warm by the time it became
 * active.
 *
 * Deliberately does NOT invent a cache-hit signal expo-video itself
 * doesn't expose (there is no per-request cache-hit event — see
 * VideoPlayerEvents.types.d.ts, confirmed by reading the installed
 * package, not assumed) — the coarse proxies below (URL-resolution
 * source, startup latency on this attempt vs. the last one THIS reelId
 * was played, the native cache's own total size) are the honest signals
 * this app can actually observe.
 */
import { getCurrentVideoCacheSize } from 'expo-video';
import { Platform } from 'react-native';

/**
 * Bounded (Part 13 of the spec's own "bound it if necessary") — a real
 * session scrolling through hundreds of Reels would otherwise grow this
 * map unboundedly; 200 entries of two small fields each is a trivial
 * amount of memory, comfortably covering a long single-session scroll
 * while still having an explicit ceiling. Plain insertion-order eviction
 * (delete the oldest key) — this is a coarse dev aid, not a cache whose
 * eviction POLICY matters.
 */
const MAX_TRACKED_REELS = 200;

type ReelPlaybackMetricsEntry = { lastStartupMs: number };
const sessionMetrics = new Map<string, ReelPlaybackMetricsEntry>();

/** Where the playback URL for this attempt actually came from — see reels.ts's own isReelPlaybackUrlCached for the 'cache-hit'/'cache-miss' distinction, and resolveReelVideoPlaybackUrl's own doc comment for why an R2 Reel never resolves anything at all (sourceUrl is already persisted). */
export type ReelPlaybackUrlSource = 'r2-persisted' | 'cache-hit' | 'cache-miss';

/**
 * Reads the native video cache's own current total size — a coarse,
 * app-wide proxy (never per-Reel) for whether Step 11A's 300MB budget is
 * actually being approached. Not implemented on web (see expo-video's
 * own NativeVideoModule.web.ts, confirmed empty for this call) and the
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

/**
 * Logs one Reel's own startup latency — the time from its playback URL
 * being assigned (a real source handed to the player) to the player
 * actually reporting `readyToPlay` — labeled with the preparation level
 * it started from and the Hz this exact reelId has already been
 * through this session. `reelId` is truncated to 8 characters, matching
 * this codebase's own "no full identifiers in dev logs" convention —
 * never a URL, token, or credential of any kind.
 */
export function recordReelPlaybackStartup(reelId: string, level: 'active' | 'warm', startupMs: number, urlSource: ReelPlaybackUrlSource): void {
  if (!__DEV__) return;

  const previous = sessionMetrics.get(reelId);
  const cacheSizeBytes = readNativeVideoCacheSizeBytes();
  const cacheLabel = cacheSizeBytes != null ? `${(cacheSizeBytes / (1024 * 1024)).toFixed(1)}MB` : 'n/a';
  const previousLabel = previous ? `${Math.round(previous.lastStartupMs)}ms` : 'none (first time this session)';

  // eslint-disable-next-line no-console
  console.log(
    `[reel-startup] id=${reelId.slice(0, 8)} level=${level} startupMs=${Math.round(startupMs)} urlSource=${urlSource} prevStartupMs=${previousLabel} nativeCache=${cacheLabel}`
  );

  if (!sessionMetrics.has(reelId) && sessionMetrics.size >= MAX_TRACKED_REELS) {
    const oldestKey = sessionMetrics.keys().next().value;
    if (oldestKey !== undefined) sessionMetrics.delete(oldestKey);
  }
  sessionMetrics.set(reelId, { lastStartupMs: startupMs });
}
