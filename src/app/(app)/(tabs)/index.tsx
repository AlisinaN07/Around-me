import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ReelCategoryFilterSheet } from '@/components/ReelCategoryFilterSheet';
import { ReelFeed } from '@/components/ReelFeed';
import { Colors, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useCity } from '@/providers/CityProvider';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchCityReels, fetchFollowingReels } from '@/services/reels';
import type { Reel } from '@/types/reel';

type LoadStatus = 'loading' | 'loaded' | 'error';
type HomeMode = 'forYou' | 'following';

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
  const { activeCity, homeCity, isExploringAnotherCity, isReady: isCityReady } = useCity();

  // In-session only, resets to "For You" (the default) on fresh mount —
  // same non-persisted pattern the old Around/Following toggle used.
  const [mode, setMode] = useState<HomeMode>('forYou');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const [forYouReels, setForYouReels] = useState<Reel[]>([]);
  const [forYouStatus, setForYouStatus] = useState<LoadStatus>('loading');

  const [followingReels, setFollowingReels] = useState<Reel[]>([]);
  const [followsAnyone, setFollowsAnyone] = useState(true);
  const [followingStatus, setFollowingStatus] = useState<LoadStatus>('loading');

  const cityLabel = activeCity?.cityName ?? 'your city';

  const loadForYou = useCallback(async () => {
    if (!activeCity) return;
    setForYouStatus('loading');
    // Clears the previous city's Reels immediately — otherwise the empty
    // state (which only shows when the list is already empty) would be
    // skipped and a stale city's video would render under the new city's
    // header for the duration of the fetch (same city-switch rule as
    // every other discovery surface in this app).
    setForYouReels([]);
    try {
      const [cityReels, blockedUids] = await Promise.all([
        fetchCityReels(activeCity.cityKey),
        user ? fetchMyBlockedUserIds(user.uid) : Promise.resolve<string[]>([]),
      ]);
      const blockedSet = new Set(blockedUids);
      setForYouReels(blockedSet.size > 0 ? cityReels.filter((reel) => !blockedSet.has(reel.authorUid)) : cityReels);
      setForYouStatus('loaded');
    } catch {
      setForYouStatus('error');
    }
  }, [activeCity, user]);

  const loadFollowing = useCallback(async () => {
    if (!activeCity || !user) return;
    setFollowingStatus('loading');
    setFollowingReels([]);
    try {
      const [result, blockedUids] = await Promise.all([
        fetchFollowingReels({ currentUid: user.uid, cityKey: activeCity.cityKey }),
        fetchMyBlockedUserIds(user.uid),
      ]);
      const blockedSet = new Set(blockedUids);
      setFollowingReels(blockedSet.size > 0 ? result.reels.filter((reel) => !blockedSet.has(reel.authorUid)) : result.reels);
      setFollowsAnyone(result.followsAnyone);
      setFollowingStatus('loaded');
    } catch {
      setFollowingStatus('error');
    }
  }, [activeCity, user]);

  // Reloads whenever Home regains focus, Active City changes, or the
  // visible mode changes — same one-shot-per-visit pattern the rest of
  // this app's discovery surfaces use, no realtime listener.
  useFocusEffect(
    useCallback(() => {
      if (!isCityReady) return;
      if (mode === 'forYou') {
        loadForYou();
      } else {
        loadFollowing();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCity?.cityKey, isCityReady, mode])
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

      <Pressable onPress={() => setIsFilterOpen(true)} style={styles.filterButton} accessibilityRole="button" accessibilityLabel="Filter by category">
        <Ionicons name="options-outline" size={20} color={Colors.text} />
      </Pressable>
    </View>
  );

  if (mode === 'following') {
    return (
      <>
        <ReelFeed
          reels={visibleFollowingReels}
          status={followingStatus}
          errorTitle={`Couldn't load Reels in ${cityLabel}`}
          onReload={loadFollowing}
          topOverlay={topOverlay}
          emptyState={
            !followsAnyone ? (
              <EmptyState
                bare
                icon="people-outline"
                title="Your Following feed is empty"
                body={`Follow people in ${cityLabel} to see their Reels here.`}
              />
            ) : (
              <EmptyState bare icon="videocam-outline" title={`No new Reels from people you follow in ${cityLabel}.`} />
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
        status={forYouStatus}
        errorTitle={`Couldn't load Reels in ${cityLabel}`}
        onReload={loadForYou}
        topOverlay={topOverlay}
        emptyState={
          <EmptyState
            bare
            icon="videocam-outline"
            title={`No Reels in ${cityLabel} yet`}
            body="Be the first to show what's happening."
            action={
              <>
                <Button label="Create Reel" onPress={() => router.push('/create/reel')} />
                {isExploringAnotherCity && homeCity ? (
                  <Text style={styles.exploringHint}>Reels you create publish to your home city, {homeCity.cityName}.</Text>
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
  filterButton: {
    width: 32,
    alignItems: 'flex-end',
  },
  exploringHint: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
});
