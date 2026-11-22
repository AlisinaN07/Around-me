/**
 * Every tunable number the hashtag-interest pipeline uses, in one place —
 * same "one central config, no scattered magic numbers" convention
 * recommendationConfig.ts already established for the rest of the
 * recommendation engine. Nothing here talks to Firestore.
 */
import type { RecommendationAction } from '@/types/recommendation';

import { SIGNAL_WEIGHTS } from './recommendationConfig';

// ---------------------------------------------------------------------------
// Score range — see src/types/hashtagInterest.ts's own doc comment for why
// this is a one-sided [0, 1] range rather than RecommendationProfile's
// signed category/creator/city scores.
// ---------------------------------------------------------------------------
export const HASHTAG_SCORE_MIN = 0;
export const HASHTAG_SCORE_MAX = 1;

/**
 * Signal weights — an ALLOWLIST, not a fallback-to-SIGNAL_WEIGHTS table
 * like CATEGORY_WEIGHT_OVERRIDES/CREATOR_WEIGHT_OVERRIDES/
 * CITY_WEIGHT_OVERRIDES. That's a deliberate difference, not an
 * oversight: category/creator/city apply to nearly every action because
 * "who posted it, what category, what city" are properties of EVERY
 * piece of content. Hashtags are optional per-content topic tags, so an
 * action about the CREATOR or a EVENT response (`follow`, `unfollow`,
 * `profile_open`, `event_open`, `event_save`, `event_interested`,
 * `event_going`, ...) says nothing about topical hashtag interest at all
 * and is deliberately NOT listed here — see interactions.ts's own gate
 * ("no entry here" == "no hashtag-interest effect", not "fall back to
 * SIGNAL_WEIGHTS[action]"). `impression`/`video_started` are also
 * omitted on purpose, matching their existing ANALYTICS_ONLY_ACTIONS
 * status (weight 0 everywhere already — see recommendationConfig.ts).
 *
 * Every value here is SIGNAL_WEIGHTS[action] scaled down by roughly
 * 1/28-1/30 (rounded for readability) and applied through
 * applyBoundedHashtagScoreDelta's diminishing-returns curve rather than
 * plain addition — SIGNAL_WEIGHTS' own integers were calibrated for
 * categoryScores' much larger, symmetric CATEGORY_SCORE_MAX (±40) range;
 * scaling preserves that same already-tuned RELATIVE ordering (a `save`
 * still moves a hashtag roughly twice as much as a `like`, `not_interested`
 * is still by far the strongest single signal, a `quick_skip` is barely
 * a nudge, ...) onto hashtag interest's much smaller [0, 1] range, so one
 * single strong action (a `save`) still can't alone push a fresh hashtag
 * anywhere near 1.0 — see this feature's own spec: "One like on one
 * football post should NOT result in football = 1.0".
 *
 * The task's own illustrative signal names (`meaningful_watch`,
 * `completion`) map onto this app's ALREADY-EXISTING, more granular watch
 * taxonomy (`watch_25`/`watch_50` ≈ "meaningful watch", `watch_75`/
 * `complete` ≈ "high completion", `rewatch` stays its own strongest watch
 * signal) rather than collapsing to a new coarser boolean — reusing the
 * real signal the app already reliably derives (deriveWatchAction) is
 * more faithful than inventing a second, less precise one.
 */
export const HASHTAG_INTEREST_WEIGHTS: Partial<Record<RecommendationAction, number>> = {
  open: 0.03, // SIGNAL_WEIGHTS.open = 1 — real engagement began, weakest real positive
  quick_skip: -0.05, // SIGNAL_WEIGHTS.quick_skip = -2 — a single quick skip should barely move anything (spec's own "fast skips" instruction)
  watch_25: 0.03, // "meaningful watch" (spec) — SIGNAL_WEIGHTS.watch_25 = 1
  watch_50: 0.06, // SIGNAL_WEIGHTS.watch_50 = 2
  watch_75: 0.09, // "high completion" territory begins — SIGNAL_WEIGHTS.watch_75 = 3
  complete: 0.12, // "high completion" (spec) — SIGNAL_WEIGHTS.complete = 4
  rewatch: 0.15, // "stronger positive" (spec) — SIGNAL_WEIGHTS.rewatch = 5
  like: 0.1, // SIGNAL_WEIGHTS.like = 3
  unlike: -0.1, // exact reverse of `like` — see applyHashtagInterestSignals' own doc comment on why a like/unlike/like toggle can't inflate the score
  comment: 0.12, // "stronger positive" (spec) — SIGNAL_WEIGHTS.comment = 4
  save: 0.18, // "strong positive" (spec) — SIGNAL_WEIGHTS.save = 6, the largest ordinary positive signal
  unsave: -0.18, // exact reverse of `save`
  share: 0.15, // "strong positive" (spec) — SIGNAL_WEIGHTS.share = 5
  not_interested: -0.35, // "strong negative" (spec) — SIGNAL_WEIGHTS.not_interested = -10, by far the largest magnitude here too, but still a PREFERENCE signal (bounded-delta scaled by remaining room — see hashtagInterestLogic.ts), never an instant reset to 0
};

// Sanity check, dev-only — every action here must be a real weight from
// the shared table it was derived from (defends against a future
// RecommendationAction rename silently orphaning this derived config).
if (process.env.NODE_ENV !== 'production') {
  for (const action of Object.keys(HASHTAG_INTEREST_WEIGHTS) as RecommendationAction[]) {
    if (!(action in SIGNAL_WEIGHTS)) {
      // eslint-disable-next-line no-console
      console.warn(`[hashtagInterestConfig] HASHTAG_INTEREST_WEIGHTS references unknown action "${action}".`);
    }
  }
}

/**
 * Multi-hashtag cap (spec's own "5-8 hashtags" suggestion) — how many of
 * one piece of content's hashtags actually receive an interest update per
 * interaction, regardless of how many the content itself carries (Reels
 * already independently cap at 30 stored hashtags — see firestore.rules'
 * isValidReelCreate — this is a SEPARATE, much smaller cap on how many of
 * those feed into interest LEARNING, not a change to how many a user can
 * type). The first N valid, deduplicated hashtags in the content's own
 * declared order are used — simple and deterministic, no per-hashtag
 * weight-splitting arithmetic needed on top of it.
 */
export const HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT = 6;

/**
 * Low-score cleanup threshold (spec's own "do not keep useless documents
 * forever" instruction) — once a hashtag's computed score would fall
 * below this, its document is deleted (if it existed) rather than
 * written with a negligible value, and a brand-new hashtag whose only
 * history so far is a weak/negative signal is never given a document at
 * all. Small enough that a hashtag with any real accumulated positive
 * history survives a single moderate negative signal (see
 * applyBoundedHashtagScoreDelta's own doc comment for the worked
 * example), but small enough to actually prune noise.
 */
export const HASHTAG_INTEREST_CLEANUP_THRESHOLD = 0.02;

/**
 * getUserTopHashtagInterests' own bounds (spec's own "10, 20, 30, not
 * hundreds" instruction) — `DEFAULT` is what a caller gets with no
 * explicit limit; `MAX` is a hard ceiling this function enforces even if
 * a caller asks for more, so a future integration can never accidentally
 * turn this into an unbounded read.
 */
export const HASHTAG_TOP_INTERESTS_DEFAULT_LIMIT = 20;
export const HASHTAG_TOP_INTERESTS_MAX_LIMIT = 30;

// ---------------------------------------------------------------------------
// For You ranking integration — everything below is only ever CONSUMED by
// ranking.ts's scoreHashtagRelevance and recommendationEngine.ts's
// getForYouReels; nothing above this line changes. Kept in this same file
// (rather than a further-split hashtagRankingConfig.ts) since this is one
// small, cohesive feature area — every hashtag-interest tunable, from
// "how a signal moves a score" to "how that score is later read for
// ranking", lives in one place.
// ---------------------------------------------------------------------------

/**
 * How many of the caller's OWN top hashtag interests get loaded ONCE per
 * recommendation batch (spec's own "Top 20 interests" suggestion) — its
 * own named constant (distinct from HASHTAG_TOP_INTERESTS_DEFAULT_LIMIT
 * above, even though the value is identical today) so ranking's own call
 * site documents ITS OWN reason for the number, independent of whatever
 * getUserTopHashtagInterests' own generic default happens to be — same
 * "each cache/call site gets its own named constant even when values
 * coincide" precedent as COLLABORATIVE_PROFILE_CACHE_LIFETIME_MS
 * mirroring PROFILE_CACHE_LIFETIME_MS's value in collaborativeConfig.ts.
 */
export const HASHTAG_RANKING_INTEREST_LIMIT = 20;

/**
 * How many of a CANDIDATE Reel's matched hashtags actually contribute to
 * its relevance score (spec's own "3 strongest matched interests"
 * suggestion) — independent of HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT
 * above (that one bounds LEARNING — how many tags one interaction can
 * teach the profile; this one bounds READING — how many of a Reel's tags
 * can move its own ranking score). A Reel with many hashtags still only
 * gets credit for its top 3 highest-interest matches — see
 * HASHTAG_MATCH_DECAY for how those 3 are weighted against each other.
 */
export const HASHTAG_RANKING_MATCH_CAP = 3;

/**
 * Diminishing-returns weights applied to a candidate's matched hashtag
 * interest scores, STRONGEST match first (spec's own literal suggestion:
 * "strongest match 100% + second match 50% + third match 25%") — index 0
 * is the top match's own full weight, index 1 the second-strongest's
 * half weight, index 2 the third's quarter weight. A Reel matching MORE
 * than HASHTAG_RANKING_MATCH_CAP hashtags simply never reaches indices
 * beyond this array — see scoreHashtagRelevance's own doc comment in
 * ranking.ts. Deliberately the task's own suggested numbers, since they
 * were given concretely (unlike the interest SIGNAL weights above, which
 * explicitly asked to be derived from inspecting existing architecture
 * instead) and already produce a bounded [0,1] result once combined with
 * scoreHashtagRelevance's own final clamp.
 */
export const HASHTAG_MATCH_DECAY = [1, 0.5, 0.25];

/**
 * The final ranking weight (spec's own HASHTAG_RELEVANCE_WEIGHT) —
 * how much a candidate's [0,1] hashtag relevance score (scored the SAME
 * way as every other ranking dimension is added on top of the existing
 * weighted sum, see ranking.ts's weightedSum) moves its final combined
 * score. Chosen by direct comparison against every other weight already
 * in this pipeline:
 *   - RANKING_WEIGHTS.interest = 0.3 — the category-interest dimension
 *     hashtag relevance is conceptually closest to (both answer "what
 *     topics does this person like"), but at a much finer, per-hashtag
 *     granularity that hasn't been validated in production the way
 *     category scoring has — hashtag relevance must stay a clear
 *     FRACTION of `interest`, never comparable to it.
 *   - COLLABORATIVE_WEIGHT = 0.08 — the closest existing PRECEDENT for
 *     "a bolt-on affinity dimension, added atop the existing weighted
 *     sum, that must never let a single strong signal dominate every
 *     other dimension" (see that constant's own doc comment in
 *     collaborativeConfig.ts). Hashtag relevance sits slightly BELOW it
 *     here (0.06, not 0.08): collaborative affinity is a backend-
 *     computed, confidence-gated signal already validated against real
 *     neighbor similarity data before this pass; hashtag-interest scores
 *     are a brand-new, purely locally-accumulated signal (Step 5) with no
 *     equivalent confidence gate yet, so a slightly more conservative
 *     weight for this first ranking integration is the safer choice.
 *
 * At hashtagRelevance's own theoretical max (1.0 — several strong
 * matches), this contributes at most 0.06 to totalScore — well under a
 * single point of `interest` at even a modest raw category score (e.g.
 * scoreInterest's own sigmoid centering means a raw category score of
 * just +15 already yields 0.5 sigmoid, contributing 0.15 alone), and
 * nowhere near `location`(0.2)/`freshness`(0.1)/`popularity+quality`
 * (0.15) at any realistic value — so hashtag relevance can meaningfully
 * break a near-tie or nudge a topically-relevant Reel upward, but can
 * never by itself outrank a Reel that's clearly better on location,
 * freshness, or quality (spec's own core requirement: "more relevant",
 * never "only show this topic").
 */
export const HASHTAG_RELEVANCE_WEIGHT = 0.06;

/**
 * Same short-lived, per-uid, in-memory cache TTL as PROFILE_CACHE_LIFETIME_MS/
 * COLLABORATIVE_PROFILE_CACHE_LIFETIME_MS (recommendationConfig.ts/
 * collaborativeConfig.ts) — its own named constant for the same "each
 * cache names its own lifetime" reason HASHTAG_RANKING_INTEREST_LIMIT's
 * own doc comment explains. Long enough to absorb a whole scrolling
 * session's worth of getForYouReels pagination without re-querying the
 * same 20 interests on every page (spec's own "do not repeatedly fetch
 * during rapid pagination" instruction), short enough that a user who
 * starts heavily engaging with a new hashtag mid-session sees the feed
 * respond within a few minutes without needing a realtime listener
 * (spec's own explicitly-rejected "no realtime listeners" option) or an
 * app restart.
 */
export const HASHTAG_INTEREST_CACHE_TTL_MS = 5 * 60 * 1000;
