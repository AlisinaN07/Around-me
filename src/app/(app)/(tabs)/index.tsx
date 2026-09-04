import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { CategoryChip } from '@/components/CategoryChip';
import { ContentCard } from '@/components/ContentCard';
import { ErrorState } from '@/components/ErrorState';
import { EventCard } from '@/components/EventCard';
import { FollowingFeed } from '@/components/FollowingFeed';
import { SectionHeader } from '@/components/SectionHeader';
import { SegmentedControl } from '@/components/SegmentedControl';
import { CATEGORY_FILTERS, isMetaCategoryFilter } from '@/constants/categoryFilters';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useCity } from '@/providers/CityProvider';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchCityFeed, fetchDiscoverySections } from '@/services/content';
import type { ActivityContent, Content, EventContent } from '@/types/content';

type LoadStatus = 'loading' | 'loaded' | 'error';

type HomeMode = 'around' | 'following';

const HOME_MODE_OPTIONS: { id: HomeMode; label: string }[] = [
  { id: 'around', label: 'Around' },
  { id: 'following', label: 'Following' },
];

export default function HomeScreen() {
  const { user } = useAuth();
  const { activeCity, isExploringAnotherCity, isReady: isCityReady } = useCity();
  // In-session only — not persisted to Firestore. Resets to "Around" (the
  // default) every time this screen mounts fresh; trivially preserved for
  // the rest of a session because it's just ordinary component state.
  const [homeMode, setHomeMode] = useState<HomeMode>('around');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [feedItems, setFeedItems] = useState<Content[]>([]);
  const [happeningItems, setHappeningItems] = useState<(ActivityContent | EventContent)[]>([]);
  const [todayItems, setTodayItems] = useState<(ActivityContent | EventContent)[]>([]);
  const [todayLabel, setTodayLabel] = useState<'Today' | 'Tonight'>('Today');
  const [upcomingItems, setUpcomingItems] = useState<(ActivityContent | EventContent)[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const cityLabel = activeCity?.cityName ?? 'you';

  const loadFeed = useCallback(
    async (isRefresh = false) => {
      if (!activeCity) return;
      if (isRefresh) {
        setIsRefreshing(true);
      } else {
        setStatus('loading');
        // Clears any previous city's results immediately, before the new
        // city's fetch even starts — otherwise the loading-skeleton branch
        // below (which only triggers when the list is empty) would be
        // skipped and stale content from the prior city would render
        // under the new city's header for the duration of the fetch.
        setFeedItems([]);
        setHappeningItems([]);
        setTodayItems([]);
        setUpcomingItems([]);
      }
      try {
        const [feed, discovery, blockedUids] = await Promise.all([
          fetchCityFeed(activeCity.cityKey),
          fetchDiscoverySections(activeCity.cityKey),
          // Client-side only: this does NOT make blocked users' published
          // content inaccessible (see the Step 17 MVP boundary in
          // firestore.rules) — it just keeps them out of MY OWN Around/
          // discovery-rail view. A single one-shot fetch per load, not a
          // query per blocked user.
          user ? fetchMyBlockedUserIds(user.uid) : Promise.resolve<string[]>([]),
        ]);
        const blockedSet = new Set(blockedUids);
        const dropBlocked = <T extends { authorUid: string }>(items: T[]) =>
          blockedSet.size > 0 ? items.filter((item) => !blockedSet.has(item.authorUid)) : items;
        setFeedItems(dropBlocked(feed));
        setHappeningItems(dropBlocked(discovery.happeningNow));
        setTodayItems(dropBlocked(discovery.today));
        setTodayLabel(discovery.todayLabel);
        setUpcomingItems(dropBlocked(discovery.upcoming));
        setStatus('loaded');
      } catch {
        setStatus('error');
      } finally {
        setIsRefreshing(false);
      }
    },
    [activeCity, user]
  );

  // Home refetches every time it regains focus (covers first mount, tab
  // switches back to Home, and returning here after a successful publish
  // from Create — no realtime listener, still a one-shot query per visit)
  // AND every time Active City changes, so switching cities in the
  // explorer refreshes this screen without a manual pull-to-refresh.
  useFocusEffect(
    useCallback(() => {
      if (!isCityReady) return;
      loadFeed();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCity?.cityKey, isCityReady])
  );

  const visibleItems = useMemo(() => {
    switch (selectedCategory) {
      case 'all':
        return feedItems;
      case 'happening-now':
        return happeningItems;
      case 'events':
        return feedItems.filter((item) => item.type === 'event');
      case 'activities':
        return feedItems.filter((item) => item.type === 'activity');
      default:
        return feedItems.filter((item) => item.categoryId === selectedCategory);
    }
  }, [selectedCategory, feedItems, happeningItems]);

  // The 'all'/'happening-now'/'events'/'activities' chips are Around-feed
  // VIEW MODES (handled above); a real categoryId (e.g. 'sports') instead
  // filters the time-based discovery rails too, so tapping "Sports" shows
  // Sports content consistently everywhere on Home, not just in the feed.
  const isRealCategory = !isMetaCategoryFilter(selectedCategory);
  const visibleHappeningItems = useMemo(
    () => (isRealCategory ? happeningItems.filter((item) => item.categoryId === selectedCategory) : happeningItems),
    [isRealCategory, happeningItems, selectedCategory]
  );
  const visibleTodayItems = useMemo(
    () => (isRealCategory ? todayItems.filter((item) => item.categoryId === selectedCategory) : todayItems),
    [isRealCategory, todayItems, selectedCategory]
  );
  const visibleUpcomingItems = useMemo(
    () => (isRealCategory ? upcomingItems.filter((item) => item.categoryId === selectedCategory) : upcomingItems),
    [isRealCategory, upcomingItems, selectedCategory]
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.topBar}>
        <View style={styles.page}>
          <View style={styles.header}>
            <Pressable onPress={() => router.push('/cities')} style={styles.headerTextGroup} accessibilityRole="button" accessibilityLabel="Change city">
              <View style={styles.cityRow}>
                <Text style={styles.title}>Around {cityLabel}</Text>
                <Ionicons name="chevron-down" size={18} color={Colors.text} />
              </View>
              {isExploringAnotherCity ? <Text style={styles.exploringLabel}>Exploring {cityLabel}</Text> : null}
            </Pressable>
            <View style={styles.headerActions}>
              {Platform.OS === 'web' && homeMode === 'around' && (
                <Pressable
                  onPress={() => loadFeed(true)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Refresh"
                  style={styles.headerButton}
                >
                  <Ionicons name={isRefreshing ? 'sync' : 'refresh-outline'} size={20} color={Colors.text} />
                </Pressable>
              )}
              <Pressable
                onPress={() => {}}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Search"
                style={styles.headerButton}
              >
                <Ionicons name="search-outline" size={22} color={Colors.text} />
              </Pressable>
              <Pressable
                onPress={() => {}}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Notifications"
                style={styles.headerButton}
              >
                <Ionicons name="notifications-outline" size={22} color={Colors.text} />
              </Pressable>
            </View>
          </View>

          <View style={styles.modeSwitch}>
            <SegmentedControl options={HOME_MODE_OPTIONS} value={homeMode} onChange={setHomeMode} />
          </View>
        </View>
      </View>

      {homeMode === 'following' ? (
        user && activeCity ? (
          <FollowingFeed
            currentUid={user.uid}
            cityKey={activeCity.cityKey}
            cityLabel={cityLabel}
            onExploreAround={() => setHomeMode('around')}
          />
        ) : null
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            Platform.OS === 'web' ? undefined : (
              <RefreshControl refreshing={isRefreshing} onRefresh={() => loadFeed(true)} tintColor={Colors.accent} />
            )
          }
        >
          <View style={styles.page}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.horizontalScroll}
              contentContainerStyle={styles.chipsRow}
            >
              {CATEGORY_FILTERS.map((category) => (
                <CategoryChip
                  key={category.id}
                  label={category.label}
                  icon={category.icon}
                  selected={selectedCategory === category.id}
                  onPress={() => setSelectedCategory(category.id)}
                />
              ))}
            </ScrollView>

            {status === 'error' ? (
              <View style={styles.errorStateWrap}>
                <ErrorState title={`Couldn't load what's happening in ${cityLabel}.`} onRetry={() => loadFeed()} />
              </View>
            ) : (
              <>
                <View style={styles.section}>
                  <SectionHeader title="Happening Now 🔥" actionLabel="See all" onActionPress={() => router.push('/events')} />
                  {status === 'loading' && happeningItems.length === 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      <SkeletonBlock width={188} height={148} />
                      <SkeletonBlock width={188} height={148} />
                    </ScrollView>
                  ) : visibleHappeningItems.length === 0 ? (
                    <View style={styles.emptyPanel}>
                      <Text style={styles.emptyPanelTitle}>Nothing happening right now in {cityLabel}</Text>
                      <Text style={styles.emptyPanelBody}>Check Activities and Events coming up soon.</Text>
                    </View>
                  ) : (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      {visibleHappeningItems.map((item) => (
                        <EventCard key={item.contentId} item={item} />
                      ))}
                    </ScrollView>
                  )}
                </View>

                <View style={styles.section}>
                  <SectionHeader title={`${todayLabel} in ${cityLabel}`} actionLabel="See all" onActionPress={() => router.push('/events')} />
                  {status === 'loading' && todayItems.length === 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      <SkeletonBlock width={188} height={148} />
                      <SkeletonBlock width={188} height={148} />
                    </ScrollView>
                  ) : visibleTodayItems.length === 0 ? (
                    <View style={styles.emptyPanel}>
                      <Text style={styles.emptyPanelBody}>Nothing else lined up for {todayLabel.toLowerCase()} yet.</Text>
                    </View>
                  ) : (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      {visibleTodayItems.map((item) => (
                        <EventCard key={item.contentId} item={item} />
                      ))}
                    </ScrollView>
                  )}
                </View>

                <View style={styles.section}>
                  <SectionHeader title="Coming up this week" actionLabel="See all" onActionPress={() => router.push('/events')} />
                  {status === 'loading' && upcomingItems.length === 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      <SkeletonBlock width={188} height={148} />
                      <SkeletonBlock width={188} height={148} />
                    </ScrollView>
                  ) : visibleUpcomingItems.length === 0 ? (
                    <View style={styles.emptyPanel}>
                      <Text style={styles.emptyPanelBody}>Nothing coming up in {cityLabel} yet.</Text>
                    </View>
                  ) : (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      {visibleUpcomingItems.map((item) => (
                        <EventCard key={item.contentId} item={item} />
                      ))}
                    </ScrollView>
                  )}
                </View>

                <View style={styles.section}>
                  <SectionHeader title="Local Reels" actionLabel="See all" onActionPress={() => router.push('/reels')} />
                  <Pressable style={styles.reelsEmptyPanel} onPress={() => router.push('/reels')} accessibilityRole="button">
                    <Ionicons name="videocam-outline" size={22} color={Colors.textSecondary} />
                    <Text style={styles.emptyPanelBody}>
                      Local videos will appear here as people start sharing what&apos;s happening around the city.
                    </Text>
                  </Pressable>
                </View>

                <View style={styles.section}>
                  <SectionHeader title="Around You" />
                  {status === 'loading' && feedItems.length === 0 ? (
                    <>
                      <SkeletonBlock width="100%" height={110} style={styles.feedSkeleton} />
                      <SkeletonBlock width="100%" height={110} style={styles.feedSkeleton} />
                    </>
                  ) : feedItems.length === 0 ? (
                    <View style={styles.emptyCityPanel}>
                      {isExploringAnotherCity ? (
                        <>
                          <Text style={styles.emptyPanelTitle}>Not much happening in {cityLabel} yet.</Text>
                          <Text style={styles.emptyPanelBody}>Explore another city or check back later.</Text>
                          <Button label="Explore another city" variant="secondary" onPress={() => router.push('/cities')} />
                        </>
                      ) : (
                        <>
                          <Text style={styles.emptyPanelTitle}>Nothing happening here yet.</Text>
                          <Text style={styles.emptyPanelBody}>Be one of the first people to post in {cityLabel}.</Text>
                          <Button label="Create something" onPress={() => router.push('/create')} />
                        </>
                      )}
                    </View>
                  ) : visibleItems.length === 0 ? (
                    <View style={styles.emptyCityPanel}>
                      <Text style={styles.emptyPanelBody}>Nothing matches this filter yet.</Text>
                    </View>
                  ) : (
                    visibleItems.map((item) => <ContentCard key={item.contentId} item={item} currentUid={user?.uid ?? null} />)
                  )}
                </View>
              </>
            )}
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function SkeletonBlock({ width, height, style }: { width: number | `${number}%`; height: number; style?: object }) {
  return <View style={[styles.skeleton, { width, height }, style]} />;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  topBar: {
    alignItems: 'center',
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  modeSwitch: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  headerTextGroup: {
    flexShrink: 1,
    gap: 2,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  exploringLabel: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  title: {
    color: Colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  headerActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  horizontalScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  chipsRow: {
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  section: {
    marginTop: Spacing.lg,
  },
  horizontalListContent: {
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  emptyPanel: {
    marginHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    gap: 4,
  },
  emptyPanelTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  emptyPanelBody: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  reelsEmptyPanel: {
    marginHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: 'dashed',
    padding: Spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  emptyCityPanel: {
    marginHorizontal: Spacing.lg,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  errorStateWrap: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.xl,
  },
  skeleton: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    opacity: 0.5,
  },
  feedSkeleton: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
});
