/**
 * The orchestrator (Steps 6-16 tied together) — the only module UI code
 * should import from for actually GETTING a ranked feed page. Everything
 * else in this directory is a building block this file composes:
 * candidateGenerator (pool) -> ranking (score) -> bucketing/interleave
 * (exploration) -> diversity (post-pass). Two entry points, kept
 * separate per Step 16 rather than one giant shared function:
 * `getForYouReels` (Home's Reels feed) and `getForYouEvents` (the Events
 * tab's "For You" mode) — they share the same scoring/diversity/bucketing
 * utilities but generate candidates very differently (Reels vs. the
 * existing Discovery-sections time-window queries).
 */
import { fetchDiscoverySections, type DiscoverySections } from '../content';
import { fetchMyBlockedUserIds } from '../blocks';
import { fetchReelCommentCount, fetchReelLikeCount } from '../reelEngagement';
import { fetchLikeCount as fetchContentLikeCount, fetchCommentCount as fetchContentCommentCount } from '../socialEngagement';
import { isFollowing } from '../following';
import type { BrowseScope } from '@/types/browseScope';
import type { ActivityContent, EventContent } from '@/types/content';
import type { ContentEngagementStats } from '@/types/engagementStats';
import type { Reel } from '@/types/reel';
import type { RankedItem, RecommendationProfile } from '@/types/recommendation';
import { resolveEventHashtagsForScoring } from '@/utils/eventHashtagsForScoring';

import { bucketAndSort, classifyBucket, type BucketableEntry } from './bucketing';
import { deriveSourceTags } from './attribution';
import { getCachedCollaborativeProfile } from './collaborative';
import { applyDiversity } from './diversity';
import { generateReelCandidates, type ReelCandidateCursor } from './candidateGenerator';
import { fetchEngagementStatsBatch } from './engagementStats';
import { getCachedHashtagInterestMap } from './hashtagInterestCache';
import { getCachedInterestProfile } from './profileCache';
import { FOR_YOU_PAGE_SIZE, RANKING_CONFIG_VERSION, SECONDARY_CITY_EVENT_SECTION_LIMIT, SESSION_JITTER_WEIGHT } from './recommendationConfig';
import { computeItemScore, hashToUnitInterval, normalizeCityAffinity, pickSecondaryCity, scoreExploration, type ScoreResult } from './ranking';

/**
 * Recommendation Engine — Step 4, Step 22/23 — resolves the popularity/
 * quality inputs for a bounded set of ids with the LEAST possible cost:
 * one parallel batch of stats-doc reads (Step 22 — replacing the old "2
 * getCountFromServer calls per item"), falling back to the pre-Step-4
 * live-count reads ONLY for ids that don't have a stats doc yet (Step
 * 23's graceful migration — new/pre-this-pass content). An id present in
 * the returned `stats` map never also appears in a fallback read; the two
 * are mutually exclusive per id, so no content is ever read twice.
 */
async function resolvePopularityInputs(
  kind: 'reel' | 'content',
  ids: string[],
  fetchLikeCount: (id: string) => Promise<number>,
  fetchCommentCount: (id: string) => Promise<number>
): Promise<{ stats: Map<string, ContentEngagementStats>; fallbackCounts: Map<string, { likeCount: number; commentCount: number }> }> {
  const statsById = await fetchEngagementStatsBatch(kind, ids);
  const stats = new Map<string, ContentEngagementStats>();
  const missingIds: string[] = [];
  for (const id of ids) {
    const entry = statsById.get(id);
    if (entry) stats.set(id, entry);
    else missingIds.push(id);
  }
  const fallbackCounts = new Map<string, { likeCount: number; commentCount: number }>();
  if (missingIds.length > 0) {
    const counts = await Promise.all(missingIds.map((id) => Promise.all([fetchLikeCount(id), fetchCommentCount(id)])));
    missingIds.forEach((id, index) => fallbackCounts.set(id, { likeCount: counts[index][0], commentCount: counts[index][1] }));
  }
  return { stats, fallbackCounts };
}

type ScoredEntry<T> = BucketableEntry<T> & { breakdown: ScoreResult['breakdown'] };

/**
 * Second pass, Step 5 — feed-session stability. A small, deterministic
 * jitter keyed by (uid, sessionSeed, contentId) so re-scoring the SAME
 * session's remaining candidate pool for page 2 never reshuffles anything
 * already seen, while a brand new session (e.g. the app reopened, a fresh
 * `sessionSeed`) gets different jitter and therefore a naturally
 * different ordering — see SESSION_JITTER_WEIGHT's own doc comment for
 * why this can never override a real signal gap, only break ties/near-
 * ties. `sessionSeed` is optional and defaults to a fixed constant so
 * every existing call site (and every test) keeps working unchanged;
 * only Home/Events actually pass a real per-mount seed (see index.tsx/
 * events.tsx).
 */
function applySessionJitter(score: number, uid: string, sessionSeed: string, contentId: string): number {
  return score + SESSION_JITTER_WEIGHT * (hashToUnitInterval(`${uid}:${sessionSeed}:${contentId}`) - 0.5);
}

/** Second pass, Step 4 — the exposure-penalty context for one content ID, read from the already-fetched profile (no extra Firestore reads). */
function exposureContextFor(profile: RecommendationProfile, contentId: string) {
  return {
    impressionCount: profile.recentImpressions[contentId]?.count ?? 0,
    hasStrongEngagement: profile.stronglyEngagedContentIds.includes(contentId),
  };
}

// ---------------------------------------------------------------------------
// Reels — Home's "For You".
// ---------------------------------------------------------------------------

export type GetForYouReelsInput = {
  uid: string;
  scope: BrowseScope;
  homeCityKey: string;
  homeCountryCode: string;
  /** Every reelId already shown this session (this screen's own state — see recommendationEngine.ts's own doc comment on why this alone is enough for Step 19's pagination, no seed/cursor needed). */
  excludeReelIds: ReadonlySet<string>;
  /** The signed-in user's onboarding interests (`users/{uid}.interests`) — Step 14 cold start, see classifyBucket's own doc comment. Ignored once the profile has real behavioral signal. */
  onboardingInterestIds?: readonly string[];
  /** Second pass, Step 5 — one value per app-open/feed session (generate ONCE per Home mount, reuse for every page within it — see applySessionJitter's own doc comment). Optional so existing callers/tests keep working; omitting it just means every session hashes identically. */
  sessionSeed?: string;
  pageSize?: number;
  /** Attaches RankingBreakdown to each result — dev/debug only, see Step 18. Never true in production UI code. */
  debug?: boolean;
  /**
   * Perf pass — whatever `cursor` the PREVIOUS getForYouReels call for
   * this same session returned (`undefined` on the first page). Opaque
   * to the caller — the UI never needs to understand Firestore cursors,
   * just hold this in state/a ref and pass it straight back on the next
   * `loadMore`. Automatically restarted (that scope's own pool begins
   * fresh, from page one) the moment `scope` no longer matches what the
   * cursor was generated for — see candidateGenerator.ts's own
   * generateReelCandidates doc comment — so the caller doesn't need its
   * own scope-change detection either. `excludeReelIds` remains the
   * caller's OWN safety-net dedupe on top of this cursor, not a
   * replacement for it.
   */
  cursor?: ReelCandidateCursor;
};

export type ForYouReelsPage = {
  reels: RankedItem<Reel>[];
  /** Perf pass — pass this back as `cursor` on the NEXT getForYouReels call for this same session to continue paging through the active scope's own local pool via a real Firestore cursor, instead of re-fetching the same bounded top-N query from the start every page. */
  cursor: ReelCandidateCursor;
  /** Recommendation Engine — Step 6, Step 21 — coarse phase timings for THIS call, in ms. Cheap (a handful of Date.now() calls, no extra I/O) and always populated — "we need to know if intelligence makes the feed slow" without needing a separate profiling pass. DEVELOPMENT/observability only; never affects ranking (Step 29). */
  latencyMs: { profileAndCollaborativeRead: number; candidateGeneration: number; scoringAndDiversity: number; statsRead: number; total: number };
};

export async function getForYouReels(input: GetForYouReelsInput): Promise<ForYouReelsPage> {
  const pageSize = input.pageSize ?? FOR_YOU_PAGE_SIZE;
  const sessionSeed = input.sessionSeed ?? 'default';
  const nowMs = Date.now();
  const startedAt = Date.now();

  // Recommendation Engine — Step 3, Step 17 — candidate generation needs
  // to know the viewer's learned city affinity BEFORE it can decide
  // whether to add a secondary-city enrichment query, so the profile is
  // fetched first rather than in parallel with it (as it was pre-Step 3).
  // In practice this is usually a cache hit (see profileCache.ts/Step 16)
  // — near-zero added latency for every page after the first in a
  // session, and for a repeat session within PROFILE_CACHE_LIFETIME_MS.
  const profile = await getCachedInterestProfile(input.uid, input.onboardingInterestIds);
  const normalizedCityAffinity = normalizeCityAffinity(profile.cityScores);
  // Recommendation Engine — Step 5 — the collaborative doc has no
  // candidate-generation dependency (unlike the profile above), so it's
  // fetched in parallel with candidate generation rather than blocking it.
  const afterProfileAt = Date.now();
  // For You ranking integration — the caller's own top hashtag interests,
  // loaded ONCE per batch (see hashtagInterestCache.ts) alongside the
  // collaborative profile — neither has a candidate-generation dependency
  // (unlike `profile` above), so both fetch in parallel with it. Reused
  // as-is for every candidate scored below; never refetched per page
  // within this cache's TTL, never refetched per candidate at all.
  const [candidatePool, collaborativeProfile, hashtagInterests] = await Promise.all([
    generateReelCandidates(input.uid, input.scope, input.homeCountryCode, input.excludeReelIds, normalizedCityAffinity, input.cursor),
    getCachedCollaborativeProfile(input.uid),
    getCachedHashtagInterestMap(input.uid),
  ]);
  const afterCandidatesAt = Date.now();

  const excluded = new Set(profile.excludedContentIds);
  const eligible = candidatePool.candidates.filter((reel) => !excluded.has(reel.reelId));
  if (eligible.length === 0) {
    return {
      reels: [],
      cursor: candidatePool.cursor,
      latencyMs: {
        profileAndCollaborativeRead: afterProfileAt - startedAt,
        candidateGeneration: afterCandidatesAt - afterProfileAt,
        scoringAndDiversity: 0,
        statsRead: 0,
        total: Date.now() - startedAt,
      },
    };
  }

  const distinctAuthorUids = [...new Set(eligible.map((reel) => reel.authorUid))];
  const followingFlags = await Promise.all(distinctAuthorUids.map((authorUid) => isFollowing(input.uid, authorUid)));
  const followingSet = new Set(distinctAuthorUids.filter((_, index) => followingFlags[index]));

  const scored: ScoredEntry<Reel>[] = eligible.map((reel) => {
    const publishedAtMs = reel.publishedAt?.toMillis() ?? reel.createdAt.toMillis();
    const result = computeItemScore(
      {
        categoryId: reel.categoryId,
        creatorId: reel.authorUid,
        cityKey: reel.cityKey,
        countryCode: reel.countryCode,
        publishedAtMs,
        isFollowingCreator: followingSet.has(reel.authorUid),
        likeCount: 0,
        commentCount: 0,
        collaborativeProfile,
        exposure: exposureContextFor(profile, reel.reelId),
        reelHashtags: reel.hashtags,
        hashtagInterests,
      },
      profile,
      input.scope,
      input.homeCityKey,
      input.homeCountryCode,
      nowMs
    );
    return { item: reel, score: result.totalScore, bucket: classifyBucket(reel.categoryId, profile), breakdown: result.breakdown, creatorId: reel.authorUid, categoryId: reel.categoryId };
  });

  const interleaved = bucketAndSort(scored, pageSize);
  const afterScoringAt = Date.now();

  // Recommendation Engine — Step 4, Step 22 — trusted stats (one read per
  // item), computed only for the page actually being shown (same "not for
  // the whole pool" reasoning as the pre-Step-4 popularity counts this
  // replaces — see ranking.ts's own doc comment), falling back to the old
  // 2-count-read path only for a Reel with no stats doc yet.
  const { stats: statsByReelId, fallbackCounts } = await resolvePopularityInputs(
    'reel',
    interleaved.map((entry) => entry.item.reelId),
    fetchReelLikeCount,
    fetchReelCommentCount
  );
  const afterStatsAt = Date.now();
  const refined = interleaved.map((entry, index) => {
    const engagementStats = statsByReelId.get(entry.item.reelId) ?? null;
    const fallback = fallbackCounts.get(entry.item.reelId);
    const publishedAtMs = entry.item.publishedAt?.toMillis() ?? entry.item.createdAt.toMillis();
    const result = computeItemScore(
      {
        categoryId: entry.categoryId,
        creatorId: entry.creatorId,
        cityKey: entry.item.cityKey,
        countryCode: entry.item.countryCode,
        publishedAtMs,
        isFollowingCreator: followingSet.has(entry.creatorId),
        likeCount: fallback?.likeCount ?? 0,
        commentCount: fallback?.commentCount ?? 0,
        engagementStats,
        hasVideo: entry.item.mediaType !== 'photo',
        videoDurationMs: entry.item.durationMs,
        collaborativeProfile,
        exposure: exposureContextFor(profile, entry.item.reelId),
        reelHashtags: entry.item.hashtags,
        hashtagInterests,
      },
      profile,
      input.scope,
      input.homeCityKey,
      input.homeCountryCode,
      nowMs
    );
    const jitteredScore = applySessionJitter(result.totalScore, input.uid, sessionSeed, entry.item.reelId);
    return { ...entry, score: jitteredScore, breakdown: result.breakdown };
  });

  const diversified = applyDiversity(refined);

  const page = diversified.slice(0, pageSize).map(
    (entry, index): RankedItem<Reel> => ({
      item: entry.item,
      score: entry.score,
      bucket: entry.bucket,
      attribution: {
        rankPosition: index + 1,
        sourceTags: deriveSourceTags(entry.breakdown, entry.bucket, followingSet.has(entry.creatorId)),
        bucket: entry.bucket,
        rankingVersion: RANKING_CONFIG_VERSION,
      },
      debug: input.debug
        ? {
            totalScore: entry.score,
            ...entry.breakdown,
            exploration: scoreExploration(entry.categoryId, profile),
            bucket: entry.bucket,
            collaborativeConfidence: collaborativeProfile.confidence,
          }
        : undefined,
    })
  );

  return {
    reels: page,
    cursor: candidatePool.cursor,
    latencyMs: {
      profileAndCollaborativeRead: afterProfileAt - startedAt,
      candidateGeneration: afterCandidatesAt - afterProfileAt,
      scoringAndDiversity: afterScoringAt - afterCandidatesAt,
      statsRead: afterStatsAt - afterScoringAt,
      total: Date.now() - startedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Events — the Events tab's "For You" mode (Step 16's own separate,
// event-time-weighted ranking).
// ---------------------------------------------------------------------------

type RankableEvent = ActivityContent | EventContent;

export type GetForYouEventsInput = {
  uid: string;
  scope: BrowseScope;
  homeCityKey: string;
  homeCountryCode: string;
  excludeContentIds: ReadonlySet<string>;
  /** See GetForYouReelsInput's own doc comment on this same field — Step 14 cold start. */
  onboardingInterestIds?: readonly string[];
  /** See GetForYouReelsInput's own doc comment on this same field — Step 5 feed-session stability. */
  sessionSeed?: string;
  pageSize?: number;
  debug?: boolean;
};

export type ForYouEventsPage = {
  events: RankedItem<RankableEvent>[];
};

/**
 * Reuses fetchDiscoverySections' EXISTING three time-window queries
 * (happening now / today-or-tonight / upcoming) as the candidate pool —
 * every item in it is already guaranteed startsAt-relevant and not yet
 * ended, so no separate "exclude ended events" step is needed here (Step
 * 9's own exclusion rule is already enforced by that pool's own query
 * shape). Nothing here fetches ADDITIONAL Firestore query pages just for
 * ranking purposes — only the same bounded pool the Events tab's "For
 * You" mode already fetched.
 */
export async function getForYouEvents(input: GetForYouEventsInput): Promise<ForYouEventsPage> {
  const pageSize = input.pageSize ?? FOR_YOU_PAGE_SIZE;
  const sessionSeed = input.sessionSeed ?? 'default';
  const nowMs = Date.now();

  const [profile, collaborativeProfile, sections, blockedUids] = await Promise.all([
    getCachedInterestProfile(input.uid, input.onboardingInterestIds),
    getCachedCollaborativeProfile(input.uid),
    fetchDiscoverySections(input.scope),
    fetchMyBlockedUserIds(input.uid),
  ]);

  const blocked = new Set(blockedUids);
  const excluded = new Set(profile.excludedContentIds);
  const pool = dedupeEvents(sections).filter(
    (event) => !blocked.has(event.authorUid) && !excluded.has(event.contentId) && !input.excludeContentIds.has(event.contentId)
  );
  if (pool.length === 0) return { events: [] };

  const distinctAuthorUids = [...new Set(pool.map((event) => event.authorUid))];
  const followingFlags = await Promise.all(distinctAuthorUids.map((authorUid) => isFollowing(input.uid, authorUid)));
  const followingSet = new Set(distinctAuthorUids.filter((_, index) => followingFlags[index]));

  const scored: ScoredEntry<RankableEvent>[] = [];
  for (const event of pool) {
    const result = computeItemScore(
      {
        categoryId: event.categoryId,
        creatorId: event.authorUid,
        cityKey: event.cityKey,
        countryCode: event.countryCode,
        publishedAtMs: event.createdAt.toMillis(),
        isFollowingCreator: followingSet.has(event.authorUid),
        likeCount: 0,
        commentCount: 0,
        collaborativeProfile,
        event: { startsAtMs: event.startsAt.toMillis(), endsAtMs: event.endsAt.toMillis() },
        hasRespondedToEvent: profile.respondedEventIds.includes(event.contentId),
      },
      profile,
      input.scope,
      input.homeCityKey,
      input.homeCountryCode,
      nowMs
    );
    if (result.excluded) continue; // already ended — see scoreEventTime
    scored.push({ item: event, score: result.totalScore, bucket: classifyBucket(event.categoryId, profile), breakdown: result.breakdown, creatorId: event.authorUid, categoryId: event.categoryId });
  }
  if (scored.length === 0) return { events: [] };

  const interleaved = bucketAndSort(scored, pageSize);

  const { stats: statsByContentId, fallbackCounts } = await resolvePopularityInputs(
    'content',
    interleaved.map((entry) => entry.item.contentId),
    fetchContentLikeCount,
    fetchContentCommentCount
  );
  const refined = interleaved.map((entry, index) => {
    const engagementStats = statsByContentId.get(entry.item.contentId) ?? null;
    const fallback = fallbackCounts.get(entry.item.contentId);
    const result = computeItemScore(
      {
        categoryId: entry.categoryId,
        creatorId: entry.creatorId,
        cityKey: entry.item.cityKey,
        countryCode: entry.item.countryCode,
        publishedAtMs: entry.item.createdAt.toMillis(),
        isFollowingCreator: followingSet.has(entry.creatorId),
        likeCount: fallback?.likeCount ?? 0,
        commentCount: fallback?.commentCount ?? 0,
        engagementStats,
        collaborativeProfile,
        event: { startsAtMs: entry.item.startsAt.toMillis(), endsAtMs: entry.item.endsAt.toMillis() },
        hasRespondedToEvent: profile.respondedEventIds.includes(entry.item.contentId),
      },
      profile,
      input.scope,
      input.homeCityKey,
      input.homeCountryCode,
      nowMs
    );
    const finalScore = result.excluded ? entry.score : applySessionJitter(result.totalScore, input.uid, sessionSeed, entry.item.contentId);
    return { ...entry, score: finalScore, breakdown: result.breakdown };
  });

  const diversified = applyDiversity(refined);

  const events = diversified.slice(0, pageSize).map(
    (entry, index): RankedItem<RankableEvent> => ({
      item: entry.item,
      score: entry.score,
      bucket: entry.bucket,
      attribution: {
        rankPosition: index + 1,
        sourceTags: deriveSourceTags(entry.breakdown, entry.bucket, followingSet.has(entry.creatorId)),
        bucket: entry.bucket,
        rankingVersion: RANKING_CONFIG_VERSION,
      },
      debug: input.debug
        ? {
            totalScore: entry.score,
            ...entry.breakdown,
            exploration: scoreExploration(entry.categoryId, profile),
            bucket: entry.bucket,
            collaborativeConfidence: collaborativeProfile.confidence,
          }
        : undefined,
    })
  );

  return { events };
}

/**
 * The Events tab's ACTUAL "For You" integration point — reorders each of
 * fetchDiscoverySections' existing three time-based sections
 * (happeningNow/today/upcoming) by relevance, WITHOUT changing that
 * screen's own section structure, weekend split, or event-time
 * exclusion (all already enforced by fetchDiscoverySections itself — see
 * getForYouEvents's own doc comment). This is the lighter, lower-risk
 * integration deliberately chosen over replacing Events' sectioned UI
 * with one flat ranked list — Around Me's spec explicitly asks not to
 * redesign existing screens, and time-sectioned Events is a considered,
 * still-valid UX for this content type, not something this feature needs
 * to replace to deliver real personalization.
 *
 * Recommendation Engine — Step 4, Step 27 — NOW includes trusted-stats
 * quality too: this used to skip popularity entirely (the OLD 2-
 * getCountFromServer-reads-per-event cost was judged not worth it for a
 * reordering pass over up to SECTION_LIMIT x 3 events — see events.tsx's
 * own doc comment on that read-cost cap). A single stats-doc read per
 * event is cheap enough to include (Step 22 already made this the same
 * order of cost as ONE of those two old count reads, not both), so
 * quality is now one more real signal here, same fallback-to-live-counts
 * hierarchy as getForYouEvents (Step 23) for any event with no stats doc
 * yet.
 *
 * Recommendation Engine — Step 3, Step 18 — DOES add one small, bounded
 * extra query when a learned secondary city qualifies (see
 * pickSecondaryCity/SECONDARY_CITY_EVENT_SECTION_LIMIT) — a different
 * cost trade-off than the popularity reads skipped above: this is exactly
 * ONE extra fetchDiscoverySections call total (bounded, small limit), not
 * one read per event, so it doesn't scale with pool size the way
 * popularity reads would. The secondary city's events are merged into
 * the SAME three time-window sections (their own startsAt already
 * classifies them into happeningNow/today/upcoming consistently,
 * regardless of city) and then scored/diversified together with the
 * primary pool — scoreLocation's own affinity-aware formula is what
 * actually keeps a same-city event generally outranking an equivalent
 * secondary-city one (Step 6), not a hardcoded ratio (Step 18's own
 * "do not hardcode exact ratio if a score-based implementation is
 * cleaner" instruction).
 */
export async function rankEventSections(
  uid: string,
  sections: DiscoverySections,
  scope: BrowseScope,
  homeCityKey: string,
  homeCountryCode: string,
  onboardingInterestIds: readonly string[] = [],
  sessionSeed = 'default'
): Promise<DiscoverySections> {
  const nowMs = Date.now();
  // Step 12D — hashtagInterests joins the same batch read as
  // getForYouReels' own identical call (recommendationEngine.ts) — one
  // bounded read per ranking batch, never per-event. Previously absent
  // here entirely, which is exactly why every Event's own hashtagRelevance
  // always scored a flat 0 regardless of its hashtags: with no
  // hashtagInterests map supplied, computeItemScore's own
  // `context.hashtagInterests ?? EMPTY_HASHTAG_INTEREST_MAP` fallback was
  // the ONLY thing ever reached.
  const [profile, collaborativeProfile, blockedUids, hashtagInterests] = await Promise.all([
    getCachedInterestProfile(uid, onboardingInterestIds),
    getCachedCollaborativeProfile(uid),
    fetchMyBlockedUserIds(uid),
    getCachedHashtagInterestMap(uid),
  ]);
  const blocked = new Set(blockedUids);
  const excluded = new Set(profile.excludedContentIds);

  const normalizedCityAffinity = normalizeCityAffinity(profile.cityScores);
  const secondaryCityKey = pickSecondaryCity(scope, normalizedCityAffinity);
  const secondarySections = secondaryCityKey
    ? await fetchDiscoverySections({ kind: 'city', cityKey: secondaryCityKey }, SECONDARY_CITY_EVENT_SECTION_LIMIT)
    : null;
  const mergedSections: DiscoverySections = secondarySections
    ? {
        ...sections,
        happeningNow: [...sections.happeningNow, ...secondarySections.happeningNow],
        today: [...sections.today, ...secondarySections.today],
        upcoming: [...sections.upcoming, ...secondarySections.upcoming],
      }
    : sections;

  const allEvents = dedupeEvents(mergedSections);
  const distinctAuthorUids = [...new Set(allEvents.map((event) => event.authorUid))];
  const [followingFlags, popularityInputs] = await Promise.all([
    Promise.all(distinctAuthorUids.map((authorUid) => isFollowing(uid, authorUid))),
    resolvePopularityInputs(
      'content',
      allEvents.map((event) => event.contentId),
      fetchContentLikeCount,
      fetchContentCommentCount
    ),
  ]);
  const followingSet = new Set(distinctAuthorUids.filter((_, index) => followingFlags[index]));
  const { stats: statsByContentId, fallbackCounts } = popularityInputs;

  const scoreAndSort = <T extends RankableEvent>(events: T[]): T[] => {
    const filtered = events.filter((event) => !blocked.has(event.authorUid) && !excluded.has(event.contentId));
    const scored = filtered.map((event) => {
      const fallback = fallbackCounts.get(event.contentId);
      const result = computeItemScore(
        {
          categoryId: event.categoryId,
          creatorId: event.authorUid,
          cityKey: event.cityKey,
          countryCode: event.countryCode,
          publishedAtMs: event.createdAt.toMillis(),
          isFollowingCreator: followingSet.has(event.authorUid),
          likeCount: fallback?.likeCount ?? 0,
          commentCount: fallback?.commentCount ?? 0,
          engagementStats: statsByContentId.get(event.contentId) ?? null,
          collaborativeProfile,
          event: { startsAtMs: event.startsAt.toMillis(), endsAtMs: event.endsAt.toMillis() },
          // Second pass, Step 8 — deprioritize (not exclude) an event the
          // viewer already responded to, so it stops dominating discovery.
          hasRespondedToEvent: profile.respondedEventIds.includes(event.contentId),
          // Step 12D — real hashtags, replacing the previous permanent []
          // placeholder (see scoreHashtagRelevance's own call site in
          // ranking.ts — "Events have no hashtags field at all" is no
          // longer true). See resolveEventHashtagsForScoring's own doc
          // comment for the Activity/legacy-Event fallback reasoning.
          reelHashtags: resolveEventHashtagsForScoring(event),
          hashtagInterests,
        },
        profile,
        scope,
        homeCityKey,
        homeCountryCode,
        nowMs
      );
      const jitteredScore = result.excluded ? result.totalScore : applySessionJitter(result.totalScore, uid, sessionSeed, event.contentId);
      return { event, score: jitteredScore, excluded: result.excluded, creatorId: event.authorUid, categoryId: event.categoryId };
    });
    const eligible = scored.filter((entry) => !entry.excluded);
    eligible.sort((a, b) => b.score - a.score);
    // Second pass, Step 11 — the same creator/category diversity pass
    // Reels already got, now also applied here so one business's events
    // can't fill an entire section end to end.
    return applyDiversity(eligible).map((entry) => entry.event);
  };

  return {
    ...mergedSections,
    happeningNow: scoreAndSort(mergedSections.happeningNow),
    today: scoreAndSort(mergedSections.today),
    upcoming: scoreAndSort(mergedSections.upcoming),
  };
}

function dedupeEvents(sections: DiscoverySections): RankableEvent[] {
  const seen = new Set<string>();
  const result: RankableEvent[] = [];
  for (const event of [...sections.happeningNow, ...sections.today, ...sections.upcoming]) {
    if (seen.has(event.contentId)) continue;
    seen.add(event.contentId);
    result.push(event);
  }
  return result;
}
