/**
 * Recommendation Engine — Step 5 — collaborative filtering (user
 * similarity), computed ENTIRELY in this trusted backend (Step 2's own
 * "do NOT calculate similarity in the mobile/web client" instruction).
 * The client only ever reads the single, already-computed, per-user
 * output document this file writes — see
 * src/services/recommendations/collaborative.ts for that read path and
 * its ranking integration.
 *
 * ARCHITECTURE (Step 1/24) — chosen after inspecting the existing system:
 * this project has NO scheduled Functions yet (only onCall callables and,
 * as of Step 4, Firestore document triggers), a single small Firestore
 * project (around-me-6a437, europe-north2/europe-north1), and — per this
 * feature's own Step 34 cost report — a genuinely small current user
 * base. That combination makes an IN-MEMORY BATCH inside one `onSchedule`
 * Cloud Function the right MVP architecture: no new infrastructure
 * (no BigQuery, no vector DB, no dedicated service — Step 35's own
 * explicit "do not build yet" list), bounded cost, and a clean seam
 * (see runCollaborativeRefresh's own return shape) to later swap the
 * SIMILARITY COMPUTATION step out for something more scalable without
 * touching the client at all (Step 26).
 *
 * PIPELINE (Step 24):
 *   1. Load a bounded batch of recently-active `recommendationProfile/main`
 *      docs (collectionGroup query, ordered by `updatedAt` desc, capped at
 *      MAX_USERS_PER_BATCH) — see loadActiveProfiles.
 *   2. Batch-fetch each profile owner's `users/{uid}` doc for countryCode
 *      (Step 13's candidate-limiting dimension) in ONE round trip
 *      (db.getAll).
 *   3. Build a normalized category vector per eligible user (Step 3/4) —
 *      ineligible users (too little data) are simply excluded, never
 *      given a collaborative doc at all.
 *   4. Group eligible users by country (Step 13), truncating any group
 *      beyond MAX_COUNTRY_GROUP_SIZE (most-recently-active first, since
 *      step 1's ordering is preserved) — see groupByCountry.
 *   5. Within each bounded group, compare every pair (cosineSimilarity),
 *      keep each user's top-N neighbors above SIMILARITY_MIN_THRESHOLD
 *      (findTopNeighbors), compute confidence (computeConfidence), and
 *      derive collaborativeCategoryScores (computeCollaborativeCategoryScores).
 *   6. Write one trusted doc per eligible user:
 *      `users/{uid}/recommendationProfile/collaborative`.
 *
 * PRIVACY (Step 6) — the written doc NEVER contains neighbor uids, other
 * users' raw scores, or any per-neighbor breakdown — only the AGGREGATED
 * categoryScores map, a neighbor COUNT, an average similarity, and a
 * confidence. See COLLABORATIVE_DOC_FIELDS below for the complete field
 * list — nothing else is ever written.
 */
import { getFirestore, type Firestore, type Query } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';

import {
  ALREADY_STRONG_CATEGORY_THRESHOLD,
  CONFIDENCE_NEIGHBOR_REFERENCE,
  MAX_COLLABORATIVE_CATEGORIES,
  MAX_COUNTRY_GROUP_SIZE,
  MAX_NEIGHBORS,
  MAX_USERS_PER_BATCH,
  MIN_CATEGORY_DIVERSITY,
  MIN_INTERACTIONS,
  MIN_NEIGHBORS_FOR_CONFIDENCE,
  SIMILARITY_MIN_THRESHOLD,
} from './collaborativeConfig';

// Same region as every other Cloud Function in this project — duplicated
// (not imported from index.ts) for the same "zero coupling between
// sibling files" reasoning as engagementStats.ts's own REGION constant.
const REGION = 'europe-north1';

/** Mirrors src/services/recommendations/recommendationConfig.ts's own CATEGORY_SCORE_MAX (categoryScores are bounded to ±40 — see that file's own doc comment) — the normalization denominator for turning a raw category score into a 0-1 vector component. */
const CATEGORY_SCORE_MAX = 40;

// ---------------------------------------------------------------------------
// Step 3 — the collaborative user vector: category affinity only for this
// first version (Step 3's own "do NOT create a huge creator dimension
// vector if it is not scalable... first version should primarily use
// CATEGORY affinity" instruction; see Step 9 of this feature's own final
// report for why creator collaborative filtering was deliberately
// deferred, not silently forgotten).
// ---------------------------------------------------------------------------
export type CategoryVector = Record<string, number>;

/** Clamps every raw categoryScore (can be negative — an active dislike) to non-negative, then scales by CATEGORY_SCORE_MAX into a 0-1 range. A category with a non-positive score is dropped from the vector entirely (not stored as 0) — same "sparse map, not a dense array over every possible category" shape as the profile's own categoryScores. */
export function buildNormalizedVector(categoryScores: Record<string, unknown>): CategoryVector {
  const vector: CategoryVector = {};
  for (const [category, raw] of Object.entries(categoryScores)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) continue;
    vector[category] = Math.min(1, raw / CATEGORY_SCORE_MAX);
  }
  return vector;
}

/** Step 4 — minimum data requirement. Reused identically by loadActiveProfiles below and directly unit-tested (scripts/test-collaborative-logic.cjs). */
export function isEligibleForCollaborative(interactionCount: number, vector: CategoryVector): boolean {
  return interactionCount >= MIN_INTERACTIONS && Object.keys(vector).length >= MIN_CATEGORY_DIVERSITY;
}

// ---------------------------------------------------------------------------
// Step 5 — similarity. Plain cosine similarity over the UNION of both
// vectors' category keys (a category absent from one vector reads as 0
// there) — deliberately not neural embeddings (Step 5's own instruction).
// Every component is already non-negative (see buildNormalizedVector), so
// the result is always in [0, 1], never negative.
// ---------------------------------------------------------------------------
export function cosineSimilarity(a: CategoryVector, b: CategoryVector): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const key of keys) {
    const va = a[key] ?? 0;
    const vb = b[key] ?? 0;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------------------------------------------------------------------------
// Step 7 — neighbor/cohort strategy: Option A, bounded top-N neighbors
// per user, computed within an already-bounded candidate group (Step 13).
// ---------------------------------------------------------------------------
export type VectorEntry = { uid: string; vector: CategoryVector };
export type Neighbor = { uid: string; similarity: number; vector: CategoryVector };

/** O(candidates.length) per call — the OUTER O(n²) shape (calling this once per user in a group) is the intentional, documented, BOUNDED cost described in this file's own top doc comment and collaborativeConfig.ts's MAX_COUNTRY_GROUP_SIZE. */
export function findTopNeighbors(target: VectorEntry, candidates: readonly VectorEntry[]): Neighbor[] {
  const scored: Neighbor[] = [];
  for (const candidate of candidates) {
    if (candidate.uid === target.uid) continue;
    const similarity = cosineSimilarity(target.vector, candidate.vector);
    if (similarity >= SIMILARITY_MIN_THRESHOLD) {
      scored.push({ uid: candidate.uid, similarity, vector: candidate.vector });
    }
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, MAX_NEIGHBORS);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// ---------------------------------------------------------------------------
// Step 14/23 — confidence. Zero below the cohort-privacy floor
// (MIN_NEIGHBORS_FOR_CONFIDENCE); otherwise the product of "how many
// neighbors, relative to a full neighbor list" and "how similar they
// actually are on average" — both already in [0,1], so the product stays
// in [0,1] without an extra clamp (kept anyway for defensiveness against
// a future config change).
// ---------------------------------------------------------------------------
export function computeConfidence(neighbors: readonly Neighbor[]): number {
  if (neighbors.length < MIN_NEIGHBORS_FOR_CONFIDENCE) return 0;
  const averageSimilarity = neighbors.reduce((sum, n) => sum + n.similarity, 0) / neighbors.length;
  const neighborCountFactor = Math.min(1, neighbors.length / CONFIDENCE_NEIGHBOR_REFERENCE);
  return clamp01(neighborCountFactor * averageSimilarity);
}

// ---------------------------------------------------------------------------
// Step 8 — collaborative category discovery. Confidence-scaled,
// similarity-weighted average of what the neighbor cohort likes, EXCLUDING
// any category the viewer already scores at or above
// ALREADY_STRONG_CATEGORY_THRESHOLD (Step 8's own "do not duplicate
// already-strong personal interests" instruction).
// ---------------------------------------------------------------------------
export function computeCollaborativeCategoryScores(viewerVector: CategoryVector, neighbors: readonly Neighbor[], confidence: number): CategoryVector {
  if (confidence <= 0 || neighbors.length === 0) return {};
  const totalSimilarity = neighbors.reduce((sum, n) => sum + n.similarity, 0);
  if (totalSimilarity <= 0) return {};

  const candidateCategories = new Set<string>();
  for (const neighbor of neighbors) {
    for (const category of Object.keys(neighbor.vector)) candidateCategories.add(category);
  }

  const scored: [string, number][] = [];
  for (const category of candidateCategories) {
    const personalScore = viewerVector[category] ?? 0;
    if (personalScore >= ALREADY_STRONG_CATEGORY_THRESHOLD) continue;

    const neighborWeightedScore = neighbors.reduce((sum, n) => sum + n.similarity * (n.vector[category] ?? 0), 0) / totalSimilarity;
    const discoveryScore = clamp01(neighborWeightedScore * confidence);
    if (discoveryScore > 0) scored.push([category, discoveryScore]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(scored.slice(0, MAX_COLLABORATIVE_CATEGORIES));
}

// ---------------------------------------------------------------------------
// Step 13 — grouping by country, with a hard per-group truncation (Step
// 25's own scalability guardrail). Input order is preserved from the
// caller's own most-recently-active-first query, so truncation keeps the
// MOST recently active members of an oversized country group, not an
// arbitrary slice.
// ---------------------------------------------------------------------------
export type EligibleUser = { uid: string; vector: CategoryVector; countryCode: string; interactionCount: number };

export function groupByCountry(users: readonly EligibleUser[]): Map<string, EligibleUser[]> {
  const groups = new Map<string, EligibleUser[]>();
  for (const user of users) {
    const group = groups.get(user.countryCode);
    if (!group) {
      groups.set(user.countryCode, [user]);
    } else if (group.length < MAX_COUNTRY_GROUP_SIZE) {
      group.push(user);
    }
    // else: silently truncated — this group is already at its cap.
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Step 10 — the trusted output document's exact field set. Deliberately
// exhaustive/closed here (not "...and whatever else seems useful") so a
// reviewer can see at a glance that no per-neighbor or per-other-user data
// is ever included (Step 6's own privacy requirement).
// ---------------------------------------------------------------------------
export type CollaborativeProfileDoc = {
  categoryScores: CategoryVector;
  neighborCount: number;
  averageSimilarity: number;
  confidence: number;
  /** The interactionCount the SOURCE recommendationProfile had at computation time — lets a future reader detect "this result predates a lot of new behavior" without needing a separate dirty-flag field (Step 12's own "simple bounded method" — this project's current scale doesn't justify a dedicated dirty-tracking write path on the hot interaction path). */
  sourceInteractionCount: number;
  /** Epoch ms — deliberately NOT named `updatedAt`: the batch-refresh query below orders `recommendationProfile` by `updatedAt` specifically to select 'main' docs only (this doc never sets that field, so it's naturally invisible to that query — see loadActiveProfiles' own doc comment). */
  generatedAt: number;
  schemaVersion: number;
};

// ---------------------------------------------------------------------------
// Step 24 — the batch pipeline itself.
// ---------------------------------------------------------------------------

/**
 * Step 12 — "recently active" is used here as the simple, bounded proxy
 * for "dirty" (a project this size doesn't yet justify a dedicated
 * `collaborativeDirtyAt` write on the hot interaction path — see this
 * feature's own final report for exactly when that would become
 * worthwhile). Ordering by `updatedAt` desc on the `recommendationProfile`
 * collection GROUP also has a second, deliberate effect: the
 * `collaborative` doc this same pipeline writes never sets an `updatedAt`
 * field at all (see CollaborativeProfileDoc's own doc comment), so
 * Firestore's orderBy — which skips any document missing the ordered
 * field — naturally returns ONLY 'main' profile docs here, with zero
 * extra filtering code needed to exclude a collection-group query's other
 * possible doc IDs.
 */
async function loadActiveProfiles(db: Firestore): Promise<{ uid: string; categoryScores: Record<string, unknown>; interactionCount: number }[]> {
  const query: Query = db.collectionGroup('recommendationProfile').orderBy('updatedAt', 'desc').limit(MAX_USERS_PER_BATCH);
  const snapshot = await query.get();
  return snapshot.docs
    .filter((doc) => doc.ref.id === 'main' && doc.ref.parent.parent) // defensive — see this function's own doc comment on why 'collaborative' docs shouldn't appear here at all
    .map((doc) => {
      const data = doc.data();
      return {
        uid: doc.ref.parent.parent!.id,
        categoryScores: (data.categoryScores as Record<string, unknown>) ?? {},
        interactionCount: typeof data.interactionCount === 'number' ? data.interactionCount : 0,
      };
    });
}

export type CollaborativeRefreshResult = {
  profilesScanned: number;
  eligibleUsers: number;
  countryGroups: number;
  docsWritten: number;
};

/** The shared implementation both the scheduled job and the manual admin callable below invoke — see this file's own top doc comment for the full pipeline description. */
export async function runCollaborativeRefresh(db: Firestore): Promise<CollaborativeRefreshResult> {
  const profiles = await loadActiveProfiles(db);

  if (profiles.length === 0) {
    return { profilesScanned: 0, eligibleUsers: 0, countryGroups: 0, docsWritten: 0 };
  }

  // One batched round trip for every profile owner's countryCode (Step
  // 13's candidate-limiting dimension) — never one read per user.
  const userRefs = profiles.map((p) => db.doc(`users/${p.uid}`));
  const userSnaps = await db.getAll(...userRefs);
  const countryByUid = new Map<string, string | undefined>();
  userSnaps.forEach((snap, index) => {
    countryByUid.set(profiles[index].uid, snap.exists ? (snap.data()?.countryCode as string | undefined) : undefined);
  });

  const eligible: EligibleUser[] = [];
  for (const profile of profiles) {
    const countryCode = countryByUid.get(profile.uid);
    if (!countryCode) continue; // no resolvable home country — skip rather than guess
    const vector = buildNormalizedVector(profile.categoryScores);
    if (!isEligibleForCollaborative(profile.interactionCount, vector)) continue;
    eligible.push({ uid: profile.uid, vector, countryCode, interactionCount: profile.interactionCount });
  }

  const groups = groupByCountry(eligible);

  let docsWritten = 0;
  for (const group of groups.values()) {
    for (const target of group) {
      const neighbors = findTopNeighbors(target, group);
      const confidence = computeConfidence(neighbors);
      const categoryScores = computeCollaborativeCategoryScores(target.vector, neighbors, confidence);
      const averageSimilarity = neighbors.length > 0 ? neighbors.reduce((sum, n) => sum + n.similarity, 0) / neighbors.length : 0;

      const doc: CollaborativeProfileDoc = {
        categoryScores,
        neighborCount: neighbors.length,
        averageSimilarity,
        confidence,
        sourceInteractionCount: target.interactionCount,
        generatedAt: Date.now(),
        schemaVersion: 1,
      };
      await db.doc(`users/${target.uid}/recommendationProfile/collaborative`).set(doc);
      docsWritten += 1;
    }
  }

  return { profilesScanned: profiles.length, eligibleUsers: eligible.length, countryGroups: groups.size, docsWritten };
}

// ---------------------------------------------------------------------------
// Step 11 — refresh strategy: a scheduled batch, not per-swipe
// recomputation. Every 6 hours is a deliberately low frequency for an MVP
// at this project's current user volume (see this feature's own final
// report's cost estimates) — behavioral profiles simply don't shift fast
// enough to justify anything higher, and a slower cadence keeps both
// Function invocation cost and in-memory batch size predictable.
//
// SCHEDULE_REGION is deliberately different from REGION above:
// `onSchedule`'s underlying Cloud Scheduler job has its OWN, smaller list
// of supported regions than Cloud Functions v2/Cloud Run does, and
// `europe-north1` (this project's normal function region) isn't on it —
// discovered at deploy time ("Location 'europe-north1' is not a valid
// location" from the Cloud Scheduler API specifically, not Cloud
// Functions). `europe-west1` (Belgium) is the nearest Scheduler-supported
// region to this project's real europe-north1/europe-north2 footprint.
// The function's own EXECUTION still happens whichever region Cloud
// Functions actually runs it in — this only affects where the recurring
// "fire the job" trigger itself lives, not where the Firestore reads/
// writes happen (Firestore access is regionless from the Admin SDK's
// point of view either way).
// ---------------------------------------------------------------------------
const SCHEDULE_REGION = 'europe-west1';

export const refreshCollaborativeRecommendations = onSchedule(
  { region: SCHEDULE_REGION, schedule: 'every 6 hours', timeoutSeconds: 540, memory: '512MiB' },
  async () => {
    const db = getFirestore();
    const result = await runCollaborativeRefresh(db);
    logger.info('Collaborative refresh complete', result);
  }
);

// Duplicated from index.ts on purpose — see engagementStats.ts's own
// REGION constant for the same "zero coupling between sibling files"
// reasoning; requireAdmin is a 4-line function, not worth restructuring
// index.ts's existing 1800+ line module boundary to share.
function requireAdmin(request: CallableRequest): void {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError('permission-denied', 'Admin privileges required.');
  }
}

/**
 * Step 32 — backfill/initial generation. An admin-only manual trigger for
 * the EXACT SAME pipeline the schedule runs — lets an operator generate
 * collaborative results immediately (for validation, or right after this
 * feature first ships) rather than waiting up to 6 hours for the first
 * scheduled run. Never accepts any input — always operates on the same
 * bounded "recently active" batch the schedule itself would use, so it
 * can't be pointed at an arbitrary/unbounded scope.
 */
export const triggerCollaborativeRefresh = onCall({ region: REGION, timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  requireAdmin(request);
  const db = getFirestore();
  const result = await runCollaborativeRefresh(db);
  return result;
});
