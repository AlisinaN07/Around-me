/**
 * Every tunable number the recommendation engine uses, in one place —
 * per the spec's own Step 3/7 instruction, so the algorithm never needs
 * rewriting just to retune it. Nothing in this file talks to Firestore.
 */
import { INTERESTS } from '@/constants/interests';
import type { RecommendationAction } from '@/types/recommendation';

// ---------------------------------------------------------------------------
// Recommendation Engine — Step 6, Step 10 — ranking config versioning.
// Bump this STRING (never reinterpret an existing value's meaning —
// "never overwrite historical meaning" is the whole point) any time a
// ranking WEIGHT or FORMULA in this file or ranking.ts/qualityConfig.ts/
// collaborativeConfig.ts actually changes production behavior. Recorded
// on every ranked item's attribution (see attribution.ts) and on every
// feed session summary (see feedSessions.ts) so a later analysis can
// compare metrics across versions honestly, without conflating "the
// algorithm changed" with "user behavior changed". Untouched by this
// pass on purpose (Step 29: observe, do not change production ranking).
// ---------------------------------------------------------------------------
export const RANKING_CONFIG_VERSION = 'v1.0';

// ---------------------------------------------------------------------------
// Step 3 — signal weights. How much one interaction moves the actor's OWN
// interest/creator/city scores in interestProfile.ts. Starting values from
// the spec, adapted 1:1 (unfollow/notInterested already negative on purpose).
// ---------------------------------------------------------------------------
export const SIGNAL_WEIGHTS: Record<RecommendationAction, number> = {
  impression: 0,
  video_started: 0,
  quick_skip: -2,
  open: 1,
  watch_25: 1,
  watch_50: 2,
  watch_75: 3,
  complete: 4,
  rewatch: 5,
  like: 3,
  unlike: -3,
  save: 6,
  unsave: -6,
  share: 5,
  comment: 4,
  profile_open: 2,
  follow: 7,
  unfollow: -5,
  event_open: 3,
  event_save: 7,
  event_unsave: -7,
  event_interested: 8,
  event_going: 8,
  not_interested: -10,
};

/**
 * Second pass, Step 3 — per-DIMENSION overrides on top of SIGNAL_WEIGHTS.
 * Most actions move category/creator/city scores by the SAME weight (the
 * table above); these three need different semantics per dimension:
 *
 *  - not_interested: the CONTENT itself is fully excluded already (see
 *    excludedContentIds) — SIGNAL_WEIGHTS' -10 stays the "this exact
 *    content" signal (used nowhere as a raw score today, kept for
 *    RecommendationEvent's own historical record), while category/
 *    creator only take a MODERATE hit, not the full -10, since disliking
 *    one video doesn't mean disliking the whole category/creator equally.
 *  - unfollow: should strongly reduce CREATOR affinity specifically (a
 *    deliberate, considered action) without heavily punishing every
 *    category that creator happened to post in.
 *
 * Falls back to SIGNAL_WEIGHTS[action] for any action/dimension not
 * listed here — see resolveDimensionWeight in profileLogic.ts.
 */
export const CATEGORY_WEIGHT_OVERRIDES: Partial<Record<RecommendationAction, number>> = {
  not_interested: -4,
  unfollow: -1,
};
export const CREATOR_WEIGHT_OVERRIDES: Partial<Record<RecommendationAction, number>> = {
  not_interested: -4,
  unfollow: -8,
};
/**
 * Recommendation Engine — Step 3, Step 4 — CITY dimension overrides.
 * Before this pass, city scores moved by the exact same weight as every
 * other action (see profileLogic.ts's own history) even though the
 * spec's examples make clear a city's LEARNED LOCATION affinity should
 * respond differently than a category/creator score would to the same
 * action:
 *  - `follow`/`event_going` are "very strong positive" for city — a
 *    deliberate follow or a firm "I'm going" is one of the most decisive
 *    real-world signals that a PLACE (not just a creator/category)
 *    matters to this person, stronger than SIGNAL_WEIGHTS' own default.
 *  - `not_interested` only takes a MODERATE hit on city (disliking one
 *    video shouldn't dent an entire city's affinity nearly as hard as it
 *    dents that specific category/creator).
 *  - `unfollow` should barely move city at all — it's a creator-specific
 *    decision (see CREATOR_WEIGHT_OVERRIDES' own much larger -8), reused
 *    here at the same small magnitude as CATEGORY_WEIGHT_OVERRIDES' own
 *    unfollow entry.
 *  - `quick_skip` is only a very weak negative for city — skipping one
 *    video says very little about an entire place.
 * Every action not listed here falls back to SIGNAL_WEIGHTS[action] via
 * resolveDimensionWeight, same as category/creator.
 */
export const CITY_WEIGHT_OVERRIDES: Partial<Record<RecommendationAction, number>> = {
  quick_skip: -0.5,
  not_interested: -3,
  unfollow: -1,
  follow: 12,
  event_going: 12,
};

/**
 * Watch progress is reported ONCE per view (see RecommendationAction's own
 * doc comment) rather than as separate watch_25/50/75/complete writes —
 * deriveWatchAction (profileLogic-adjacent, see interactions.ts) picks
 * that single action from real player-reported duration/position instead
 * of relying on the UI to already know these thresholds. `isRewatch`
 * takes priority over percentage (a rewatch is a stronger signal than any
 * single-viewing milestone).
 *
 * A skip counts as "quick" from EITHER of two independent conditions
 * (Step 1's own "use both duration and watch percentage" instruction):
 * watching under QUICK_SKIP_MAX_PERCENTAGE of the video's real length, OR
 * watching under QUICK_SKIP_MIN_DURATION_MS in absolute terms regardless
 * of percentage — the second guards very short Reels, where e.g. "90% of
 * a 1.5s video" is still barely anything in absolute terms.
 */
export const QUICK_SKIP_MAX_PERCENTAGE = 0.1;
export const QUICK_SKIP_MIN_DURATION_MS = 1200;
export const WATCH_MILESTONE_THRESHOLDS: { min: number; action: RecommendationAction }[] = [
  { min: 0.95, action: 'complete' },
  { min: 0.75, action: 'watch_75' },
  { min: 0.5, action: 'watch_50' },
  { min: 0.25, action: 'watch_25' },
];

export type WatchBehaviorInput = {
  /** Real max playback position reached this viewing session, in ms — from the video player's own reported position (see ReelFeedItem.tsx), not dwell/wall-clock time. */
  watchDurationMs: number;
  /** The video's real total length in ms — prefer the player's own reported `duration`; falls back to the Reel's declared `durationMs` only when the player never reported one (e.g. playback never actually started). */
  videoDurationMs: number;
  /** True when this SAME viewing session played through the end at least twice (see ReelFeedItem.tsx's playToEnd-count tracking). */
  isRewatch: boolean;
};

/** The one robust helper for turning real playback behavior into a single recommendation action — see this const block's own doc comment for the two independent quick-skip conditions. */
export function deriveWatchAction({ watchDurationMs, videoDurationMs, isRewatch }: WatchBehaviorInput): RecommendationAction {
  if (isRewatch) return 'rewatch';
  const safeDuration = videoDurationMs > 0 ? videoDurationMs : Math.max(watchDurationMs, 1);
  const watchPercentage = Math.min(1, Math.max(0, watchDurationMs) / safeDuration);
  if (watchPercentage < QUICK_SKIP_MAX_PERCENTAGE || watchDurationMs < QUICK_SKIP_MIN_DURATION_MS) return 'quick_skip';
  for (const threshold of WATCH_MILESTONE_THRESHOLDS) {
    if (watchPercentage >= threshold.min) return threshold.action;
  }
  return 'open';
}

// ---------------------------------------------------------------------------
// Step 5 — time decay. Interest scores halve every DECAY_HALF_LIFE_DAYS
// without reinforcement, via a plain exponential — see
// interestProfile.ts's applyDecay. Cheap (one Math.pow per score per read,
// only actually run when enough wall-clock time has passed — see
// MIN_DECAY_INTERVAL_MS), no scheduled job required.
// ---------------------------------------------------------------------------
export const DECAY_HALF_LIFE_DAYS = 21;
export const MIN_DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — avoid recomputing decay on every single profile read

// ---------------------------------------------------------------------------
// Step 4 — profile document bounds. Keeps
// users/{uid}/recommendationProfile/main small and Firestore-cheap forever,
// regardless of account age (see RecommendationProfile's own doc comment).
// ---------------------------------------------------------------------------
export const MAX_TRACKED_CREATORS = 100;
export const MAX_TRACKED_CITIES = 50;
export const MAX_EXCLUDED_CONTENT_IDS = 300;
/** Second pass, Step 4 — bounds for the new recency-tracked fields (RecommendationProfile's own doc comment). Trimmed by RECENCY (oldest lastSeenAt/insertion first), not by magnitude — old exposure history should age out, unlike category/creator scores where the SMALLEST-magnitude entries are the ones worth dropping. */
export const MAX_RECENT_IMPRESSIONS = 200;
export const MAX_STRONGLY_ENGAGED_CONTENT_IDS = 200;
export const MAX_RESPONDED_EVENT_IDS = 200;

// ---------------------------------------------------------------------------
// Second pass, Step 9/10 — bounded, diminishing-returns score growth.
// Prevents any single category/creator/city score from growing without
// bound, AND makes repeated small actions (e.g. twenty `open`s) contribute
// progressively LESS as a score approaches its cap — so a pile of weak
// signals can never functionally outweigh one strong one (a `save`) the
// way plain unbounded addition would eventually let it. See
// profileLogic.ts's applyBoundedDelta.
// ---------------------------------------------------------------------------
export const CATEGORY_SCORE_MAX = 40;
export const CREATOR_SCORE_MAX = 40;
export const CITY_SCORE_MAX = 40;

// ---------------------------------------------------------------------------
// Step 7 — ranking weights. finalScore is a weighted SUM of these
// per-signal scores (each pre-normalized to a comparable range in
// ranking.ts) — addition over multiplication so one weak dimension (e.g. a
// brand new creator with zero affinity yet) never zeroes out an otherwise
// strong candidate the way multiplying by 0 would.
// ---------------------------------------------------------------------------
export const RANKING_WEIGHTS = {
  interest: 0.3,
  location: 0.2,
  time: 0.15,
  creatorAffinity: 0.1,
  freshness: 0.1,
  popularity: 0.08,
  quality: 0.07,
};

// ---------------------------------------------------------------------------
// Step 8 — location relevance. Same city scores highest, then same
// country, then worldwide — reuses this app's own BrowseScope (see
// src/types/browseScope.ts) rather than real GPS distance, which the app
// doesn't collect (Around Me is city-selection-first, not GPS-first).
// ---------------------------------------------------------------------------
export const LOCATION_SCORE = {
  sameCity: 1,
  sameCountry: 0.6,
  worldwide: 0.3,
};

// ---------------------------------------------------------------------------
// Recommendation Engine — Step 3, Steps 2/3/5/17/18 — LEARNED city/local
// affinity on top of the explicit-scope hierarchy above. See
// ranking.ts's normalizeCityAffinity/scoreLocation and
// candidateGenerator.ts's/recommendationEngine.ts's pickSecondaryCity.
//
// BrowseScope stays the strongest constraint always (Step 3's own "Do NOT
// let learned affinity override the user's explicitly selected
// BrowseScope" instruction) — every bonus below is capped so it can only
// ever narrow the gap toward a same-city score, never reach or exceed it
// (see scoreLocation's own doc comment for the exact clamp).
// ---------------------------------------------------------------------------
/** A city only counts as a meaningful "secondary" affinity once its NORMALIZED score (0-1, see normalizeCityAffinity) clears this bar — a brand new/lightly-tracked city should never influence ranking or trigger an extra candidate query off a couple of stray interactions. */
export const SECONDARY_CITY_AFFINITY_THRESHOLD = 0.35;
/** Step 3's own "1-2 learned secondary cities" cap — this implementation always picks exactly the single best-qualifying one (see pickSecondaryCity), so this constant currently just documents/bounds that choice rather than being read by a loop; kept as a named config value (not a bare literal) so raising it later is a one-line, deliberate change. */
export const MAX_LEARNED_SECONDARY_CITIES = 1;
/** Max bonus added on top of LOCATION_SCORE.worldwide/sameCountry for an item in a qualifying learned secondary city, under 'city'/'cities'/'country' scope — see scoreLocation. Kept comfortably below the gap to sameCity (1) so a strong secondary-city affinity can narrow the distance but never flip the ordering (Step 3/6's own "should not normally reverse explicit local intent"). */
export const LOCATION_SECONDARY_CITY_BONUS_MAX = 0.35;
/** Same idea as LOCATION_SECONDARY_CITY_BONUS_MAX but for 'world' scope specifically — deliberately smaller (Step 3's own "should not heavily restrict discovery" instruction): a mild nudge toward cities the viewer actually cares about, never enough to crowd out genuine worldwide exploration. */
export const LOCATION_WORLD_AFFINITY_BONUS_MAX = 0.15;
/** Step 7 — Events weight location more heavily than Reels/Posts (an event's whole value proposition is "can I actually get there"), applied as a multiplier on RANKING_WEIGHTS.location inside ranking.ts's weightedSum rather than a second, duplicated set of ranking weights (Step 7's own "do not duplicate ranking logic unnecessarily — use feed-specific configuration"). The Following feed needs no equivalent entry here at all: it is not ranked by this engine (see index.tsx's own separate fetchFollowingReels path) — a feed of accounts the viewer explicitly chose to follow has nothing for scoreLocation to weigh in the first place. */
export const EVENT_LOCATION_WEIGHT_MULTIPLIER = 1.6;
/** Step 17 — bounded supplementary candidate pool for the single qualifying learned secondary city, under 'city' scope only. Deliberately much smaller than CANDIDATE_POOL.localPoolLimit — this is a small exploration injection, never a second full-size pool. No longer used by Reel candidate generation (candidateGenerator.ts) — strict geography now means a City-scope Reel feed only ever pulls from the viewer's OWN city, never a learned secondary one; kept defined in case a future, more deliberate (e.g. clearly-labeled "also popular in X") surface wants it. */
export const SECONDARY_CITY_REEL_POOL_LIMIT = 24;
/** Step 18 — same idea for Events' discovery sections (see recommendationEngine.ts's rankEventSections) — kept small since fetchDiscoverySections itself already fans out into several window queries per call (see its own doc comment in content.ts). */
export const SECONDARY_CITY_EVENT_SECTION_LIMIT = 6;

// ---------------------------------------------------------------------------
// Step 9 — event time relevance. Score in [0,1] by how soon a still-live
// event starts; an event whose endsAt has already passed is excluded
// entirely before this is ever consulted (see ranking.ts's scoreEventTime).
// ---------------------------------------------------------------------------
export const EVENT_TIME_SCORE = {
  startingSoonHours: 6, // "tonight"-scale
  startingSoonScore: 1,
  tomorrowHours: 30,
  tomorrowScore: 0.85,
  thisWeekendDays: 7,
  thisWeekendScore: 0.65,
  laterDaysFloor: 21, // beyond this, score bottoms out rather than keeps shrinking
  laterScoreFloor: 0.2,
};

// ---------------------------------------------------------------------------
// Step 10 — freshness. Ordinary Reels/Posts decay slowly (evergreen content
// can still rank well); Events use a steeper curve since a stale-feeling
// event listing is a worse experience than a stale-feeling meme.
// ---------------------------------------------------------------------------
export const FRESHNESS_HALF_LIFE_HOURS = 72; // Reels/Posts
export const EVENT_FRESHNESS_HALF_LIFE_HOURS = 24; // Events (freshness of the POSTING, separate from scoreEventTime's own startsAt-based score)

// ---------------------------------------------------------------------------
// Step 15 — new content gets a temporary exploration boost so it isn't
// invisible for having zero engagement yet (see ranking.ts). Tapers to 0
// by NEW_CONTENT_GRACE_HOURS old.
// ---------------------------------------------------------------------------
export const NEW_CONTENT_GRACE_HOURS = 12;
export const NEW_CONTENT_BOOST = 0.25;

// ---------------------------------------------------------------------------
// Step 12 — exploration. Approximate 70/20/10 known/related/discovery mix
// (see recommendationEngine.ts's bucketing+interleave) — deliberately not
// a hard quota: recommendationEngine falls back to the next-best bucket
// when one is short on real candidates rather than padding the feed with
// nothing, which matters at Around Me's current small-per-city content
// volume.
// ---------------------------------------------------------------------------
export const EXPLORATION_BUCKET_RATIOS = { known: 0.7, related: 0.2, discovery: 0.1 };

/** How many of a user's top-scoring categories count as "known" for bucketing — everything in RELATED_CATEGORIES[knownCategory] is "related"; everything else is "discovery". */
export const KNOWN_CATEGORY_COUNT = 3;

/**
 * A configurable related-category map, reusing this app's real interest
 * IDs (src/constants/interests.ts) exactly — never a parallel/duplicated
 * category system. Deliberately hand-authored rather than derived, since
 * "which categories feel adjacent" is a product/editorial judgment, not
 * something inferrable from the current data. Symmetric is NOT required
 * (and isn't here) — e.g. 'cafes' relates to 'student_life', but that
 * doesn't have to be reciprocal.
 */
export const RELATED_CATEGORIES: Record<string, string[]> = {
  music: ['nightlife', 'parties', 'art'],
  food: ['cafes', 'shopping', 'family'],
  nightlife: ['parties', 'music', 'cafes'],
  sports: ['fitness', 'outdoors'],
  fitness: ['sports', 'outdoors'],
  gaming: ['student_life', 'networking', 'movies'],
  cars: ['outdoors', 'travel'],
  art: ['music', 'movies'],
  cafes: ['food', 'student_life'],
  student_life: ['networking', 'cafes', 'gaming'],
  pets: ['outdoors', 'family'],
  outdoors: ['sports', 'travel', 'pets'],
  movies: ['art', 'gaming'],
  networking: ['student_life', 'gaming'],
  parties: ['nightlife', 'music'],
  family: ['pets', 'food'],
  shopping: ['food', 'travel'],
  travel: ['outdoors', 'shopping', 'cars'],
};

// Defensive: every RELATED_CATEGORIES key/value must be a real catalog ID —
// enforced once here at module load (dev-time signal if the catalog ever
// changes without updating this map), never duplicating INTERESTS itself.
const VALID_INTEREST_IDS = new Set(INTERESTS.map((interest) => interest.id));
for (const [category, related] of Object.entries(RELATED_CATEGORIES)) {
  if (!VALID_INTEREST_IDS.has(category) && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn(`[recommendationConfig] RELATED_CATEGORIES key "${category}" is not a real interest ID.`);
  }
  for (const relatedId of related) {
    if (!VALID_INTEREST_IDS.has(relatedId) && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(`[recommendationConfig] RELATED_CATEGORIES["${category}"] references unknown interest ID "${relatedId}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 13 — diversity constraints, applied as a post-ranking pass (see
// diversity.ts).
// ---------------------------------------------------------------------------
export const DIVERSITY_LIMITS = {
  maxConsecutiveSameCreator: 2,
  maxConsecutiveSameCategory: 3,
  /** How far ahead diversity.ts is allowed to look in the remaining ranked queue for a valid swap-forward candidate before giving up and allowing the violation rather than getting stuck. */
  lookaheadWindow: 12,
};

// ---------------------------------------------------------------------------
// Step 6/19 — candidate pool sizing and pagination.
// ---------------------------------------------------------------------------
export const CANDIDATE_POOL = {
  /** Bounded read of the most recent published Reels/content in the active scope — the primary candidate source (covers exploitation, related, discovery, freshness, and local-popularity scoring all from ONE query pool, since a per-category query per candidate source isn't worth it at this app's current per-city content volume — see candidateGenerator.ts's own doc comment). Strict geography: never widened into a broader scope, no matter how few candidates it returns — see candidateGenerator.ts's own doc comment. */
  localPoolLimit: 180,
  /** A smaller supplementary pool from followed creators, for creator-affinity/exploitation candidates that a pure recency-ordered local pool might miss. */
  followingPoolLimit: 60,
};

export const FOR_YOU_PAGE_SIZE = 12;

/** Popularity is computed only for the final page-sized set actually being shown (see ranking.ts's own doc comment on why NOT for the whole candidate pool) — bounds it to a small, cheap, parallelized batch of count reads regardless of candidate pool size. */
export const POPULARITY_SAMPLE_SIZE = FOR_YOU_PAGE_SIZE * 2;

// ---------------------------------------------------------------------------
// Second pass, Step 4 — repeat-exposure penalty. A MULTIPLIER on the final
// score (not an additive term — see ranking.ts's scoreRepeatExposurePenalty),
// indexed by how many times this content has recently been shown to this
// viewer without them engaging with it. Never applied at all when the
// content is in the viewer's own stronglyEngagedContentIds (rewatched,
// saved, shared, or completed) — a saved favorite should be allowed to
// resurface.
// ---------------------------------------------------------------------------
export const EXPOSURE_PENALTY_BY_COUNT = [1, 1, 0.85, 0.6, 0.35];
export const EXPOSURE_PENALTY_FLOOR = 0.15; // 4+ exposures never drops below this — deprioritized heavily, never fully hidden (that's what not_interested/excludedContentIds is for)

// ---------------------------------------------------------------------------
// Second pass, Step 6 — popularity uses a Bayesian-style shrinkage toward a
// neutral prior, so a tiny sample (e.g. one like) reads as "not enough
// data yet" rather than "must be great" (see ranking.ts's scorePopularity).
// POPULARITY_PRIOR_WEIGHT is "how many engagement events we require before
// trusting the raw score outright" — the bigger this is, the more
// small-sample content gets pulled back toward POPULARITY_PRIOR_SCORE.
// ---------------------------------------------------------------------------
export const POPULARITY_PRIOR_WEIGHT = 5;
export const POPULARITY_PRIOR_SCORE = 0.5;

// ---------------------------------------------------------------------------
// Second pass, Step 5 — feed-session stability. A small, deterministic,
// per-(user, session, content) jitter added to each candidate's score —
// see ranking.ts's hashToUnitInterval and recommendationEngine.ts's own
// use of it. Small enough to only ever break ties/near-ties, never
// override a real signal gap; the SAME (uid, sessionId, contentId) always
// hashes to the SAME jitter, so re-scoring the same session's remaining
// pool for page 2 never reshuffles anything already-scored relative
// order, while a brand new session (new sessionId, e.g. app reopened)
// gets fresh jitter and therefore a naturally different ordering.
// ---------------------------------------------------------------------------
export const SESSION_JITTER_WEIGHT = 0.03;

// ---------------------------------------------------------------------------
// Second pass, Step 8 — an event the viewer already marked
// interested/going is deprioritized (not excluded) in DISCOVERY ranking,
// so it stops competing for attention against events they haven't seen
// yet, without disappearing outright (they might still want reminders,
// and the product may surface it elsewhere — e.g. a "Going" list).
// ---------------------------------------------------------------------------
export const RESPONDED_EVENT_DISCOVERY_MULTIPLIER = 0.4;

// ---------------------------------------------------------------------------
// Recommendation Engine — Step 3, Steps 13/14 — passive vs. active signal
// classification. Purely a documentation/config surface (Step 14's own
// "make this visible/configurable" instruction) plus the actual gating
// used by interactions.ts/profileLogic.ts below — SIGNAL_WEIGHTS above
// already gives active actions (like/save/follow/...) meaningfully larger
// magnitudes than passive ones (impression/quick_skip/watch milestones),
// so this doesn't duplicate that math, just names the two groups in one
// place and defensively checks the assumption holds (dev-time only, same
// pattern as this file's own RELATED_CATEGORIES sanity check below).
// ---------------------------------------------------------------------------
export const PASSIVE_SIGNAL_ACTIONS: ReadonlySet<RecommendationAction> = new Set([
  'impression',
  'video_started',
  'quick_skip',
  'open',
  'watch_25',
  'watch_50',
  'watch_75',
  'complete',
  'rewatch',
]);
export const ACTIVE_SIGNAL_ACTIONS: ReadonlySet<RecommendationAction> = new Set([
  'like',
  'unlike',
  'save',
  'unsave',
  'share',
  'comment',
  'profile_open',
  'follow',
  'unfollow',
  'event_open',
  'event_save',
  'event_unsave',
  'event_interested',
  'event_going',
  'not_interested',
]);

/**
 * Step 13 — actions that fire a `recommendationEvents` analytics log entry
 * but deliberately never touch `recommendationProfile` at all (see
 * interactions.ts's trackContentInteraction). `video_started` is the
 * spec's own literal example: "did the video actually start" is a
 * technical/QoS signal, not a preference one, and already carries weight
 * 0 everywhere in SIGNAL_WEIGHTS — skipping its profile transaction
 * entirely just removes a wasted read-modify-write with zero behavioral
 * change.
 *
 * `impression` is ALSO analytics-only as of this pass: its one real
 * profile effect (bumping `recentImpressions` for repeat-exposure
 * tracking — see VIEW_ACTIONS below) now travels inside the SAME
 * transaction as the paired watch-summary action that always follows it
 * moments later in ReelFeedItem's lifecycle (entering a Reel always
 * eventually produces exactly one quick_skip/open/watch_.../complete/
 * rewatch call on exit) — so a Reel view now costs at most ONE profile
 * transaction instead of up to three (impression + video_started +
 * watch-summary), directly answering Steps 8/10/13's "reduce unnecessary
 * profile transactions/writes" ask without losing any signal.
 */
export const ANALYTICS_ONLY_ACTIONS: ReadonlySet<RecommendationAction> = new Set(['video_started', 'impression']);

/**
 * Step 13's own "recentImpressions" repeat-exposure bookkeeping — any
 * action that represents a genuine content VIEW (not a react/opinion
 * action like `like`/`share`) counts toward it. Deliberately a superset
 * of just `'impression'` — see ANALYTICS_ONLY_ACTIONS' own doc comment on
 * why `impression` no longer runs its own transaction; whichever single
 * watch-summary action a viewing session actually produces (even
 * `quick_skip`) is what now carries the exposure-count bump instead.
 */
export const VIEW_ACTIONS: ReadonlySet<RecommendationAction> = new Set([
  'impression',
  'quick_skip',
  'open',
  'watch_25',
  'watch_50',
  'watch_75',
  'complete',
  'rewatch',
]);

for (const action of ACTIVE_SIGNAL_ACTIONS) {
  if (PASSIVE_SIGNAL_ACTIONS.has(action) && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.warn(`[recommendationConfig] "${action}" is listed as both passive and active — fix PASSIVE_SIGNAL_ACTIONS/ACTIVE_SIGNAL_ACTIONS.`);
  }
}

// ---------------------------------------------------------------------------
// Recommendation Engine — Step 3, Step 11 — short-lived, in-memory
// duplicate-interaction suppression (see reliability.ts's
// isDuplicateInteraction). An action with NO entry here is never deduped
// at all — a genuinely repeatable signal (`like`, `complete`, ...) must
// always be recordable again, even seconds apart (Step 11's own "do NOT
// suppress legitimate repeated behavior" instruction). Only actions where
// an accidental duplicate is a real, observed risk (a rerender re-running
// an effect, a double-tap, a visibility toggle) get a window, and every
// window is short enough that a genuinely repeated REAL action (the user
// leaving and deliberately reopening the same profile/event) still gets
// through well within a normal session.
// ---------------------------------------------------------------------------
export const DEDUPE_WINDOWS_MS: Partial<Record<RecommendationAction, number>> = {
  profile_open: 3000,
  event_open: 4000,
  impression: 800,
};

// ---------------------------------------------------------------------------
// Recommendation Engine — Step 3, Step 16 — short-lived, per-uid,
// in-memory profile-read cache (see profileCache.ts). Long enough to
// absorb an entire scrolling session's worth of `getForYouReels`
// pagination calls and an Events tab visit without a stale-forever risk
// (Step 16's own "do NOT introduce stale state that lasts across sessions
// indefinitely" instruction) — invalidated immediately after any real
// interaction is persisted anyway (see interactions.ts), so this
// lifetime only matters for how long a profile with NO new interactions
// stays cached, not how quickly a real change is reflected.
// ---------------------------------------------------------------------------
export const PROFILE_CACHE_LIFETIME_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Recommendation Engine — Step 3, Step 20 — bounded retry for a
// transient Firestore transaction failure (see interestProfile.ts's
// applyInteractionAndPersist). Firestore transactions are all-or-nothing,
// so re-running the whole read-modify-write on a transient error is
// always safe (never a partial double-apply) — this is NOT retried for a
// non-transient error (e.g. permission-denied), which would just fail
// the same way again. Small and bounded on purpose (Step 20's own "avoid
// infinite retry" instruction) — combined with the interaction queue
// (reliability.ts) already serializing same-uid writes, this only ever
// needs to cover genuine cross-device/cross-tab contention, not this
// client's own rapid-fire tracking.
// ---------------------------------------------------------------------------
export const INTERACTION_RETRY = { maxAttempts: 2, backoffMs: 150 };
