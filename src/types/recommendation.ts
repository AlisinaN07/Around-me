/**
 * The "For You" recommendation engine's own data shapes — see
 * src/services/recommendations/ for the logic that reads/writes these.
 *
 * Two Firestore locations, both private (owner-only — see firestore.rules):
 *   - users/{uid}/recommendationEvents/{eventId} — an immutable, append-
 *     only log of every tracked interaction. Write-only from the ranking
 *     engine's own point of view today (kept for future analytics/ML —
 *     Step 24's "no ML yet" constraint applies to RANKING, not to simply
 *     keeping raw signal history around inexpensively).
 *   - users/{uid}/recommendationProfile/main — ONE bounded document per
 *     user, a derived aggregate (category/creator/city scores + excluded
 *     content) that the ranking engine actually reads. Safe to recompute
 *     or reset at any time; never the source of truth, `recommendationEvents`
 *     is.
 *
 * Reuses the app's EXISTING category IDs (src/constants/interests.ts) —
 * this file defines no parallel category system.
 */
import type { Timestamp } from 'firebase/firestore';

/**
 * Every interaction the recommendation engine understands. Watch progress
 * is deliberately NOT four separate actions fired as playback crosses each
 * threshold — see deriveWatchAction in recommendationConfig.ts: one
 * summarized action is derived from the single highest milestone reached
 * (plus 'rewatch') and tracked ONCE when a Reel stops being active, so a
 * full watch never double-counts watch_25 + watch_50 + watch_75 + complete
 * as four separate network writes.
 */
export type RecommendationAction =
  | 'impression'
  | 'video_started'
  | 'quick_skip'
  | 'open'
  | 'watch_25'
  | 'watch_50'
  | 'watch_75'
  | 'complete'
  | 'rewatch'
  | 'like'
  | 'unlike'
  | 'save'
  | 'unsave'
  | 'share'
  | 'comment'
  | 'profile_open'
  | 'follow'
  | 'unfollow'
  | 'event_open'
  | 'event_save'
  | 'event_unsave'
  | 'event_interested'
  | 'event_going'
  | 'not_interested';

/** Mirrors this app's two existing content families — reels/{reelId} (video/photo Posts) and content/{contentId} (text Posts/Activities/Events) — never a third parallel type system. */
export type RecommendationContentType = 'reel' | 'content';

/**
 * The tracking API's own input shape — conceptually the
 * `trackContentInteraction({...})` call named in the spec, adapted to this
 * codebase's actual field names (`categoryId`/`creatorId` singular,
 * matching Reel.categoryId/Content.categoryId and authorUid — every item
 * here has exactly one category and one author, never arrays of either).
 */
export type TrackInteractionInput = {
  userId: string;
  contentId: string;
  contentType: RecommendationContentType;
  action: RecommendationAction;
  categoryId: string;
  creatorId: string;
  cityKey: string;
  countryCode: string;
  watchDurationMs?: number;
  watchPercentage?: number;
  /**
   * Recommendation Engine — Step 6, Steps 18/19 — OPTIONAL analytics
   * metadata, present only when the caller actually has a RankingAttribution
   * for this exact item (i.e., it came from a real getForYouReels/
   * getForYouEvents page — see ReelFeedItem.tsx's own use of this).
   * DEVELOPMENT/analytics-only: never rendered in production UI, never
   * used by any ranking/scoring logic itself (Step 29 — this pass only
   * OBSERVES). Omitted entirely for interactions with no ranked-item
   * context at all (e.g. a Not Interested tap on an already-rendered item
   * still fires without needing to re-derive attribution just for this).
   */
  attribution?: RankingAttribution;
  /** The per-mount feed session this interaction happened within — see feedSessions.ts. Omitted for interactions with no active feed session (e.g. opening a shared deep link to one Reel outside any feed). */
  feedSessionId?: string;
};

/** users/{uid}/recommendationEvents/{eventId} — see this file's own top doc comment. */
export type RecommendationEvent = {
  eventId: string;
  userId: string;
  contentId: string;
  contentType: RecommendationContentType;
  action: RecommendationAction;
  categoryId: string;
  creatorId: string;
  cityKey: string;
  countryCode: string;
  /** The signal weight this action contributed at write time (see recommendationConfig.ts) — kept on the event itself so a later config change never rewrites the meaning of historical events. */
  weight: number;
  watchDurationMs: number;
  watchPercentage: number;
  /** Recommendation Engine — Step 6 — 0 when this interaction had no ranked-item context (see TrackInteractionInput's own doc comment); a real rank position (>=1) otherwise. Kept as a flat number (not the full attribution object) since this is what functions/src/metrics.ts actually aggregates on. */
  rankPosition: number;
  /** Comma-joined sourceTags (see attribution.ts) — a plain string, not an array, purely so this stays a simple scalar field firestore.rules can bound-check by length like every other string field here, without needing array-shape validation. Empty string when no attribution was available. */
  sourceTags: string;
  bucket: ExplorationBucket | '';
  rankingVersion: string;
  experimentVariant: string;
  feedSessionId: string;
  createdAt: Timestamp;
};

/** One entry in `recentImpressions` — see RecommendationProfile's own doc comment. */
export type RecentImpressionEntry = {
  count: number;
  /** Epoch ms of the most recent impression — the trim key when the map exceeds MAX_RECENT_IMPRESSIONS (interestProfile.ts drops the LEAST recently seen entries first, not the highest/lowest count, since exposure penalties only matter for content still fresh in the user's recent scroll history). */
  lastSeenAt: number;
};

/**
 * users/{uid}/recommendationProfile/main — the ranking engine's actual
 * read path. Bounded on purpose: `categoryScores` has at most one entry
 * per src/constants/interests.ts category (currently 18), `creatorScores`/
 * `cityScores` are trimmed to their top N by |score| (see
 * interestProfile.ts), and `excludedContentIds`/`recentImpressions`/
 * `stronglyEngagedContentIds`/`respondedEventIds` are all capped to their
 * N most recent entries — so this document's size is bounded regardless
 * of how long an account has existed. None of these are unbounded arrays
 * that grow forever.
 */
export type RecommendationProfile = {
  categoryScores: Record<string, number>;
  creatorScores: Record<string, number>;
  cityScores: Record<string, number>;
  excludedContentIds: string[];
  /** Repeat-exposure tracking (recency-bounded, not lifetime) — how many times, and how recently, each contentId has actually been shown. Used to gradually deprioritize content the viewer keeps seeing without engaging with — see ranking.ts's scoreRepeatExposurePenalty. */
  recentImpressions: Record<string, RecentImpressionEntry>;
  /** contentIds the viewer rewatched, saved, shared, or fully completed — exempts that specific content from the repeat-exposure penalty above (a saved favorite SHOULD be able to resurface). Bounded the same way as excludedContentIds. */
  stronglyEngagedContentIds: string[];
  /** Event contentIds the viewer already marked interested/going — deprioritized (not excluded) in event discovery so a "Going" event doesn't keep dominating the feed once it's already been acted on. Bounded the same way as excludedContentIds. */
  respondedEventIds: string[];
  interactionCount: number;
  updatedAt: Timestamp;
  /** Epoch ms of the last time decay was actually applied — lets applyDecay skip recomputing when it already ran recently rather than doing the (cheap but pointless) math on every single read. */
  lastDecayAt: number;
};

/** Which of the 70/20/10 buckets a candidate was classified into — see recommendationEngine.ts's own doc comment for how classification and the resulting interleave work. */
export type ExplorationBucket = 'known' | 'related' | 'discovery';

/**
 * Per-candidate score breakdown — the debugging shape from the spec's own
 * Step 18. Attached to a RankedItem only when ranking is run with
 * `debug: true` (see recommendationEngine.ts); NEVER rendered in
 * production UI.
 */
export type RankingBreakdown = {
  totalScore: number;
  interest: number;
  location: number;
  time: number;
  freshness: number;
  popularity: number;
  creatorAffinity: number;
  exploration: number;
  bucket: ExplorationBucket;
  /** Recommendation Engine — Step 5, Step 29 — dev-debug only, never rendered in production UI. The already-confidence-scaled collaborative discovery score actually applied for this item's category — see ranking.ts's scoreCollaborativeAffinity. */
  collaborativeAffinity: number;
  /** Dev-debug only — the viewer's OWN collaborative doc confidence (0 if none/ineligible), shown alongside collaborativeAffinity so a reviewer can tell "no collaborative signal" apart from "confident collaborative signal that happens to be 0 for this category". Never a neighbor identity or another user's data (Step 6/29). */
  collaborativeConfidence: number;
};

/**
 * Recommendation Engine — Step 6, Step 19 — bounded, ALWAYS-present
 * analytics metadata per ranked item — deliberately much smaller than
 * RankingBreakdown (which stays debug-only): "final score, rank position,
 * primary source reason, bucket, ranking version, experiment variant"
 * per that step's own list, nothing more. Safe to attach to every item in
 * every real page (not just when `debug: true`) since it's a handful of
 * small strings/numbers, never the full per-dimension score.
 */
export type RankingAttribution = {
  /** 1-based position within the page actually shown to the viewer. */
  rankPosition: number;
  /** See attribution.ts's own doc comment for the full tag list and derivation. */
  sourceTags: string[];
  bucket: ExplorationBucket;
  rankingVersion: string;
  /** Present only when at least one enabled experiment applied to this request — see experiments.ts. Omitted (not `'control'`) when no experiment is active, so "no experiment ran" is distinguishable from "ran and landed on control". */
  experimentVariant?: string;
};

export type RankedItem<T> = {
  item: T;
  score: number;
  bucket: ExplorationBucket;
  attribution: RankingAttribution;
  debug?: RankingBreakdown;
};
