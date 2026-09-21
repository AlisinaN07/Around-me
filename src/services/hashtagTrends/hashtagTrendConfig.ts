/**
 * Every tunable number Trending Hashtags uses, in one place — same
 * convention as recommendationConfig.ts/hashtagInterestConfig.ts. Nothing
 * here talks to Firestore. Deliberately its OWN module (not folded into
 * hashtagInterestConfig.ts) — trending and personalized hashtag interest
 * are explicitly separate concepts (this feature's own spec, Steps 32/33:
 * neither reads nor writes the other), so keeping their config apart
 * reinforces that boundary in the code, not just in behavior.
 */

/**
 * Time windows this service understands, in ms. Only '24h' is actually
 * exposed through the UI/service default this pass (Step 5's own "the
 * first UI may only need one default window" — Around Me is about what's
 * happening NOW). Structured as a lookup object specifically so a future
 * '7d' (or '1h'/'6h') is a one-line addition here plus a new
 * TrendWindow union member — never a reason to touch the scoring/
 * aggregation logic itself, which already takes a window length as a
 * plain parameter.
 */
export const TREND_WINDOW_MS = {
  '24h': 24 * 60 * 60 * 1000,
} as const;

export type TrendWindow = keyof typeof TREND_WINDOW_MS;

export const DEFAULT_TREND_WINDOW: TrendWindow = '24h';

/**
 * Bounded candidate pool per getTrendingHashtagsForCity call — the SAME
 * "fetch a small bounded pool, rank locally" pattern this codebase
 * already uses for the hashtag page's own Top tab (reels.ts's
 * getTopPostsForHashtag) and composer/Search autocomplete ranking
 * (hashtags.ts's searchHashtagsRanked): trend SCORE is never stored in
 * Firestore (see CityHashtagTrend's own doc comment), so there's nothing
 * to `orderBy` a query on directly — this is the size of the pool pulled
 * back and scored in memory before sorting/limiting to what's actually
 * returned. Ordered by `lastActivityAt desc` at the query level so the
 * pool itself already favors recently-active hashtags before scoring even
 * starts.
 */
export const TREND_CANDIDATE_POOL_SIZE = 60;

/** getTrendingHashtagsForCity's own result bounds (spec's own "10 default, 20 max" instruction) — same "own named constant per call site, even if a value coincides elsewhere" precedent as the rest of this hashtag system. */
export const TREND_RESULT_DEFAULT_LIMIT = 10;
export const TREND_RESULT_MAX_LIMIT = 20;

/**
 * Minimum-activity floor (spec's own explicit "#randomtag with 1 post
 * should not become #1" instruction) — a candidate with fewer than this
 * many (anti-spam-adjusted — see TREND_MAX_COUNTED_POSTS_PER_CREATOR)
 * recent posts scores exactly 0 (excluded), regardless of how strong its
 * other components look. Kept LOW (not the double-digit floor a huge city
 * could afford) specifically so this stays useful for Around Me's actual
 * current launch-city scale (Step 20's own instruction) — 3 genuine,
 * distinct-enough posts is a real signal even in a small city, while 1
 * clearly isn't.
 */
export const TREND_MIN_RECENT_POSTS = 3;

/**
 * Anti-spam cap (Step 21) — within one scoring window, a single creator's
 * OWN posts count toward the SCORING input only up to this many; further
 * posts from the same creator in the same window still exist in the raw
 * stored history (nothing is discarded — see hashtagTrendLogic.ts's own
 * doc comment) but stop adding further score. Chosen low enough that
 * "#party posted 50 times by one account" reads as roughly 3 posts' worth
 * of signal, not 50, while still letting a genuinely prolific real
 * contributor (2-3 posts about the same local happening) count normally.
 */
export const TREND_MAX_COUNTED_POSTS_PER_CREATOR = 3;

/**
 * The anti-spam MULTIPLIER floor (Step 21/14) — creatorDiversityRatio
 * (uniqueCreators / effective posts, see hashtagTrendLogic.ts) scales the
 * whole score between this floor and 1.0. Never all the way to 0 even for
 * a single-creator hashtag — a genuinely early, real local moment (one
 * account, a handful of posts, before anyone else has joined in yet)
 * shouldn't be erased outright, just heavily deprioritized relative to an
 * equivalent multi-creator trend; TREND_MIN_RECENT_POSTS above already
 * guards against a literal single post/single creator "trend".
 */
export const TREND_CREATOR_DIVERSITY_FLOOR = 0.35;

/**
 * Component weights for the raw (pre-saturation) trend score — see
 * scoreHashtagTrend's own doc comment in hashtagTrendLogic.ts for the
 * full formula. `velocity` intentionally carries the most weight: Step 18
 * ("reward acceleration") and this feature's own core distinction from
 * lifetime `postCount` are both about RECENT MOMENTUM, not sheer volume —
 * a rapidly-growing small hashtag should be able to outrank a much larger
 * but stagnant one, which only happens if velocity's own component can
 * meaningfully move the total.
 */
export const TREND_SCORE_WEIGHTS = { posts: 1, engagement: 1, velocity: 1.5 };

/**
 * Short-lived, per-(city,window) in-memory cache TTL (Step 24's own
 * "2-5 minutes" suggestion) — same TtlCache building block
 * (src/utils/requestCache.ts) every other short-lived read-through cache
 * in this codebase already uses (publicProfile.ts, following.ts,
 * services/hashtags.ts's searchHashtagsRanked, ...). No realtime
 * listener, no invalidate-on-write (Step 25's own "TTL is acceptable,
 * Around Me does not require millisecond-accurate trending" instruction)
 * — a fresh Search visit within this window simply reuses the same
 * result, one bounded query serving many viewers/opens of the same city.
 */
export const TREND_CACHE_TTL_MS = 3 * 60 * 1000;
