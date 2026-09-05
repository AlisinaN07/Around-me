import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { ContentCard } from '@/components/ContentCard';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { InterestPills } from '@/components/InterestPills';
import { LoadingState } from '@/components/LoadingState';
import { ProfileHeader } from '@/components/ProfileHeader';
import { ProfileTabBar } from '@/components/ProfileTabBar';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { Colors, Layout, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import type { Content, ContentType } from '@/types/content';
import type { Reel } from '@/types/reel';
import { fetchFollowerCount, fetchFollowingCount } from '@/services/following';
import { fetchProfilePostCount, fetchPublicUserContent } from '@/services/content';
import { fetchProfileReels } from '@/services/reels';
import { formatCityDisplayName } from '@/utils/cityDisplay';

type LoadStatus = 'loading' | 'loaded' | 'error';
type ProfileTab = ContentType | 'reel';

const PROFILE_TABS: { id: ProfileTab; label: string }[] = [
  { id: 'reel', label: 'Reels' },
  { id: 'post', label: 'Posts' },
  { id: 'event', label: 'Events' },
  { id: 'activity', label: 'Activities' },
];

const EMPTY_TEXT: Record<ProfileTab, string> = {
  reel: 'No Reels yet',
  post: 'No posts yet',
  event: 'No events yet',
  activity: 'No activities yet',
};

/**
 * Own Profile — Step 27 visual reconstruction. Shares its visual language
 * (ProfileHeader/InterestPills/ProfileTabBar) with the public profile
 * route (src/app/(app)/user/[uid]/index.tsx) and reuses that screen's
 * exact data-fetch architecture (fetchPublicUserContent + fetchProfileReels
 * + real follower/following counts) rather than duplicating a second
 * profile-content pipeline — the two screens differ only in using the
 * caller's own private `profile` (via useProfile()) instead of a fetched
 * PublicProfile snapshot, and in which actions render (Settings here,
 * Follow/Message/block there).
 */
export default function ProfileScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [postsCount, setPostsCount] = useState(0);
  const [content, setContent] = useState<Content[]>([]);
  const [reels, setReels] = useState<Reel[]>([]);
  const [activeTab, setActiveTab] = useState<ProfileTab>('reel');

  const load = useCallback(async () => {
    if (!user) return;
    setStatus('loading');
    try {
      const [followers, following, posts, userContent, userReels] = await Promise.all([
        fetchFollowerCount(user.uid),
        fetchFollowingCount(user.uid),
        // Exact server-side aggregation — see fetchProfilePostCount's own
        // doc comment for why this is never derived from the bounded
        // mixed query below. A failure here falls into the same catch as
        // every other profile fetch, so a failed count is never shown as
        // a confident (wrong) 0 — the whole screen shows its error state
        // instead.
        fetchProfilePostCount(user.uid),
        // One bounded, mixed query — see fetchPublicUserContent's own
        // DEFAULT_FEED_LIMIT (20) — split into Posts/Events/Activities tabs
        // in-memory below rather than three separate queries. The Posts
        // TAB below intentionally stays bounded by this same query; only
        // the Posts STAT above is now exact.
        fetchPublicUserContent(user.uid),
        fetchProfileReels(user.uid),
      ]);
      setFollowerCount(followers);
      setFollowingCount(following);
      setPostsCount(posts);
      setContent(userContent);
      setReels(userReels);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.uid])
  );

  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : '';
  const visibleContent = useMemo(
    () => (activeTab === 'reel' ? [] : content.filter((item) => item.type === activeTab)),
    [content, activeTab]
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.page}>
          {status === 'error' ? (
            <View style={styles.statusPad}>
              <ErrorState title="Couldn't load your profile" onRetry={load} />
            </View>
          ) : status === 'loading' ? (
            <LoadingState size="large" />
          ) : (
            <>
              <ProfileHeader
                displayName={profile?.displayName ?? ''}
                username={profile?.username ?? ''}
                cityLabel={cityLabel}
                bio={profile?.bio}
                postsCount={postsCount}
                followersCount={followerCount}
                followingCount={followingCount}
                onPressFollowers={() => user && router.push(`/user/${user.uid}/followers`)}
                onPressFollowing={() => user && router.push(`/user/${user.uid}/following`)}
                headerRight={
                  <Pressable
                    onPress={() => router.push('/settings')}
                    style={styles.settingsButton}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel="Settings"
                  >
                    <Ionicons name="settings-outline" size={22} color={Colors.text} />
                  </Pressable>
                }
              />

              <View style={styles.editProfileButton}>
                <Button label="Edit profile" variant="secondary" onPress={() => router.push('/profile/edit')} />
              </View>

              {cityLabel ? (
                <Pressable
                  onPress={() => router.push('/cities')}
                  style={styles.exploreCityLink}
                  accessibilityRole="button"
                  accessibilityLabel="Explore another city"
                >
                  <Text style={styles.exploreCityLinkText}>Explore another city</Text>
                </Pressable>
              ) : null}

              <View style={styles.interestsSection}>
                <InterestPills interestIds={profile?.interests ?? []} />
              </View>

              <View style={styles.tabsSection}>
                <ProfileTabBar tabs={PROFILE_TABS} value={activeTab} onChange={setActiveTab} />

                {activeTab === 'reel' ? (
                  reels.length === 0 ? (
                    <EmptyState
                      bare
                      icon="videocam-outline"
                      title={EMPTY_TEXT.reel}
                      action={<Button label="Create Reel" variant="secondary" onPress={() => router.push('/create/reel')} />}
                    />
                  ) : (
                    <View style={styles.reelGrid}>
                      {reels.map((reel) => (
                        <ReelPreviewCard key={reel.reelId} reel={reel} />
                      ))}
                    </View>
                  )
                ) : visibleContent.length === 0 ? (
                  <EmptyState bare icon="albums-outline" title={EMPTY_TEXT[activeTab]} />
                ) : (
                  <View style={styles.contentList}>
                    {visibleContent.map((item) => (
                      <ContentCard key={item.contentId} item={item} currentUid={user?.uid ?? null} />
                    ))}
                  </View>
                )}
              </View>
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.lg,
  },
  statusPad: {
    paddingTop: Spacing.lg,
  },
  settingsButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editProfileButton: {
    alignSelf: 'center',
    width: '100%',
  },
  exploreCityLink: {
    alignSelf: 'center',
    marginTop: -Spacing.sm,
  },
  exploreCityLinkText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  interestsSection: {
    alignItems: 'center',
  },
  tabsSection: {
    gap: Spacing.md,
  },
  reelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: Spacing.sm,
  },
  contentList: {
    gap: Spacing.md,
    marginHorizontal: -Spacing.lg,
  },
});
