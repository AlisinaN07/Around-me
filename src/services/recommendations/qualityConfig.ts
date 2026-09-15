/**
 * Recommendation Engine — Step 4, Step 28 — every tunable number the new
 * trusted-stats content-QUALITY system uses, in one dedicated file (kept
 * separate from recommendationConfig.ts, which was already large before
 * this — same "no magic numbers scattered around" instruction, just a
 * second file rather than one enormous one). Nothing here talks to
 * Firestore. functions/src/statsConfig.ts mirrors the few of these values
 * the aggregation trigger itself needs to independently re-validate
 * client-reported watch data — see that file's own doc comment for why
 * it's a deliberate, documented DUPLICATE rather than a cross-project
 * import (functions/ is a separate compiled Node project, not part of
 * this Expo app's own TypeScript program).
 */

// ---------------------------------------------------------------------------
// Step 5 — "meaningful view" definition. A raw impression (a Reel merely
// scrolled past) is too weak to count as real engagement on its own; a
// view only becomes "meaningful" once EITHER condition is met — the same
// duration-OR-percentage shape deriveWatchAction's own quick-skip check
// already uses, for the same reason (a high percentage of a very short
// video is still barely anything in absolute terms).
// ---------------------------------------------------------------------------
export const MEANINGFUL_VIEW_MIN_MS = 2000;
export const MEANINGFUL_VIEW_MIN_PERCENT = 0.25;

// ---------------------------------------------------------------------------
// Step 11 — server-side watch-sample validation ceiling (functions/src
// mirrors this exact value). Anything beyond this is treated as an
// impossible/corrupt sample (Step 11's own "multi-hour watch on a
// 10-second reel" example) and the whole sample is REJECTED — never
// clamped-and-kept, since a rejected sample's duration can't be trusted
// even partially.
// ---------------------------------------------------------------------------
export const MAX_PLAUSIBLE_WATCH_MS = 4 * 60 * 60 * 1000; // 4 hours

// ---------------------------------------------------------------------------
// Step 16 — Bayesian smoothing priors, one per RATE the quality formula
// uses. `priorRate` is "what we'd assume before seeing any real samples"
// (a modest, deliberately unexciting baseline — never 0, since a rate of
// exactly 0 would read as "provably bad" rather than "unknown yet");
// `priorWeight` is how many pseudo-samples of that assumption to blend
// in — see smoothedRate in ranking.ts. Larger `priorWeight` means MORE
// real samples are needed before the measured rate is trusted outright.
// ---------------------------------------------------------------------------
export const QUALITY_RATE_PRIORS = {
  like: { priorRate: 0.05, priorWeight: 8 },
  comment: { priorRate: 0.01, priorWeight: 8 },
  save: { priorRate: 0.02, priorWeight: 8 },
  // Lower priorRate/slightly lower trust — see engagementStats.ts's own
  // doc comment on `shares` being share-INTENT, not verified delivery.
  share: { priorRate: 0.01, priorWeight: 10 },
  notInterested: { priorRate: 0.02, priorWeight: 8 },
  completion: { priorRate: 0.3, priorWeight: 6 },
} as const;

// ---------------------------------------------------------------------------
// Step 15/18 — composite REEL/POST quality weights. `notInterestedPenalty`
// is SUBTRACTED (a strong negative rate should visibly pull quality down,
// not just fail to add to it) — see scoreContentQuality in ranking.ts.
// These don't need to sum to exactly 1: the composite is clamped to
// [0, 1] after summing (see scoreContentQuality), so the weights express
// RELATIVE importance, not a literal probability decomposition.
// ---------------------------------------------------------------------------
export const QUALITY_COMPONENT_WEIGHTS = {
  watch: 0.25,
  completion: 0.2,
  save: 0.2,
  share: 0.1,
  like: 0.15,
  comment: 0.1,
  notInterestedPenalty: 0.4,
} as const;

// ---------------------------------------------------------------------------
// Step 18 — completion-quality is dampened for very short videos (Step
// 18's own "avoid over-rewarding extremely short videos simply because
// completion is easy" instruction) — a video at or above this reference
// length gets full completion credit; shorter videos get a linearly
// smaller share (floored at QUALITY_SHORT_VIDEO_MIN_CREDIT, never zeroed
// — a short video that's still genuinely well-completed shouldn't be
// treated as worthless, just discounted).
// ---------------------------------------------------------------------------
export const QUALITY_SHORT_VIDEO_REFERENCE_MS = 15_000;
export const QUALITY_SHORT_VIDEO_MIN_CREDIT = 0.5;

/**
 * A plausible "typical" average watch percentage to assume before any
 * real watch samples exist — the watch-quality term's own prior, in the
 * same role QUALITY_RATE_PRIORS' `priorRate` fields play for the other
 * (smoothedRate-based) terms. Unlike those, averageWatchPercent is a
 * plain mean (totalWatchPercent / watchSampleCount), not itself computed
 * via smoothedRate, so it needs its own explicit assumed baseline for
 * ranking.ts's scoreContentQuality to build a consistent "neutral"
 * composite out of (see that function's own doc comment on why the
 * overall confidence blend targets a COMPUTED prior composite, not an
 * arbitrary constant).
 */
export const QUALITY_PRIOR_AVERAGE_WATCH_PERCENT = 0.35;

// ---------------------------------------------------------------------------
// Step 17 — overall sample-size confidence, blending the composite
// measured quality toward a NEUTRAL composite the smaller the real sample
// is (Step 17's own "5 views/90% completion should not have the same
// confidence as 5,000 views/90%" example) — the SAME two-layer shrinkage
// shape scorePopularity already used pre-Step-4, generalized here to the
// richer multi-signal composite.
//
// The neutral target itself is NOT a hardcoded constant like
// scorePopularity's own POPULARITY_PRIOR_SCORE (0.5) — that value only
// makes sense for a `sigmoid`-based score, which is centered at 0.5 by
// construction. This composite is a direct weighted SUM of rates (a very
// different, much smaller natural range — see QUALITY_COMPONENT_WEIGHTS'
// own doc comment), so ranking.ts computes its neutral target dynamically
// as "the same composite formula, evaluated with every rate at its own
// smoothedRate prior" — keeping the two shrinkage layers (Step 16's
// per-rate smoothing and this step's overall confidence) CONSISTENT with
// each other instead of blending toward an unrelated fixed point.
// `QUALITY_CONFIDENCE_K` is "how many meaningful views until confidence
// reaches 50%".
// ---------------------------------------------------------------------------
export const QUALITY_CONFIDENCE_K = 30;

// ---------------------------------------------------------------------------
// Step 19 — EVENTS use a different composite entirely: watch time is
// irrelevant (Step 19's own "unless the event has associated reel/video
// content" — not modeled yet, out of scope this pass), and the strongest
// signals are the event-specific ones instead.
//
// Events have no `impression` signal at all today (nothing tracks "this
// event was merely shown in a feed" the way ReelFeedItem does for
// Reels — only `event_open`, fired when the detail screen actually
// loads, exists). `eventOpens` is therefore both the sample-size/
// confidence basis AND the rate denominator below — there is deliberately
// no "open rate" component (it would always trivially read as ~1.0
// against itself).
// ---------------------------------------------------------------------------
export const EVENT_QUALITY_RATE_PRIORS = {
  interested: { priorRate: 0.15, priorWeight: 6 },
  going: { priorRate: 0.05, priorWeight: 6 },
  save: { priorRate: 0.05, priorWeight: 6 },
  share: { priorRate: 0.02, priorWeight: 8 },
  notInterested: { priorRate: 0.03, priorWeight: 6 },
} as const;

export const EVENT_QUALITY_COMPONENT_WEIGHTS = {
  interested: 0.3,
  going: 0.35,
  save: 0.2,
  share: 0.15,
  notInterestedPenalty: 0.4,
} as const;

/** Events reach confidence more slowly per-open than Reels reach it per-view (an event_open is a rarer, more deliberate action than a passive Reel impression) — a separate, smaller K means fewer real opens are needed before an event's numbers are trusted, relative to Reels' much higher-volume impression counts. */
export const EVENT_QUALITY_CONFIDENCE_K = 15;

// ---------------------------------------------------------------------------
// Step 14 — denominator choice. Rates prefer `meaningfulViews` (a real
// engaged look) over raw `impressions` (could be nothing but an
// accidental scroll-through) — but for content with a positive
// impression count and STILL zero meaningful views (a genuinely low-
// quality or very new item), falling back to `impressions` avoids a
// division that's technically defined (smoothedRate never divides by a
// true zero — priorWeight keeps the denominator positive) but would
// otherwise treat "no meaningful views yet" identically to "no data at
// all", which understates a real negative signal (e.g. a high
// not-interested rate against real impressions, but zero meaningful
// views because everyone quick-skipped it).
// ---------------------------------------------------------------------------
export const QUALITY_RATE_DENOMINATOR_FLOOR = 1;
