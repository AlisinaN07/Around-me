/**
 * Recommendation Engine — Step 5 — the client-visible shape of
 * `users/{uid}/recommendationProfile/collaborative`, the trusted,
 * backend-only aggregate collaborative-filtering output (see
 * functions/src/collaborative.ts for the pipeline that computes and
 * writes it, and firestore.rules' own `recommendationProfile/{docId}`
 * block — already read-own/write-'main'-only, so no rules change was
 * needed for this new docId at all).
 *
 * PRIVACY (Step 6) — this is the FULL field set the backend ever writes;
 * there is no neighbor uid, no other user's raw score, and no per-
 * interaction history anywhere in it, by construction (see
 * functions/src/collaborative.ts's own CollaborativeProfileDoc type,
 * which this mirrors exactly).
 */

export interface CollaborativeProfile {
  /** Discovery-oriented category scores (0-1) — categories similar users engage with that this viewer hasn't yet strongly discovered themselves (see ranking.ts's scoreCollaborativeAffinity). Never includes a category the viewer already scores strongly on personally (Step 8). */
  categoryScores: Record<string, number>;
  /** How many qualifying neighbors (already past the backend's own similarity threshold) contributed to this result — an aggregate COUNT only, never neighbor identities. */
  neighborCount: number;
  /** Mean cosine similarity across those neighbors, 0-1. */
  averageSimilarity: number;
  /** 0-1 — see ranking.ts's own doc comment on how this scales the collaborative ranking dimension. 0 means "not enough qualifying data" (Step 15/23) — the caller should treat that identically to having no collaborative doc at all. */
  confidence: number;
  /** The source recommendationProfile's own interactionCount at computation time — a coarse staleness signal (Step 12/17): a viewer who has interacted heavily since this was generated has an outdated (but still safely usable, per Step 17) result. */
  sourceInteractionCount: number;
  /** Epoch ms this result was generated. */
  generatedAt: number;
  schemaVersion: number;
}

/** A safe stand-in for "no collaborative doc yet" (Step 18: a missing doc must never affect the existing engine) — confidence 0 means every consumer already treats this identically to a real but unconfident result, so no separate null-handling branch is needed at call sites that already handle confidence 0. */
export const EMPTY_COLLABORATIVE_PROFILE: CollaborativeProfile = {
  categoryScores: {},
  neighborCount: 0,
  averageSimilarity: 0,
  confidence: 0,
  sourceInteractionCount: 0,
  generatedAt: 0,
  schemaVersion: 1,
};
