import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { CategoryChip } from '@/components/CategoryChip';
import { ContentCard } from '@/components/ContentCard';
import { FollowingFeed } from '@/components/FollowingFeed';
import { HappeningNowCard } from '@/components/HappeningNowCard';
import { SectionHeader } from '@/components/SectionHeader';
import { SegmentedControl } from '@/components/SegmentedControl';
import { CATEGORY_FILTERS } from '@/constants/categoryFilters';
import { INTERESTS } from '@/constants/interests';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { fetchCityFeed, fetchHappeningNow } from '@/services/content';
import type { ActivityContent, Content, EventContent } from '@/types/content';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { formatEventTime } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';

type HomeMode = 'around' | 'following';

const HOME_MODE_OPTIONS: { id: HomeMode; label: string }[] = [
  { id: 'around', label: 'Around' },
  { id: 'following', label: 'Following' },
];

export default function HomeScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();
  // In-session only — not persisted to Firestore. Resets to "Around" (the
  // default) every time this screen mounts fresh; trivially preserved for
  // the rest of a session because it's just ordinary component state.
  const [homeMode, setHomeMode] = useState<HomeMode>('around');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [feedItems, setFeedItems] = useState<Content[]>([]);
  const [happeningItems, setHappeningItems] = useState<(ActivityContent | EventContent)[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [isRefreshing, setIsRefreshing] = useState(false);

  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : 'you';

  const loadFeed = useCallback(
    async (isRefresh = false) => {
      if (!profile) return;
      if (isRefresh) {
        setIsRefreshing(true);
      } else {
        setStatus('loading');
      }
      try {
        const [feed, happening] = await Promise.all([
          fetchCityFeed(profile.cityKey),
          fetchHappeningNow(profile.cityKey),
        ]);
        setFeedItems(feed);
        setHappeningItems(happening);
        setStatus('loaded');
      } catch {
        setStatus('error');
      } finally {
        setIsRefreshing(false);
      }
    },
    [profile]
  );

  // Home refetches every time it regains focus — covers first mount, tab
  // switches back to Home, and returning here after a successful publish
  // from Create. No realtime listener: still a one-shot query per visit.
  useFocusEffect(
    useCallback(() => {
      loadFeed();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profile?.cityKey])
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.topBar}>
        <View style={styles.page}>
          <View style={styles.header}>
            <View style={styles.headerTextGroup}>
              <View style={styles.cityRow}>
                <Ionicons name="location" size={14} color={Colors.accent} />
                <Text style={styles.cityLabel}>Current city</Text>
              </View>
              <Text style={styles.title}>Around {cityLabel}</Text>
            </View>
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
        user && profile ? (
          <FollowingFeed
            currentUid={user.uid}
            cityKey={profile.cityKey}
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
              <View style={styles.errorState}>
                <Ionicons name="cloud-offline-outline" size={32} color={Colors.textSecondary} />
                <Text style={styles.errorTitle}>Couldn&apos;t load Around {cityLabel}.</Text>
                <Button label="Try again" onPress={() => loadFeed()} />
              </View>
            ) : (
              <>
                <View style={styles.section}>
                  <SectionHeader title="Happening Now 🔥" />
                  {status === 'loading' && happeningItems.length === 0 ? (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      <SkeletonBlock width={168} height={148} />
                      <SkeletonBlock width={168} height={148} />
                    </ScrollView>
                  ) : happeningItems.length === 0 ? (
                    <View style={styles.emptyPanel}>
                      <Text style={styles.emptyPanelTitle}>Nothing live right now</Text>
                      <Text style={styles.emptyPanelBody}>
                        Check upcoming events and activities around {cityLabel}.
                      </Text>
                    </View>
                  ) : (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      style={styles.horizontalScroll}
                      contentContainerStyle={styles.horizontalListContent}
                    >
                      {happeningItems.map((item) => {
                        const category = INTERESTS.find((interest) => interest.id === item.categoryId);
                        return (
                          <HappeningNowCard
                            key={item.contentId}
                            category={category ? `${category.emoji} ${category.label}` : item.categoryId}
                            title={item.title}
                            place={item.placeName}
                            timeLabel={formatEventTime(item.startsAt.toDate())}
                            onPress={() => router.push(`/content/${item.contentId}`)}
                          />
                        );
                      })}
                    </ScrollView>
                  )}
                </View>

                <View style={styles.section}>
                  <SectionHeader title="Local Reels" />
                  <View style={styles.reelsEmptyPanel}>
                    <Ionicons name="videocam-outline" size={22} color={Colors.textSecondary} />
                    <Text style={styles.emptyPanelBody}>
                      Local videos will appear here as people start sharing what&apos;s happening around the city.
                    </Text>
                  </View>
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
                      <Text style={styles.emptyPanelTitle}>Nothing here yet.</Text>
                      <Text style={styles.emptyPanelBody}>
                        Be the first person to share what&apos;s happening in {cityLabel}.
                      </Text>
                      <Button label="Create something" onPress={() => router.push('/create')} />
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
    gap: 4,
  },
  cityLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
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
  errorState: {
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.xl,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  errorTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
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
