import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ContentCard } from '@/components/ContentCard';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchFollowingFeed } from '@/services/content';
import { fetchFollowingCount } from '@/services/following';
import type { Content } from '@/types/content';

type LoadStatus = 'loading' | 'loaded' | 'error';

type FollowingFeedProps = {
  currentUid: string;
  cityKey: string;
  cityLabel: string;
  onExploreAround: () => void;
};

/**
 * Home's "Following" mode — a simple chronological timeline of content from
 * people the current user follows, scoped to one city (see
 * fetchFollowingFeed). Self-contained: fetches on mount/focus, no realtime
 * listener, pull-to-refresh. Deliberately much simpler than Around's Home
 * body — no Happening Now, no Local Reels, no category filters.
 */
export function FollowingFeed({ currentUid, cityKey, cityLabel, onExploreAround }: FollowingFeedProps) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [items, setItems] = useState<Content[]>([]);
  const [followingCount, setFollowingCount] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(
    async (isRefresh = false) => {
      if (isRefresh) {
        setIsRefreshing(true);
      } else {
        setStatus('loading');
      }
      try {
        const [count, feedItems, blockedUids] = await Promise.all([
          fetchFollowingCount(currentUid),
          fetchFollowingFeed({ currentUid, cityKey }),
          fetchMyBlockedUserIds(currentUid),
        ]);
        setFollowingCount(count);
        // Defensive only — blocking already removes the underlying follow
        // edge (see src/services/blocks.ts), so a blocked author's content
        // shouldn't reach this feed in the first place. This just covers
        // any gap between "no longer followed" and "already fetched."
        const blockedSet = new Set(blockedUids);
        setItems(blockedSet.size > 0 ? feedItems.filter((item) => !blockedSet.has(item.authorUid)) : feedItems);
        setStatus('loaded');
      } catch {
        setStatus('error');
      } finally {
        setIsRefreshing(false);
      }
    },
    [currentUid, cityKey]
  );

  // Fires on mount (this component only exists while "Following" is
  // selected, so mount = selection) and again every time Home regains
  // focus — covers returning here after following/unfollowing someone
  // from their public profile, without any realtime listener.
  useFocusEffect(
    useCallback(() => {
      load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentUid, cityKey])
  );

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        Platform.OS === 'web' ? undefined : (
          <RefreshControl refreshing={isRefreshing} onRefresh={() => load(true)} tintColor={Colors.accent} />
        )
      }
    >
      <View style={styles.page}>
        {status === 'loading' && items.length === 0 ? (
          <>
            <SkeletonBlock />
            <SkeletonBlock />
          </>
        ) : status === 'error' ? (
          <View style={styles.emptyPanel}>
            <Ionicons name="cloud-offline-outline" size={32} color={Colors.textSecondary} />
            <Text style={styles.emptyTitle}>Couldn&apos;t load Following</Text>
            <Button label="Try again" onPress={() => load()} />
          </View>
        ) : followingCount === 0 ? (
          <View style={styles.emptyPanel}>
            <Ionicons name="people-outline" size={32} color={Colors.textSecondary} />
            <Text style={styles.emptyTitle}>Your Following feed is empty</Text>
            <Text style={styles.emptyBody}>Follow people around {cityLabel} to see them here.</Text>
            <Button label="Explore Around" onPress={onExploreAround} />
          </View>
        ) : items.length === 0 ? (
          <View style={styles.emptyPanel}>
            <Ionicons name="location-outline" size={32} color={Colors.textSecondary} />
            <Text style={styles.emptyTitle}>Nothing from people you follow in {cityLabel} yet.</Text>
            <Text style={styles.emptyBody}>Check Around to discover what&apos;s happening.</Text>
          </View>
        ) : (
          items.map((item) => <ContentCard key={item.contentId} item={item} currentUid={currentUid} />)
        )}
      </View>
    </ScrollView>
  );
}

function SkeletonBlock() {
  return <View style={styles.skeleton} />;
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xxl,
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  emptyPanel: {
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
  emptyTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyBody: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'center',
  },
  skeleton: {
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    height: 110,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    opacity: 0.5,
  },
});
