/**
 * Phase 2 perf pass — the one small shared building block behind every
 * per-data-type cache added this phase (public profiles, isFollowing,
 * isPostSaved, active-story state). Deliberately NOT a general caching
 * framework: this is the ~30 lines of Map + in-flight-Promise + TTL
 * bookkeeping every one of those caches would otherwise duplicate
 * byte-for-byte. Each actual cache still owns its own instance, its own
 * TTL, and its own key shape (see e.g. publicProfile.ts's own
 * profileCache) — this only factors out "check freshness, dedupe
 * concurrent fetches for the same key, let the caller decide what to
 * store" so that mechanism is written and tested once.
 *
 * Deliberately does NOT auto-cache whatever a dedupe()'d fetch returns —
 * the caller (e.g. fetchPublicProfile) decides via `set` whether/what to
 * persist. This matters for at least one real case: a "not found" result
 * must never be cached here, or a profile read moments before it's
 * created (see ensureMyPublicProfile's own read-after-write) would keep
 * reporting "not found" for the rest of the TTL even after it exists.
 */

export class TtlCache<T> {
  private readonly store = new Map<string, { value: T; fetchedAt: number }>();
  // Untyped on purpose (`unknown`, not `Promise<T>`) — dedupe() below is
  // generic over its OWN return type R (usually T, sometimes a nullable
  // variant like `PublicProfile | null` for a fetch that hasn't decided
  // yet whether its result is even cacheable — see fetchPublicProfile's
  // own doc comment). The in-flight map only needs to hand the SAME
  // promise back to concurrent callers of the SAME key; it never reads or
  // interprets what that promise resolves to, so it doesn't need T's
  // exact shape.
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly ttlMs: number) {}

  /** The cached value only if it's still within TTL — undefined on a miss OR an expired entry (never returns stale data). */
  getFresh(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    return Date.now() - entry.fetchedAt < this.ttlMs ? entry.value : undefined;
  }

  /** Writes a value directly, stamped as fetched right now — used both after a real fetch and by explicit invalidation/update hooks that already know the new value (e.g. a successful follow/unfollow). */
  set(key: string, value: T): void {
    this.store.set(key, { value, fetchedAt: Date.now() });
  }

  /** Explicit invalidation — the next getFresh() call (or dedupe()) for this key is a real miss. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /**
   * Dedupes concurrent fetches for the same key: if one is already in
   * flight, every other caller awaits that SAME promise instead of
   * starting a second Firestore request. Does not itself write to the
   * cache — see this file's own top doc comment for why. Generic over R
   * (defaulting to T) rather than hard-coded to T, since a fetch is
   * sometimes allowed to resolve to something the cache will never
   * actually store (e.g. `null` for a not-yet-existing profile).
   */
  dedupe<R = T>(key: string, fetchFn: () => Promise<R>): Promise<R> {
    const existing = this.inFlight.get(key) as Promise<R> | undefined;
    if (existing) return existing;
    const promise: Promise<R> = fetchFn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}
