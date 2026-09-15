/**
 * The recommendation system's own tracking API (Step 2) — the
 * `trackContentInteraction({...})` call from the spec, adapted to this
 * app's real field names. This is the ONE place UI/service code should
 * call to record a recommendation signal; everything downstream
 * (recommendationEvents log + recommendationProfile update) happens here.
 *
 * Fire-and-forget by design — a tracking write failing (offline, rules
 * rejection, etc.) must never block or surface an error for the real user
 * action it's attached to (liking a post still succeeds even if the
 * analytics write behind it fails). Every call site wraps this in
 * `.catch(() => {})` or an equivalent no-throw pattern; see the call
 * sites in reelEngagement.ts/saved.ts/following.ts/engagement.ts.
 */
import { collection, doc, serverTimestamp, setDoc, type WithFieldValue } from 'firebase/firestore';

import type { RecommendationEvent, TrackInteractionInput } from '@/types/recommendation';

import { firestore } from '../firestore';
import { applyInteractionAndPersist } from './interestProfile';
import { invalidateInterestProfileCache } from './profileCache';
import { ANALYTICS_ONLY_ACTIONS, deriveWatchAction, SIGNAL_WEIGHTS } from './recommendationConfig';
import { enqueueRecommendationInteraction, isDuplicateInteraction } from './reliability';

function recommendationEventsCollectionRef(uid: string) {
  return collection(firestore!, 'users', uid, 'recommendationEvents');
}

/**
 * Records one recommendation signal: writes an immutable log entry AND
 * (usually — see ANALYTICS_ONLY_ACTIONS) updates the actor's own
 * aggregated interest profile in the same call. `userId` must be the
 * CALLER's own uid — this never accepts writing another user's signals
 * (Firestore rules independently enforce this too; see firestore.rules'
 * recommendationEvents/recommendationProfile rules).
 *
 * Recommendation Engine — Step 3, Steps 8-13:
 *  - Step 11 — a duplicate of the SAME (userId, action, contentId) within
 *    its configured window (see DEDUPE_WINDOWS_MS) is silently skipped
 *    entirely — no event log write, no profile mutation — rather than
 *    merely deduped at the profile layer, so a rerender/double-tap/effect
 *    remount never even shows up as a phantom analytics row.
 *  - Step 13 — an action in ANALYTICS_ONLY_ACTIONS (video_started,
 *    impression) only ever writes the log entry; its profile-mutation
 *    step is skipped outright (see that const's own doc comment for why
 *    this loses no real signal).
 *  - Steps 8/9 — the profile mutation (when it happens at all) is
 *    enqueued through this uid's own interaction queue
 *    (reliability.ts's enqueueRecommendationInteraction), serializing it
 *    against every other pending interaction for the SAME user so rapid
 *    concurrent tracking (a watch summary + a like + a follow within a
 *    second) never runs concurrent Firestore transactions against the
 *    same profile document.
 *  - Step 16 — the profile cache is invalidated right after a mutation
 *    actually lands, so the next `getForYouReels`/`getForYouEvents`/
 *    `rankEventSections` read reflects it instead of serving a stale
 *    cached profile.
 *
 * Never throws — logs a dev warning and resolves either way, so a
 * tracking failure never surfaces as a user-facing error for whatever
 * real action (like, save, follow, ...) triggered it.
 */
export async function trackContentInteraction(input: TrackInteractionInput): Promise<void> {
  if (!firestore) return;
  if (isDuplicateInteraction(input.userId, input.action, input.contentId, Date.now())) return;
  try {
    const weight = SIGNAL_WEIGHTS[input.action];
    const ref = doc(recommendationEventsCollectionRef(input.userId));
    // Recommendation Engine — Step 6, Steps 18/19 — analytics-only fields,
    // present only when the caller actually supplied a RankingAttribution/
    // feedSessionId (see TrackInteractionInput's own doc comment) — never
    // fabricated, never affecting anything ranking-related (Step 29).
    const event = {
      eventId: ref.id,
      userId: input.userId,
      contentId: input.contentId,
      contentType: input.contentType,
      action: input.action,
      categoryId: input.categoryId,
      creatorId: input.creatorId,
      cityKey: input.cityKey,
      countryCode: input.countryCode,
      weight,
      watchDurationMs: input.watchDurationMs ?? 0,
      watchPercentage: input.watchPercentage ?? 0,
      rankPosition: input.attribution?.rankPosition ?? 0,
      sourceTags: input.attribution?.sourceTags.join(',') ?? '',
      bucket: input.attribution?.bucket ?? '',
      rankingVersion: input.attribution?.rankingVersion ?? '',
      experimentVariant: input.attribution?.experimentVariant ?? '',
      feedSessionId: input.feedSessionId ?? '',
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<RecommendationEvent>;

    const profileMutation = ANALYTICS_ONLY_ACTIONS.has(input.action)
      ? Promise.resolve()
      : enqueueRecommendationInteraction(input.userId, () => applyInteractionAndPersist(input.userId, input)).then(() =>
          invalidateInterestProfileCache(input.userId)
        );

    await Promise.all([setDoc(ref, event), profileMutation]);
  } catch (error) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[recommendations] trackContentInteraction failed:', error);
    }
  }
}

/**
 * The video-watch-specific convenience wrapper (Step 1, second pass —
 * real player-position tracking) — call this ONCE when a Reel stops
 * being the active/playing item (the user swiped past it, or left the
 * screen), never on every playback tick. `watchDurationMs`/
 * `videoDurationMs` should come from the video player's own reported
 * position/duration (see ReelFeedItem.tsx), not wall-clock dwell time.
 * `isRewatch` is true when the SAME viewing session played through to
 * the end at least twice. Internally derives a single action
 * (quick_skip/open/watch_25/.../complete/rewatch — see deriveWatchAction)
 * so a full watch is one write, not four.
 */
export async function trackReelWatchSummary(
  input: Omit<TrackInteractionInput, 'action' | 'contentType' | 'watchPercentage'> & {
    watchDurationMs: number;
    videoDurationMs: number;
    isRewatch?: boolean;
  }
): Promise<void> {
  const action = deriveWatchAction({ watchDurationMs: input.watchDurationMs, videoDurationMs: input.videoDurationMs, isRewatch: !!input.isRewatch });
  const watchPercentage = input.videoDurationMs > 0 ? Math.min(1, Math.max(0, input.watchDurationMs) / input.videoDurationMs) : 0;
  await trackContentInteraction({ ...input, action, contentType: 'reel', watchPercentage });
}

/**
 * Step 1, second pass — fires once per viewing session, the FIRST time
 * real playback progress is confirmed (see ReelFeedItem.tsx's own
 * hasStartedRef guard against firing more than once per session).
 * Weight 0 everywhere (see SIGNAL_WEIGHTS) — this is a technical/quality-
 * of-service signal ("did the video actually start playing"), not itself
 * a preference signal; a video merely starting says nothing about
 * whether the viewer liked it.
 */
export async function trackVideoStarted(input: Omit<TrackInteractionInput, 'action' | 'contentType'>): Promise<void> {
  await trackContentInteraction({ ...input, action: 'video_started', contentType: 'reel' });
}
