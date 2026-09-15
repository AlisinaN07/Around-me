/**
 * Step 13 — feed diversity. A pure post-ranking pass: takes an
 * already-score-sorted list and reorders it minimally so no more than
 * DIVERSITY_LIMITS.maxConsecutiveSameCreator/maxConsecutiveSameCategory
 * items in a row share the same creator/category, preferring the
 * highest-scored valid item at each position rather than a random shuffle.
 *
 * Greedy + bounded lookahead: at each position, if the next item in score
 * order would violate a limit, this looks ahead up to
 * DIVERSITY_LIMITS.lookaheadWindow items for the closest one that doesn't
 * and swaps it forward. If nothing in that window helps (a real
 * possibility with a small candidate pool), the violation is ALLOWED
 * rather than the algorithm getting stuck or dropping content — a
 * slightly-too-long same-creator run beats an infinite loop or a
 * needlessly short feed.
 */
import { DIVERSITY_LIMITS } from './recommendationConfig';

export type DiversityKeyed = { creatorId: string; categoryId: string };

export function applyDiversity<T extends DiversityKeyed>(sorted: T[]): T[] {
  const remaining = [...sorted];
  const result: T[] = [];
  let consecutiveCreator = 0;
  let consecutiveCategory = 0;
  let lastCreatorId: string | null = null;
  let lastCategoryId: string | null = null;

  while (remaining.length > 0) {
    let pickIndex = 0;
    const candidate = remaining[0];
    const creatorWouldViolate = candidate.creatorId === lastCreatorId && consecutiveCreator >= DIVERSITY_LIMITS.maxConsecutiveSameCreator;
    const categoryWouldViolate = candidate.categoryId === lastCategoryId && consecutiveCategory >= DIVERSITY_LIMITS.maxConsecutiveSameCategory;

    if (creatorWouldViolate || categoryWouldViolate) {
      const lookahead = Math.min(DIVERSITY_LIMITS.lookaheadWindow, remaining.length);
      for (let i = 1; i < lookahead; i++) {
        const alt = remaining[i];
        const altCreatorOk = !(alt.creatorId === lastCreatorId && consecutiveCreator >= DIVERSITY_LIMITS.maxConsecutiveSameCreator);
        const altCategoryOk = !(alt.categoryId === lastCategoryId && consecutiveCategory >= DIVERSITY_LIMITS.maxConsecutiveSameCategory);
        if (altCreatorOk && altCategoryOk) {
          pickIndex = i;
          break;
        }
      }
      // No valid swap found within the lookahead window — fall through and
      // allow the violation (pickIndex stays 0) rather than getting stuck.
    }

    const [picked] = remaining.splice(pickIndex, 1);
    result.push(picked);

    consecutiveCreator = picked.creatorId === lastCreatorId ? consecutiveCreator + 1 : 1;
    consecutiveCategory = picked.categoryId === lastCategoryId ? consecutiveCategory + 1 : 1;
    lastCreatorId = picked.creatorId;
    lastCategoryId = picked.categoryId;
  }

  return result;
}
