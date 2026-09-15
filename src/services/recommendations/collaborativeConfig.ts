/**
 * Recommendation Engine — Step 5, Step 28 — client-side tunables for
 * consuming the trusted collaborative-filtering output (see
 * src/types/collaborative.ts and functions/src/collaborativeConfig.ts —
 * that file's own doc comment explains why a few values are intentionally
 * mirrored on both sides rather than shared via import).
 */

// ---------------------------------------------------------------------------
// Step 16 — ranking integration weight. Deliberately smaller than
// `interest` (0.3) so collaborative discovery can never outweigh a
// viewer's own strong, directly-observed preferences (Step 18's own
// "personal negative signals win" instruction, and more generally: this
// is a DISCOVERY aid, not a replacement for personal signal) — sits at
// the LOW end of the spec's own suggested 0.08-0.15 range, deliberately:
// `popularity` (RANKING_WEIGHTS.popularity + RANKING_WEIGHTS.quality =
// 0.15) already has a comparable maximum weighted contribution once
// content is genuinely excellent and well-sampled (verified numerically
// while building this feature — a near-ceiling real quality score
// contributes ~0.053, well above what a REALISTIC — not literally
// maximal, confidence=1/score=1 is a near-impossible combination in
// practice — collaborative signal contributes at this weight). Picking
// the low end of the range keeps Step 20's "quality predicts whether the
// content itself is good; collaborative affinity predicts relevance —
// keep those concepts separate" meaningfully true even under a strong
// collaborative signal, rather than letting the two dimensions compete
// on roughly equal footing.
// ---------------------------------------------------------------------------
export const COLLABORATIVE_WEIGHT = 0.08;

/** Below this confidence, the collaborative term is treated as contributing nothing at all (Step 15's own "if collaborative confidence is low, do NOT force collaborative recommendations" instruction) — a tiny nonzero confidence multiplying an already-small weight is negligible anyway, but this makes "no meaningful collaborative signal" an explicit, testable threshold rather than an emergent rounding effect. */
export const COLLABORATIVE_MIN_CONFIDENCE_TO_APPLY = 0.15;

/** Same 5-minute lifetime as the main profile cache (profileCache.ts) — short-lived, invalidated implicitly by simply re-fetching each feed session; the collaborative doc changes at most every few hours (see the backend's own refresh schedule), so this is generous, not aggressive. */
export const COLLABORATIVE_PROFILE_CACHE_LIFETIME_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Step 27 — candidate generation. NOT implemented as a dedicated
// category-scoped query this pass — see candidateGenerator.ts's own doc
// comment for exactly why (no existing `categoryId`-scoped Reels index,
// and the existing shared local pool already covers this project's
// current per-city content volume) and the concrete threshold at which
// to revisit it. No config constant lives here for that deferred path —
// re-add MAX_COLLABORATIVE_DISCOVERY_CATEGORIES_FOR_CANDIDATES (capped at
// Step 27's own "1-3") when that query is actually built, rather than
// carrying an unused value now.
// ---------------------------------------------------------------------------
