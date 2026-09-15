/**
 * Recommendation Engine — Step 3 — tracking-RELIABILITY primitives: a
 * per-user interaction queue (Steps 8/9/10), short-lived duplicate
 * suppression (Step 11), and profile-read cache freshness (Step 16).
 *
 * Deliberately dependency-free (only recommendationConfig.ts + types — no
 * Firebase/Firestore/React Native imports at all), same reasoning as
 * profileLogic.ts/bucketing.ts's own split: tests/recommendations.test.ts
 * can exercise the REAL implementation directly under plain tsx, not a
 * proxy for it. All state here is in-memory and session-local only —
 * nothing in this file is ever persisted or sent to Firestore.
 */
import type { RecommendationAction } from '@/types/recommendation';

import { DEDUPE_WINDOWS_MS } from './recommendationConfig';

// ---------------------------------------------------------------------------
// Steps 8/9/10 — per-user interaction queue. Serializes every profile-
// mutating transaction for the SAME uid so two interactions landing close
// together (a watch summary + a like + a follow, all within a second)
// never run their Firestore transactions concurrently from this client —
// the actual, direct fix for the rapid-tracking transaction conflicts
// Step 8 describes. A DIFFERENT uid gets its own independent chain, so
// one user's tracking never waits on another's.
// ---------------------------------------------------------------------------
type QueueTask<T> = () => Promise<T>;

const queueTails = new Map<string, Promise<unknown>>();

/**
 * Runs `task` after every previously-enqueued task for this SAME `uid`
 * has settled (succeeded OR failed) — preserving submission order
 * (Step 9's "preserve event ordering") without ever blocking the CALLER:
 * this returns immediately with a Promise for `task`'s own eventual
 * result; nothing here awaits the queue before returning (Step 9's own
 * "do NOT make the user wait for writes" — UI code already never awaits
 * trackContentInteraction for its own rendering, so this adds no new
 * blocking behavior on top of that).
 *
 * Chaining on `.then(task, task)` (not `.then(task).catch(...)`) is
 * deliberate: an earlier interaction that ultimately failed must never
 * poison every interaction queued after it (Step 9's own "avoid losing
 * meaningful interactions") — this task still runs on schedule either way.
 */
export function enqueueRecommendationInteraction<T>(uid: string, task: QueueTask<T>): Promise<T> {
  const previousTail = queueTails.get(uid) ?? Promise.resolve();
  const result = previousTail.then(task, task);
  // The stored tail itself must never reject (a rejected Promise stored
  // here would make the NEXT enqueue's `.then(task, task)` still work
  // correctly since both branches run `task`, but leaving a rejected
  // Promise as the map's stored value would surface an "unhandled
  // rejection" the moment nothing else observes it) — swallow here;
  // the REAL result (including any rejection) is still returned to this
  // call's own caller via `result` above.
  queueTails.set(
    uid,
    result.then(
      () => undefined,
      () => undefined
    )
  );
  return result;
}

/** Test-only introspection — never called from real app code. Lets a test await "this uid's queue has fully drained" without a fixed sleep. */
export function currentQueueTailForTesting(uid: string): Promise<unknown> | undefined {
  return queueTails.get(uid);
}

// ---------------------------------------------------------------------------
// Step 11 — short-lived duplicate-interaction suppression. Keyed by
// (userId, action, contentId) — the same logical interaction fired again
// within its configured window (DEDUPE_WINDOWS_MS) is treated as an
// accidental repeat (a rerender re-running an effect, a double-tap, a
// visibility toggle) rather than a second real signal. An action with NO
// configured window is NEVER deduped — see DEDUPE_WINDOWS_MS's own doc
// comment for why that matters (a genuinely repeatable action like `like`
// or `complete` must always be recordable again).
// ---------------------------------------------------------------------------
const lastFiredAtByKey = new Map<string, number>();
/** Bounded, in-memory only (never persisted) — see pruneOldestDedupeEntries. A long-lived app session interacting with thousands of distinct pieces of content should never let this grow forever. */
const MAX_DEDUPE_ENTRIES = 500;

function dedupeKey(userId: string, action: RecommendationAction, contentId: string): string {
  return `${userId}:${action}:${contentId}`;
}

/**
 * True when the SAME (userId, action, contentId) already fired within its
 * configured dedupe window — the caller should skip the interaction
 * entirely (no event log write, no profile mutation) when this returns
 * true. Records this firing as a side effect whenever it returns false
 * (i.e., whenever the caller is actually about to send it) — call this
 * at most once per real attempt, right before deciding whether to
 * proceed. `nowMs` is an explicit parameter (never reads the clock
 * itself) so this stays trivially deterministic to unit test.
 */
export function isDuplicateInteraction(userId: string, action: RecommendationAction, contentId: string, nowMs: number): boolean {
  const windowMs = DEDUPE_WINDOWS_MS[action];
  if (!windowMs || !contentId) return false;
  const key = dedupeKey(userId, action, contentId);
  const lastFiredAt = lastFiredAtByKey.get(key);
  if (lastFiredAt !== undefined && nowMs - lastFiredAt < windowMs) {
    return true;
  }
  lastFiredAtByKey.set(key, nowMs);
  if (lastFiredAtByKey.size > MAX_DEDUPE_ENTRIES) pruneOldestDedupeEntries();
  return false;
}

/** Drops the oldest half of tracked keys — simple, deterministic, and more than good enough for a short-lived convenience cache that was never meant to be a lifetime record (recommendationEvents already is that). */
function pruneOldestDedupeEntries(): void {
  const entries = [...lastFiredAtByKey.entries()].sort((a, b) => a[1] - b[1]);
  const toDrop = entries.slice(0, Math.floor(entries.length / 2));
  for (const [key] of toDrop) lastFiredAtByKey.delete(key);
}

/** Test-only reset — real app code never needs to clear this (entries simply age out of relevance once their window passes). */
export function resetDedupeStateForTesting(): void {
  lastFiredAtByKey.clear();
}

// ---------------------------------------------------------------------------
// Step 16 — profile-read cache freshness. A pure timestamp comparison;
// the actual cached VALUE and the Firestore read live in profileCache.ts
// (which needs interestProfile.ts, and therefore Firebase — kept out of
// this dependency-free file on purpose).
// ---------------------------------------------------------------------------
export function isCacheFresh(fetchedAtMs: number, nowMs: number, lifetimeMs: number): boolean {
  return nowMs - fetchedAtMs < lifetimeMs;
}
