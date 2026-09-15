/**
 * Recommendation Engine — Step 5 — every tunable number the collaborative-
 * filtering backend job uses, in one place (same "no magic numbers
 * scattered around" convention as statsConfig.ts). Nothing here talks to
 * Firestore. `src/services/recommendations/collaborativeConfig.ts` is
 * this file's Expo-app-side counterpart — the two overlap on a few
 * eligibility thresholds (documented per-value below) since both the
 * backend (deciding who to compute for) and the client (deciding whether
 * to trust what it read) need to agree on what "enough data" means.
 */

// ---------------------------------------------------------------------------
// Step 4 — minimum data requirement. A profile below these thresholds is
// never even considered for collaborative computation — cold-start users
// keep using the existing (non-collaborative) engine untouched.
// ---------------------------------------------------------------------------
/** Mirrors the Expo app's own COLLABORATIVE_MIN_INTERACTIONS — see that file's doc comment for why this alone already covers "minimum active signals" (interactionCount already excludes passive impressions as of the second pass). */
export const MIN_INTERACTIONS = 15;
/** Mirrors the Expo app's own COLLABORATIVE_MIN_CATEGORY_DIVERSITY. */
export const MIN_CATEGORY_DIVERSITY = 3;

// ---------------------------------------------------------------------------
// Step 13 — candidate limiting. Comparisons only ever happen WITHIN one
// country's active-user group, never against the whole user base — see
// this file's own "Step 25 scalability guardrails" note below for where
// this stops being appropriate.
// ---------------------------------------------------------------------------
/** Step 24/25 — the scheduled job never loads more than this many recently-active, eligible profiles in one run, full stop — see runCollaborativeRefresh's own doc comment for the exact query this bounds. */
export const MAX_USERS_PER_BATCH = 500;
/**
 * Step 25 — within one country group, similarity is compared pairwise
 * (O(n²)) among at most this many users. At MAX_COUNTRY_GROUP_SIZE=300,
 * that's at most ~45,000 comparisons for the single largest country group
 * in one run — trivial in-memory work for a scheduled Function, and a
 * genuine, intentional bound: a country group larger than this is
 * TRUNCATED (most-recently-active first — see runCollaborativeRefresh),
 * not silently allowed to grow the comparison count further. See Step 26
 * of this feature's own final report for the concrete user-volume
 * estimate at which this in-memory O(n²) approach should be replaced
 * (an approximate-nearest-neighbor index or a dedicated pipeline).
 */
export const MAX_COUNTRY_GROUP_SIZE = 300;

// ---------------------------------------------------------------------------
// Step 5 — similarity + Step 7 neighbor/cohort strategy.
// ---------------------------------------------------------------------------
/** A pair below this cosine similarity is never even considered a "neighbor" — filters noise before Step 23's cohort-size threshold is even evaluated. */
export const SIMILARITY_MIN_THRESHOLD = 0.5;
/** Step 7 Option A — bounded top-N neighbors per user, never a full sorted list of "everyone somewhat similar". */
export const MAX_NEIGHBORS = 20;

// ---------------------------------------------------------------------------
// Step 23 — cohort privacy threshold. Below this many QUALIFYING neighbors
// (already past SIMILARITY_MIN_THRESHOLD), collaborative confidence is
// forced to exactly 0 — never a weak-but-nonzero conclusion drawn from a
// handful of people (both a privacy protection AND a statistical-noise
// protection, per Step 14/23's own reasoning).
// ---------------------------------------------------------------------------
export const MIN_NEIGHBORS_FOR_CONFIDENCE = 5;

// ---------------------------------------------------------------------------
// Step 14 — confidence formula inputs.
// ---------------------------------------------------------------------------
/** "How many neighbors until the neighbor-COUNT half of confidence saturates at 1" — MAX_NEIGHBORS itself, so a full neighbor list reads as maximally confident on this dimension. */
export const CONFIDENCE_NEIGHBOR_REFERENCE = MAX_NEIGHBORS;

// ---------------------------------------------------------------------------
// Step 8 — collaborative category discovery.
// ---------------------------------------------------------------------------
/** A category the viewer already scores at or above this (0-1 normalized) is excluded from collaborative discovery output entirely — Step 8's own "do not duplicate already-strong personal interests" instruction. Mirrors the Expo app's own copy (used client-side only for the SAME reasoning applied to secondary ranking, not recomputation). */
export const ALREADY_STRONG_CATEGORY_THRESHOLD = 0.6;
/** Step 25 — bounds the OUTPUT map size regardless of how many categories a neighbor cohort collectively touches. */
export const MAX_COLLABORATIVE_CATEGORIES = 10;

// ---------------------------------------------------------------------------
// Step 21/22 — which recommendationEvents actions build a user's
// collaborative vector. Reuses the profile's OWN categoryScores (already
// built from SIGNAL_WEIGHTS, where `impression`/`video_started` are
// weight-0 — see recommendationConfig.ts) rather than recomputing a
// separate vector from raw events, so there is exactly ONE definition of
// "how much does this account like this category" in the whole system.
// This constant exists purely to DOCUMENT that choice for anyone auditing
// what feeds the collaborative model — it is not read by any function
// below.
// ---------------------------------------------------------------------------
export const COLLABORATIVE_VECTOR_SOURCE = 'recommendationProfile.categoryScores (already active-signal-weighted, impressions excluded)';
