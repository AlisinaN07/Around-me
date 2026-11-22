/**
 * users/{uid}/hashtagInterests/{hashtag} — the Firestore-touching half of
 * the hashtag-interest pipeline (see src/types/hashtagInterest.ts for the
 * data model, hashtagInterestLogic.ts for the pure scoring math this file
 * only adds read/write plumbing on top of).
 *
 * FULL PIPELINE:
 *   Reel (hashtags: [...])
 *     -> a real user interaction (like/save/share/comment/watch/...)
 *     -> interactions.ts's trackContentInteraction (the SAME single entry
 *        point every other recommendation signal already goes through —
 *        see that file's own doc comment) resolves the action's hashtag
 *        weight and, if relevant, calls applyHashtagInterestSignals below
 *     -> ONE Firestore transaction updates every relevant hashtag for
 *        this user at once (never one round trip per hashtag)
 *     -> users/{uid}/hashtagInterests/{hashtag} documents
 *
 * SCOPE (this step): collect, store, and read these scores safely. Never
 * read by recommendationEngine.ts/ranking.ts yet — the existing "For You"
 * ranking behaves exactly as it did before this pass. That integration is
 * later work.
 */
import { collection, doc, getDocs, limit, orderBy, query, runTransaction, serverTimestamp, type WithFieldValue } from 'firebase/firestore';

import type { RecommendationAction } from '@/types/recommendation';
import type { HashtagInterest, TopHashtagInterest } from '@/types/hashtagInterest';

import { firestore } from '../firestore';
import { HASHTAG_INTEREST_WEIGHTS, HASHTAG_TOP_INTERESTS_DEFAULT_LIMIT, HASHTAG_TOP_INTERESTS_MAX_LIMIT } from './hashtagInterestConfig';
import { computeNextHashtagInterest, selectHashtagsForInterestUpdate } from './hashtagInterestLogic';
import { runWithRetry } from './interestProfile';

const HASHTAG_INTERESTS_SUBCOLLECTION = 'hashtagInterests';

export function hashtagInterestRef(uid: string, hashtag: string) {
  return doc(firestore!, 'users', uid, HASHTAG_INTERESTS_SUBCOLLECTION, hashtag);
}

/**
 * Applies one interaction's hashtag signal to every relevant hashtag of
 * the content it happened on, for ONE user, in a SINGLE Firestore
 * transaction (spec's own "one batch update, not unrelated network round
 * trips" instruction) — reads every relevant hashtag's current document
 * first (Firestore transactions require all reads before any write),
 * then writes (or deletes — see computeNextHashtagInterest's own
 * cleanup-threshold behavior) each one, so a like on a Reel with 3
 * hashtags costs exactly one transaction, not three.
 *
 * Returns immediately, before touching Firestore at all, for an action
 * HASHTAG_INTEREST_WEIGHTS doesn't list (see that config's own doc
 * comment on why this is an allowlist, not a fallback) — e.g. `follow`/
 * `profile_open`/every `event_*` action never even attempts a read here.
 *
 * IDEMPOTENCY (spec's own "the same action must not repeatedly apply the
 * same score" requirement): this function does no deduplication of its
 * own — it inherits it entirely from its ONE caller, interactions.ts's
 * trackContentInteraction, which already: (1) skips a duplicate
 * (userId, action, contentId) within its dedupe window (reliability.ts)
 * before this is ever reached, and (2) enqueues this call through that
 * same uid's own interaction queue (reliability.ts's
 * enqueueRecommendationInteraction), so two interactions for the same
 * user never run their hashtag transactions concurrently either. A
 * genuine like -> unlike -> like sequence still nets out correctly (each
 * leg reverses/reapplies HASHTAG_INTEREST_WEIGHTS.like/.unlike in turn),
 * exactly like categoryScores already behaves for the same sequence —
 * never a way to "farm" a higher score by rapidly toggling.
 *
 * Uses the same retry policy as the category/creator/city profile update
 * (interestProfile.ts's runWithRetry) — safe for the identical reason: a
 * Firestore transaction is all-or-nothing, so retrying a failed attempt
 * can never double-apply anything.
 */
export async function applyHashtagInterestSignals(uid: string, hashtags: readonly string[], action: RecommendationAction): Promise<void> {
  if (!firestore) return;
  const weight = HASHTAG_INTEREST_WEIGHTS[action];
  if (!weight) return;

  const relevantHashtags = selectHashtagsForInterestUpdate(hashtags);
  if (relevantHashtags.length === 0) return;

  const db = firestore;
  await runWithRetry(() =>
    runTransaction(db, async (tx) => {
      const refs = relevantHashtags.map((hashtag) => hashtagInterestRef(uid, hashtag));

      // All reads before any write, sequentially (not Promise.all) — safe
      // and simple for a small (<= HASHTAG_INTEREST_MAX_TAGS_PER_CONTENT)
      // bounded list; the extra round trips this costs are negligible
      // next to one Firestore transaction's own overhead.
      const currents: (HashtagInterest | null)[] = [];
      for (const ref of refs) {
        const snapshot = await tx.get(ref);
        currents.push(snapshot.exists() ? (snapshot.data() as HashtagInterest) : null);
      }

      relevantHashtags.forEach((hashtag, index) => {
        const current = currents[index];
        const ref = refs[index];
        const next = computeNextHashtagInterest(current, weight);
        if (!next) {
          // Negligible result — delete an existing negligible/decayed
          // record rather than keep it around (spec's own low-score
          // cleanup instruction); never create a doc in the first place
          // for a hashtag whose only history so far nets out to ~0.
          if (current) tx.delete(ref);
          return;
        }
        tx.set(ref, {
          hashtag,
          score: next.score,
          positiveSignalCount: next.positiveSignalCount,
          negativeSignalCount: next.negativeSignalCount,
          lastInteractionAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } satisfies WithFieldValue<HashtagInterest>);
      });
    })
  );
}

/**
 * The bounded read path (spec's own getUserTopHashtagInterests) — a
 * single-field `orderBy('score', 'desc')` query over the caller's own
 * subcollection, which Firestore indexes automatically (no composite
 * index needed, same reasoning as every other single-field
 * document-ID/field range query in this codebase — see
 * src/services/hashtags.ts's searchHashtags). `limitCount` is clamped
 * into [1, HASHTAG_TOP_INTERESTS_MAX_LIMIT] so a caller can never turn
 * this into an unbounded read even by accident.
 */
export async function getUserTopHashtagInterests(uid: string, limitCount: number = HASHTAG_TOP_INTERESTS_DEFAULT_LIMIT): Promise<TopHashtagInterest[]> {
  if (!firestore) return [];
  const boundedLimit = Math.min(Math.max(1, limitCount), HASHTAG_TOP_INTERESTS_MAX_LIMIT);
  const snapshot = await getDocs(
    query(collection(firestore, 'users', uid, HASHTAG_INTERESTS_SUBCOLLECTION), orderBy('score', 'desc'), limit(boundedLimit))
  );
  return snapshot.docs.map((docSnapshot) => {
    const data = docSnapshot.data() as HashtagInterest;
    return { hashtag: data.hashtag, score: data.score };
  });
}
