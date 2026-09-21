import type { Timestamp } from 'firebase/firestore';

/**
 * users/{uid}/hashtagInterests/{hashtag} — one document per hashtag this
 * user has meaningfully engaged with, the per-user counterpart to the
 * global hashtags/{hashtagId} collection (src/types/hashtag.ts). A
 * SEPARATE SUBCOLLECTION rather than a map field on the existing
 * users/{uid}/recommendationProfile/main document (src/types/
 * recommendation.ts's RecommendationProfile, which already has
 * `categoryScores`) — that document's map fields are only ever bounded
 * because the underlying key space is small and fixed (~18 real
 * categories, a few dozen creators/cities at most); a hashtag's key space
 * is unbounded, so folding it into that one document the same way would
 * eventually make it grow without bound. `hashtagId` IS the canonical
 * lowercase `hashtag` field itself, same convention as the global
 * collection's own `hashtagId`/`name` (see src/utils/hashtags.ts's
 * normalizeHashtag) — never a capitalization-variant duplicate.
 *
 * `score` is bounded to [0, 1] — 0 meaning "no demonstrated positive
 * interest", 1 meaning "extremely strong demonstrated interest". Never
 * negative: a negative/disliked signal (e.g. `not_interested`) pulls the
 * score DOWN toward 0 rather than into negative territory (see
 * hashtagInterestLogic.ts's own doc comment for why this is a one-sided
 * range, unlike RecommendationProfile's own signed category/creator/city
 * scores) — `negativeSignalCount` is what actually records "this hashtag
 * has real negative history", kept as its own counter rather than folded
 * into a single signed number.
 *
 * THIS STEP ONLY COLLECTS AND STORES these scores — see
 * hashtagInterestProfile.ts's own top doc comment for the full read/write
 * pipeline. Nothing here is read by src/services/recommendations/
 * recommendationEngine.ts or ranking.ts yet; that integration is later
 * work. Never exposed in any UI, never shown to other users (see
 * firestore.rules' own `match /hashtagInterests/{hashtag}` — owner-read
 * only, exactly like recommendationProfile/main).
 */
export type HashtagInterest = {
  /** Canonical lowercase form — always equal to this document's own ID. */
  hashtag: string;
  /** Bounded [0, 1] — see this type's own top doc comment. */
  score: number;
  /** How many positive-weight signals have ever been applied to this hashtag for this user — a simple lifetime counter, never itself bounded/decayed (unlike `score`), kept as raw history for future diagnostics/decay-tuning (Step: prepare for future decay). */
  positiveSignalCount: number;
  /** The negative-signal counterpart to positiveSignalCount above. */
  negativeSignalCount: number;
  /** When this hashtag's score was last moved by a real signal — the temporal information a later decay step needs (see hashtagInterestLogic.ts's own doc comment); no decay is actually applied yet. */
  lastInteractionAt: Timestamp;
  updatedAt: Timestamp;
};

/** The bounded read shape getUserTopHashtagInterests returns — just enough for a future ranking step to consume, never the full document (positiveSignalCount/negativeSignalCount/lastInteractionAt are internal bookkeeping, not needed by a reader that only wants "what does this user care about"). */
export type TopHashtagInterest = {
  hashtag: string;
  score: number;
};
