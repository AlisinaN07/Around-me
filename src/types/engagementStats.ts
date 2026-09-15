/**
 * Recommendation Engine — Step 4 — trusted, server-aggregated engagement
 * statistics. Previously (second pass, Step 7) this file was TYPES ONLY —
 * nothing read or wrote this shape, because the project had no Cloud
 * Functions deploy target at the time. That has changed: `functions/`
 * already exists (built for account-deletion/moderation/media-processing
 * callables — see functions/src/index.ts), so this pass adds real
 * Firestore TRIGGERS there (functions/src/engagementStats.ts) that
 * maintain the doc this type describes, from trusted server-observed
 * events — never from a client-writable field.
 *
 * Two locations, one shape, mirroring content/Reels themselves:
 *   `content/{contentId}/stats/engagement`
 *   `reels/{reelId}/stats/engagement`
 * Both are readable by any signed-in user who can read the parent
 * content/Reel itself, and NEVER client-writable in any way (see
 * firestore.rules' own `stats/engagement` blocks — `allow create, update,
 * delete: if false` unconditionally; only the Cloud Functions triggers,
 * via the Admin SDK, which bypasses Rules through IAM, may write here).
 *
 * TRUST LEVELS (Step 6) — not every field here is equally trustworthy,
 * because not every field is DERIVED from an equally trustworthy source:
 *   - `likes`/`comments`/`saves`: HIGH trust — derived directly from real
 *     Firestore document create/delete events on the actual Like/Comment/
 *     Saved relationships (reels|content/{id}/likes/{uid},
 *     .../comments/{commentId}, users/{uid}/saved/{savedId}) — a client
 *     cannot fabricate one of these without the underlying relationship
 *     document actually existing, and Firestore Rules already govern who
 *     may create/delete those.
 *   - `impressions`/`videoStarts`/`meaningfulViews`/`completions`/
 *     `rewatches`/`totalWatchMs`/`totalWatchPercent`/`notInterestedCount`:
 *     MEDIUM trust — derived from `recommendationEvents`, which is
 *     client-REPORTED (playback position/duration is inherently only
 *     observable client-side — there is no server-side video pipeline
 *     watching for this app's Reels). The aggregation trigger independently
 *     re-validates/re-clamps every watch value server-side (see
 *     functions/src/engagementStats.ts's validateWatchSample) rather than
 *     trusting the client's own arithmetic, but a sufficiently motivated
 *     client could still report a fabricated-but-plausible watch. This is
 *     the same trust level the client's OWN ranking already implicitly
 *     accepted before this pass (recommendationEvents was always
 *     client-written) — aggregating it server-side does not weaken that,
 *     it just makes the AGGREGATE tamper-resistant to a single client
 *     trying to inflate ONE piece of content's stats via direct writes to
 *     the stats doc itself (which is now impossible).
 *   - `shares`: LOW-MEDIUM trust — see Step 13's own decision below.
 *     `Share.share()` (src/utils/reelShare.ts) resolving without throwing
 *     means the OS share sheet was invoked and dismissed without error —
 *     on Android and web this does NOT guarantee the user actually sent
 *     the content anywhere (the platform API has no completion signal at
 *     all there); only iOS can distinguish a completed share from a
 *     cancelled one, and this codebase's shareReel() doesn't currently
 *     branch on that. This field is therefore really a SHARE-INTENT count,
 *     not a verified-share count. Rather than introduce a whole separate
 *     `shareIntent` action/field (a bigger, riskier change to
 *     RecommendationAction/firestore.rules for this pass), it keeps the
 *     schema's requested `shares` name but is weighted conservatively in
 *     the quality formula (see ranking.ts's QUALITY_RATE_WEIGHTS) to
 *     reflect this lower trust level.
 *
 * DERIVED RATES ARE NOT STORED (Step 4's own "recompute cheaply at read
 * time" guidance) — `likeRate`/`saveRate`/`shareRate`/`commentRate`/
 * `completionRate`/`notInterestedRate`/`averageWatchMs`/
 * `averageWatchPercent` are all computed from the raw fields below at
 * ranking time (see ranking.ts's scoreContentQuality) rather than stored,
 * so a config change to a denominator/threshold never requires rewriting
 * every existing stats document.
 */

/** Every counter this doc tracks is a non-negative integer (or ms/percent sum) that only ever moves via a trusted Cloud Functions trigger — see this file's own top doc comment. */
export interface ContentEngagementStats {
  /** Every `impression` recommendation event recorded for this content (Reels: ReelFeedItem's own entry effect). The broadest, weakest denominator — see QUALITY_MIN_SAMPLE_FOR_RATE's own doc comment on why rates prefer `meaningfulViews` instead where available. */
  impressions: number;
  /** Reels only — every `video_started` event (playback actually began). Always 0 for non-video content. */
  videoStarts: number;
  /** A view that cleared the "meaningful view" bar (see MEANINGFUL_VIEW config) — the preferred denominator for engagement RATES, since a raw impression can be nothing more than an accidental scroll-through. For non-video content this is currently always 0 (no watch-summary events exist for it), so rates for non-video content fall back to `impressions`. */
  meaningfulViews: number;
  /** Reels only — every watch summary whose derived action was `complete`. */
  completions: number;
  /** Reels only — every watch summary whose derived action was `rewatch` (a single viewing session that looped at least twice). */
  rewatches: number;
  /** Sum of validated `watchDurationMs` across every watch-summary sample (Reels only) — divide by `watchSampleCount` for the mean. */
  totalWatchMs: number;
  /** Sum of validated `watchPercentage` (0-1 each) across every watch-summary sample (Reels only) — divide by `watchSampleCount` for the mean. */
  totalWatchPercent: number;
  /** How many watch-summary samples fed the two sums above — the averaging denominator, and this content's own "sample size" for confidence purposes (Step 17). */
  watchSampleCount: number;
  /** HIGH trust — see this file's own top doc comment. */
  likes: number;
  comments: number;
  saves: number;
  /** LOW-MEDIUM trust (share-INTENT, not verified delivery) — see this file's own top doc comment. */
  shares: number;
  /** Every `not_interested` recommendation event for this exact content — a strong, dedicated negative signal (Step 12), never diluted by folding it into a generic dislike count. */
  notInterestedCount: number;
  /** Events only (content.type === 'event') — every `event_open` recommendation event. Always 0 for Reels/Posts/Activities. */
  eventOpens: number;
  /** Events only — every `event_interested` recommendation event. */
  eventInterested: number;
  /** Events only — every `event_going` recommendation event. */
  eventGoing: number;
  /** Server timestamp (millis) of the last trusted aggregation write. */
  updatedAtMs: number;
  /** Schema version — bumped only if this shape's fields ever change meaning, so a future migration can tell an old doc from a new one at a glance. */
  schemaVersion: number;
}

/**
 * A safe, all-zero stats doc for content that has no stats doc yet — new
 * content, or content published before this pass existed. `scoreContentQuality`
 * (ranking.ts) treats this exactly like real all-zero stats: neutral via
 * Bayesian shrinkage toward a neutral prior, never penalized for having no
 * data yet (Step 20's own "do not punish zero-data content").
 */
export const EMPTY_ENGAGEMENT_STATS: ContentEngagementStats = {
  impressions: 0,
  videoStarts: 0,
  meaningfulViews: 0,
  completions: 0,
  rewatches: 0,
  totalWatchMs: 0,
  totalWatchPercent: 0,
  watchSampleCount: 0,
  likes: 0,
  comments: 0,
  saves: 0,
  shares: 0,
  notInterestedCount: 0,
  eventOpens: 0,
  eventInterested: 0,
  eventGoing: 0,
  updatedAtMs: 0,
  schemaVersion: 1,
};
