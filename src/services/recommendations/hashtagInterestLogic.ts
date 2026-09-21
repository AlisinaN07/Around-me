/**
 * The pure, Firestore-free half of the hashtag-interest pipeline — same
 * "no Firebase/Firestore imports at all" split profileLogic.ts already
 * established (see its own top doc comment) so tests/hashtagInterest.test.ts
 * can exercise the real scoring math directly under plain tsx.
 * hashtagInterestProfile.ts imports this file and adds the actual
 * Firestore read/write calls on top.
 */
import { normalizeHashtag } from '@/utils/hashtags';

import { HASHTAG_INTEREST_CLEANUP_THRESHOLD, HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT, HASHTAG_SCORE_MAX, HASHTAG_SCORE_MIN } from './hashtagInterestConfig';

/**
 * A bounded, diminishing-returns delta for a ONE-SIDED [0, 1] score range
 * — conceptually the same idea profileLogic.ts's own applyBoundedDelta
 * already uses for category/creator/city scores (the closer `current`
 * already is toward its ceiling/floor, the less room `weight` has left to
 * move it, asymptotically approaching but never reaching past either
 * bound), but NOT a call to that exact function: applyBoundedDelta
 * assumes a SYMMETRIC ±max range (a negative weight's "room" is measured
 * from -max), while a hashtag score's floor is a hard 0, never negative
 * (see src/types/hashtagInterest.ts's own doc comment on why). Worked
 * example: `not_interested` (weight -0.35) on an already-strong 0.7 score
 * has room = 0.7 - 0 = 0.7, so it drops to 0.7 + (-0.35 * 0.7) = 0.455 —
 * a real, meaningful hit, but not a reset to 0 (spec: "this is a
 * preference signal, not a permanent ban").
 */
export function applyBoundedHashtagScoreDelta(current: number, weight: number): number {
  if (weight === 0) return current;
  if (weight > 0) {
    const room = Math.max(0, HASHTAG_SCORE_MAX - current);
    return current + weight * room;
  }
  const room = Math.max(0, current - HASHTAG_SCORE_MIN);
  return current + weight * room;
}

function clampHashtagScore(score: number): number {
  return Math.min(HASHTAG_SCORE_MAX, Math.max(HASHTAG_SCORE_MIN, score));
}

export type HashtagInterestSnapshot = {
  score: number;
  positiveSignalCount: number;
  negativeSignalCount: number;
};

/**
 * The core update rule: `current` (or `null` for a hashtag this user has
 * no document for yet) plus one already-resolved signal `weight`,
 * producing the next snapshot to persist — or `null` when the result is
 * negligible enough to skip persisting/to delete an existing document
 * (see HASHTAG_INTEREST_CLEANUP_THRESHOLD's own doc comment). Never
 * called with `weight === 0` in practice (the caller — see
 * hashtagInterestProfile.ts's applyHashtagInterestSignals — already skips
 * any action HASHTAG_INTEREST_WEIGHTS doesn't list at all, before this is
 * ever reached), but stays correct either way: a zero weight is a true
 * no-op via applyBoundedHashtagScoreDelta above.
 *
 * `positiveSignalCount`/`negativeSignalCount` are simple lifetime tallies
 * (never decayed/bounded themselves — see HashtagInterest's own doc
 * comment) — deliberately incremented by exactly 1 per call, not by
 * `weight`'s magnitude, so this stays meaningful as "how many distinct
 * signals have been observed" regardless of any future weight retuning.
 */
export function computeNextHashtagInterest(current: HashtagInterestSnapshot | null, weight: number): HashtagInterestSnapshot | null {
  const nextScore = clampHashtagScore(applyBoundedHashtagScoreDelta(current?.score ?? 0, weight));
  if (nextScore < HASHTAG_INTEREST_CLEANUP_THRESHOLD) return null;
  return {
    score: nextScore,
    positiveSignalCount: (current?.positiveSignalCount ?? 0) + (weight > 0 ? 1 : 0),
    negativeSignalCount: (current?.negativeSignalCount ?? 0) + (weight < 0 ? 1 : 0),
  };
}

/**
 * Selects which of one piece of content's hashtags actually receive an
 * interest update for one interaction — re-normalizes each one through
 * Step 1's own normalizeHashtag (defense in depth: a Reel's stored
 * `hashtags` are already normalized at creation time, but this function
 * never assumes a caller's input is pre-validated — same "never trust,
 * always re-derive through the one canonical function" reasoning
 * HighlightedText/getActiveHashtag already follow), deduplicates, and
 * caps at HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT — the first N valid,
 * distinct hashtags in the content's own declared order, simple and
 * deterministic (spec's own "choose a simple robust approach" — capping
 * beats dividing signal weight across tags, which would make the exact
 * per-tag effect depend on how many OTHER tags happened to be on the same
 * post, a much harder number to reason about or test).
 */
export function selectHashtagsForInterestUpdate(hashtags: readonly string[]): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const raw of hashtags) {
    if (selected.length >= HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT) break;
    const normalized = normalizeHashtag(raw);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    selected.push(normalized);
  }
  return selected;
}
