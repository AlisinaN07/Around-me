/**
 * users/{uid}/recommendationProfile/main — the Firestore-touching half of
 * Steps 4-5. All the actual scoring/decay/cold-start MATH lives in
 * profileLogic.ts (pure, dependency-free, directly unit-tested by
 * tests/recommendations.test.ts) — this file is just read/write plumbing
 * on top of it, plus the pending-value type surface other modules import.
 */
import { doc, getDoc, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';

import type { RecommendationAction, RecommendationProfile, TrackInteractionInput } from '@/types/recommendation';

import { firestore } from '../firestore';
import { applyColdStartSeed, applyDecay, applyInteractionToProfile, emptyRecommendationProfile, toProfile } from './profileLogic';
import { INTERACTION_RETRY } from './recommendationConfig';

export function recommendationProfileRef(uid: string) {
  return doc(firestore!, 'users', uid, 'recommendationProfile', 'main');
}

/** Reads the caller's own recommendation profile, decayed to "now" — never another user's (the caller always passes their own uid; Firestore rules independently enforce this too). Returns the empty/cold-start shape for a brand-new account rather than null, so callers never need a separate "no profile yet" branch. `onboardingInterestIds` (that account's `users/{uid}.interests`) only ever matters for a true cold start — see applyColdStartSeed's own doc comment in profileLogic.ts. */
export async function fetchInterestProfile(uid: string, onboardingInterestIds: readonly string[] = []): Promise<RecommendationProfile> {
  const now = Date.now();
  if (!firestore) return applyColdStartSeed(emptyRecommendationProfile(now) as unknown as RecommendationProfile, onboardingInterestIds);
  const snapshot = await getDoc(recommendationProfileRef(uid));
  const profile = toProfile(snapshot.exists() ? snapshot.data() : null, now);
  return applyColdStartSeed(applyDecay(profile, now), onboardingInterestIds);
}

/**
 * Recommendation Engine — Step 3, Step 20 — retries a transient Firestore
 * failure a bounded number of times. Safe to simply re-run the WHOLE
 * transaction on failure: Firestore transactions are all-or-nothing, so a
 * failed attempt never partially applied — there is no risk of a retry
 * double-counting anything. Only retries error codes that genuinely mean
 * "try again" (contention, a deadline, a transient unavailability) — a
 * non-transient error (e.g. permission-denied) would just fail the exact
 * same way again, so retrying it only wastes a round trip and delays the
 * dev-time warning interactions.ts already logs on final failure.
 */
async function runWithRetry<T>(task: () => Promise<T>): Promise<T> {
  const { maxAttempts, backoffMs } = INTERACTION_RETRY;
  for (let attempt = 1; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const code = (error as { code?: string } | null | undefined)?.code;
      const isTransient = code === 'aborted' || code === 'failed-precondition' || code === 'deadline-exceeded' || code === 'unavailable';
      if (!isTransient || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
    }
  }
}

/**
 * Applies one interaction to the caller's own profile via a Firestore
 * transaction (read-modify-write in one round trip, so two interactions
 * landing close together — e.g. rapid like+comment — never clobber each
 * other), retried a bounded number of times on a transient failure (see
 * runWithRetry above). Called by interactions.ts right after logging the
 * raw event — and, in the real app, only ever from INSIDE that same
 * uid's own interaction queue (see reliability.ts's
 * enqueueRecommendationInteraction), which already serializes same-uid
 * transactions so they never race each other from this client to begin
 * with; this retry only needs to cover genuine cross-device/cross-tab
 * contention on top of that. UI code should never call this directly.
 */
export async function applyInteractionAndPersist(
  uid: string,
  input: Pick<TrackInteractionInput, 'action' | 'categoryId' | 'creatorId' | 'cityKey' | 'contentId'>
): Promise<void> {
  if (!firestore) return;
  const db = firestore;
  const ref = recommendationProfileRef(uid);

  await runWithRetry(() =>
    runTransaction(db, async (transaction) => {
      const nowMs = Date.now();
      const snapshot = await transaction.get(ref);
      const current = toProfile(snapshot.exists() ? snapshot.data() : null, nowMs);
      const next = applyInteractionToProfile(current, input, nowMs);
      transaction.set(ref, { ...next, updatedAt: serverTimestamp() });
    })
  );
}

/** Resets the caller's own profile back to the empty/cold-start shape — never another uid's. Not currently wired into account deletion (see this feature's own report); exposed for that future call site. */
export async function resetInterestProfile(uid: string): Promise<void> {
  if (!firestore) return;
  await setDoc(recommendationProfileRef(uid), { ...emptyRecommendationProfile(Date.now()), updatedAt: serverTimestamp() });
}

// Re-exported so callers that only need profile MATH (no Firestore) can
// still import everything from this one familiar path — see
// profileLogic.ts for the real implementations and their own doc comments.
export { applyColdStartSeed, applyDecay, applyInteractionToProfile, emptyRecommendationProfile, trimScoreMap } from './profileLogic';

// Re-exported action weight lookup for callers that want the raw number
// without importing recommendationConfig directly (e.g. debug tooling).
export { SIGNAL_WEIGHTS } from './recommendationConfig';
export type { RecommendationAction };
