import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ReelCategoryFilterSheet } from '@/components/ReelCategoryFilterSheet';
import { ReelFeed } from '@/components/ReelFeed';
import { Colors, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useCity } from '@/providers/CityProvider';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import type { ReelCandidateCursor } from '@/services/recommendations/candidateGenerator';
import { assignExperimentVariant, COLLABORATIVE_WEIGHT_V1_EXPERIMENT } from '@/services/recommendations/experiments';
import { getForYouReels } from '@/services/recommendations/recommendationEngine';
import { fetchFollowingReels } from '@/services/reels';
import { browseScopeKey } from '@/types/browseScope';
import type { Reel } from '@/types/reel';
import type { RankedItem, RankingAttribution } from '@/types/recommendation';

type LoadStatus = 'loading' | 'loaded' | 'error';
type HomeMode = 'forYou' | 'following';

/** Recommendation Engine — Step 6 — builds a reelId-keyed attribution map from one getForYouReels page, stamping in the UI-layer-computed experimentVariant (the ranking engine itself doesn't know about experiments — Step 29). */
function attributionMapFor(rankedReels: RankedItem<Reel>[], experimentVariant: string | undefined): Record<string, RankingAttribution> {
  const map: Record<string, RankingAttribution> = {};
  for (const ranked of rankedReels) {
    map[ranked.item.reelId] = experimentVariant ? { ...ranked.attribution, experimentVariant } : ranked.attribution;
  }
  return map;
}

/**
 * Home — the local user-generated social/Reel feed (Step 25). Deliberately
 * NOT an event calendar: Happening Now/Today/Upcoming/Around-feed rails
 * live on the Events tab now (see src/app/(app)/(tabs)/events.tsx), which
 * still uses the exact same fetchDiscoverySections/dateWindows services —
 * nothing about that architecture was touched, only Home's own usage of it
 * was removed. Home renders exactly one thing: the vertical Reel feed,
 * via the shared ReelFeed component also used by the standalone /reels
 * route (src/app/(app)/reels.tsx), so paging/playback/engagement never
 * drift into two implementations.
 */
export default function HomeScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const { activeScope, activeScopeLabel, homeCity, isExploringElsewhere, isReady: isCityReady } = useCity();

  // Step 5, second pass — one value per app-open/feed session, generated
  // ONCE at mount and reused for every page fetched during it (initial +
  // every loadMoreForYou call). Never persisted, never sent anywhere but
  // this session's own getForYouReels calls — see
  // recommendationEngine.ts's applySessionJitter for what it's actually
  // used for (a small, deterministic per-item jitter so scrolling forward
  // never reshuffles already-shown content, while a fresh app open — a
  // fresh value here — naturally varies discovery ordering session to
  // session).
  const [feedSessionId] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  // Recommendation Engine — Step 6, Steps 11/18/19 — computed once per
  // signed-in uid (deterministic — see experiments.ts), attached to every
  // tracked interaction's attribution below purely for FUTURE analysis.
  // COLLABORATIVE_WEIGHT_V1_EXPERIMENT is disabled (Step 13/29), so this
  // is always 'control' today, using the exact same collaborativeWeight
  // already in production — computing and recording an assignment has no
  // effect on what's actually shown.
  const experimentVariant = useMemo(
    () => (user ? assignExperimentVariant(user.uid, COLLABORATIVE_WEIGHT_V1_EXPERIMENT).variantId : undefined),
    [user]
  );
  // Recommendation Engine — Step 6, Step 18/19 — the ranked attribution
  // for every reelId currently in forYouReels, keyed by reelId (a plain
  // Reel[] array alone, as rendered by ReelFeed, has nowhere to carry
  // this). Populated in loadForYou/loadMoreForYou below, alongside (never
  // instead of) the plain reel list — attribution is DEVELOPMENT/
  // analytics metadata only (Step 29), never consulted by ranking itself.
  const [forYouAttribution, setForYouAttribution] = useState<Record<string, RankingAttribution>>({});

  // In-session only, resets to "For You" (the default) on fresh mount —
  // same non-persisted pattern the old Around/Following toggle used.
  const [mode, setMode] = useState<HomeMode>('forYou');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const [forYouReels, setForYouReels] = useState<Reel[]>([]);
  const [forYouStatus, setForYouStatus] = useState<LoadStatus>('loading');
  const [isForYouLoadingMore, setIsForYouLoadingMore] = useState(false);
  // Every reelId already shown THIS session — the recommendation engine's
  // own pagination mechanism (Step 19): each page excludes these, so
  // "load more" never just re-ranks/repeats the same pool. Reset whenever
  // loadForYou (re)starts a fresh session (scope/mode change, pull-to-
  // refresh via onReload). A ref, not state — read at call time by
  // loadMoreForYou, never itself needs to trigger a re-render.
  const seenForYouReelIdsRef = useRef<Set<string>>(new Set());
  // Perf pass — the opaque cursor getForYouReels itself returns (see
  // candidateGenerator.ts's own doc comment): a real Firestore position
  // to resume this scope's own local pool from, so loadMoreForYou
  // actually pages forward instead of re-fetching the same bounded
  // top-N query every time. Reset alongside seenForYouReelIdsRef
  // whenever loadForYou (re)starts a fresh session (scope/mode change,
  // pull-to-refresh, user change) — a fresh session has nothing to
  // resume, and a stale cursor from a DIFFERENT scope is already safely
  // ignored by generateReelCandidates' own scopeKey check even if this
  // reset were somehow skipped.
  const forYouCursorRef = useRef<ReelCandidateCursor | undefined>(undefined);

  const [followingReels, setFollowingReels] = useState<Reel[]>([]);
  const [followsAnyone, setFollowsAnyone] = useState(true);
  const [followingStatus, setFollowingStatus] = useState<LoadStatus>('loading');

  const cityLabel = activeScopeLabel;

  const loadForYou = useCallback(async () => {
    if (!user || !homeCity) return;
    setForYouStatus('loading');
    // Clears the previous scope's Reels immediately — otherwise the empty
    // state (which only shows when the list is already empty) would be
    // skipped and a stale scope's video would render under the new
    // scope's header for the duration of the fetch (same scope-switch
    // rule as every other discovery surface in this app).
    setForYouReels([]);
    setForYouAttribution({});
    seenForYouReelIdsRef.current = new Set();
    forYouCursorRef.current = undefined;
    try {
      const page = await getForYouReels({
        uid: user.uid,
        scope: activeScope,
        homeCityKey: homeCity.cityKey,
        homeCountryCode: homeCity.countryCode,
        excludeReelIds: seenForYouReelIdsRef.current,
        onboardingInterestIds: profile?.interests,
        sessionSeed: feedSessionId,
      });
      const reels = page.reels.map((ranked) => ranked.item);
      for (const reel of reels) seenForYouReelIdsRef.current.add(reel.reelId);
      forYouCursorRef.current = page.cursor;
      setForYouReels(reels);
      setForYouAttribution(attributionMapFor(page.reels, experimentVariant));
      setForYouStatus('loaded');
      // Recommendation Engine — Step 6, Step 21 — dev-only visibility into
      // "does intelligence make the feed slow" — never persisted, never
      // shown in production UI, and reading it can never throw (Step 19's
      // own "latency measurement does not break recommendation flow").
      if (__DEV__) {
        // eslint-disable-next-line no-console
        console.log('[recommendations] getForYouReels latency (ms):', page.latencyMs);
      }
    } catch {
      setForYouStatus('error');
    }
  }, [activeScope, user, homeCity, profile, feedSessionId, experimentVariant]);

  // Step 19 pagination — wired to ReelFeed's onEndReached below. Blocked
  // users are already excluded inside getForYouReels' own candidate
  // generation, so nothing extra to filter here.
  const loadMoreForYou = useCallback(async () => {
    if (!user || !homeCity || isForYouLoadingMore || forYouStatus !== 'loaded') return;
    setIsForYouLoadingMore(true);
    try {
      const page = await getForYouReels({
        uid: user.uid,
        scope: activeScope,
        homeCityKey: homeCity.cityKey,
        homeCountryCode: homeCity.countryCode,
        excludeReelIds: seenForYouReelIdsRef.current,
        onboardingInterestIds: profile?.interests,
        sessionSeed: feedSessionId,
        cursor: forYouCursorRef.current,
      });
      forYouCursorRef.current = page.cursor;
      const newReels = page.reels.map((ranked) => ranked.item);
      if (newReels.length > 0) {
        for (const reel of newReels) seenForYouReelIdsRef.current.add(reel.reelId);
        setForYouReels((current) => [...current, ...newReels]);
        setForYouAttribution((current) => ({ ...current, ...attributionMapFor(page.reels, experimentVariant) }));
      }
    } catch {
      // A failed "load more" just means the feed doesn't grow this time —
      // never surfaces as a full-screen error over an already-loaded feed.
    } finally {
      setIsForYouLoadingMore(false);
    }
  }, [activeScope, user, homeCity, isForYouLoadingMore, forYouStatus, profile, feedSessionId, experimentVariant]);

  const loadFollowing = useCallback(async () => {
    if (!user) return;
    setFollowingStatus('loading');
    setFollowingReels([]);
    try {
      const [result, blockedUids] = await Promise.all([
        fetchFollowingReels({ currentUid: user.uid, scope: activeScope }),
        fetchMyBlockedUserIds(user.uid),
      ]);
      const blockedSet = new Set(blockedUids);
      setFollowingReels(blockedSet.size > 0 ? result.reels.filter((reel) => !blockedSet.has(reel.authorUid)) : result.reels);
      setFollowsAnyone(result.followsAnyone);
      setFollowingStatus('loaded');
    } catch {
      setFollowingStatus('error');
    }
  }, [activeScope, user]);

  const activeScopeKey = useMemo(() => browseScopeKey(activeScope), [activeScope]);
  // Everything loadForYou/loadFollowing's own fetches actually depend on
  // besides the mode itself — account, Active Scope, and (For You only)
  // the viewer's own Home City, which getForYouReels also reads directly.
  // A CHANGE in this key is the one thing that should ever invalidate and
  // reload an already-loaded feed; identical keys across a focus event
  // mean nothing real changed, so there's nothing to reload.
  const feedLoadKey = `${user?.uid ?? ''}:${activeScopeKey}:${homeCity?.cityKey ?? ''}`;

  // Stale-while-revalidate — the LAST feedLoadKey each mode was actually
  // (re)loaded for. Expo Router keeps Home mounted (just hidden) when the
  // user switches tabs — see ReelFeed's own doc comment — so the feed and
  // its scroll position are never really lost by leaving and coming back;
  // the only thing that WAS discarding them was this effect unconditionally
  // re-calling loadForYou/loadFollowing (both of which clear their list
  // before re-fetching — see their own comments) on every single refocus,
  // even when nothing had actually changed. Comparing against the key
  // below is what makes a mere refocus a no-op: the existing feed (and
  // wherever the viewer scrolled to) stays exactly as it was, instantly,
  // with no network request at all — never "a newly-ranked feed just
  // because the screen regained focus". A REAL change — switching mode,
  // switching account, or the Active Scope/Home City actually changing —
  // still reloads for real, exactly as before (loadForYou/loadFollowing
  // are completely unchanged; only when they're called is different).
  const loadedForYouKeyRef = useRef<string | null>(null);
  const loadedFollowingKeyRef = useRef<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!isCityReady) return;
      if (mode === 'forYou') {
        if (loadedForYouKeyRef.current === feedLoadKey) return;
        loadedForYouKeyRef.current = feedLoadKey;
        loadForYou();
      } else {
        if (loadedFollowingKeyRef.current === feedLoadKey) return;
        loadedFollowingKeyRef.current = feedLoadKey;
        loadFollowing();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [feedLoadKey, isCityReady, mode])
  );

  const visibleForYouReels = useMemo(
    () => (categoryFilter ? forYouReels.filter((reel) => reel.categoryId === categoryFilter) : forYouReels),
    [forYouReels, categoryFilter]
  );
  const visibleFollowingReels = useMemo(
    () => (categoryFilter ? followingReels.filter((reel) => reel.categoryId === categoryFilter) : followingReels),
    [followingReels, categoryFilter]
  );

  const topOverlay = (
    <View style={styles.overlayRow}>
      <Pressable onPress={() => router.push('/cities')} style={styles.cityButton} accessibilityRole="button" accessibilityLabel="Change city">
        <Text style={styles.cityButtonText} numberOfLines={1}>
          {cityLabel}
        </Text>
        <Ionicons name="chevron-down" size={16} color={Colors.text} />
      </Pressable>

      <View style={styles.modeTabs}>
        <ModeTab label="Following" active={mode === 'following'} onPress={() => setMode('following')} />
        <ModeTab label="For You" active={mode === 'forYou'} onPress={() => setMode('forYou')} />
      </View>

      <View style={styles.rightIcons}>
        <Pressable onPress={() => router.push('/search')} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Search people">
          <Ionicons name="search-outline" size={20} color={Colors.text} />
        </Pressable>
        <Pressable onPress={() => setIsFilterOpen(true)} style={styles.iconButton} accessibilityRole="button" accessibilityLabel="Filter by category">
          <Ionicons name="options-outline" size={20} color={Colors.text} />
        </Pressable>
      </View>
    </View>
  );

  if (mode === 'following') {
    return (
      <>
        <ReelFeed
          reels={visibleFollowingReels}
          status={followingStatus}
          errorTitle={`Couldn't load posts in ${cityLabel}`}
          onReload={loadFollowing}
          topOverlay={topOverlay}
          emptyState={
            !followsAnyone ? (
              <EmptyState
                bare
                icon="people-outline"
                title="Your Following feed is empty"
                body={`Follow people in ${cityLabel} to see their posts here.`}
              />
            ) : (
              <EmptyState bare icon="videocam-outline" title={`No new posts from people you follow in ${cityLabel}.`} />
            )
          }
        />
        <ReelCategoryFilterSheet
          visible={isFilterOpen}
          selectedCategoryId={categoryFilter}
          onSelect={setCategoryFilter}
          onClose={() => setIsFilterOpen(false)}
        />
      </>
    );
  }

  return (
    <>
      <ReelFeed
        reels={visibleForYouReels}
        attributionByReelId={forYouAttribution}
        feedSessionId={feedSessionId}
        status={forYouStatus}
        errorTitle={`Couldn't load posts in ${cityLabel}`}
        onReload={loadForYou}
        onEndReached={loadMoreForYou}
        topOverlay={topOverlay}
        emptyState={
          <EmptyState
            bare
            icon="videocam-outline"
            title={`No posts in ${cityLabel} yet`}
            body="Be the first to show what's happening."
            action={
              <>
                <Button label="Create post" onPress={() => router.push('/create/reel/camera')} />
                {isExploringElsewhere && homeCity ? (
                  <Text style={styles.exploringHint}>Posts you create publish to your home city, {homeCity.cityName}.</Text>
                ) : null}
              </>
            }
          />
        }
      />
      <ReelCategoryFilterSheet
        visible={isFilterOpen}
        selectedCategoryId={categoryFilter}
        onSelect={setCategoryFilter}
        onClose={() => setIsFilterOpen(false)}
      />
    </>
  );
}

function ModeTab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.modeTab} accessibilityRole="tab" accessibilityState={{ selected: active }}>
      <Text style={[styles.modeTabText, active && styles.modeTabTextActive]}>{label}</Text>
      {active ? <View style={styles.modeTabIndicator} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  cityButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 1,
  },
  cityButtonText: {
    color: Colors.text,
    ...Typography.cardTitle,
  },
  modeTabs: {
    flexDirection: 'row',
    gap: 18,
  },
  modeTab: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  modeTabText: {
    color: Colors.textMuted,
    fontSize: 15,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: Colors.text,
  },
  modeTabIndicator: {
    width: 18,
    height: 2,
    borderRadius: 1,
    backgroundColor: Colors.text,
  },
  rightIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  iconButton: {
    width: 24,
    alignItems: 'center',
  },
  exploringHint: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
});
