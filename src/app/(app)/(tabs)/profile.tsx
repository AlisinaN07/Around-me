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
import type { Content, EventContent, PostContent } from '@/types/content';
import type { Reel } from '@/types/reel';
import { fetchFollowerCount, fetchFollowingCount } from '@/services/following';
import { fetchProfilePostCount, fetchPublicUserContent } from '@/services/content';
import { fetchProfileReelCount, fetchProfileReels } from '@/services/reels';
import { isBusinessAccount } from '@/utils/accountCapabilities';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { mergeProfilePosts } from '@/utils/profilePosts';

type LoadStatus = 'loading' | 'loaded' | 'error';
// Step 41.2C — unified Posts tab: 'reel' (video Post) and legacy text
// 'post' now merge into a single 'post' tab, so this is no longer a
// per-technical-type selector, just Posts vs. (Business-only) Events.
type ProfileTab = 'post' | 'event';

const PROFILE_TABS_PERSONAL: { id: ProfileTab; label: string }[] = [{ id: 'post', label: 'Posts' }];
const PROFILE_TABS_BUSINESS: { id: ProfileTab; label: string }[] = [
  { id: 'post', label: 'Posts' },
  { id: 'event', label: 'Events' },
];

// Bumped above fetchPublicUserContent's own DEFAULT_FEED_LIMIT (20) for
// profile use specifically — this one mixed fetch now backs both the
// unified Posts tab (its type=='post' items) and the Business Events tab
// (its type=='event' items), so a wider page reduces (without needing a
// new Firestore index) the chance that a Business account's own Events
// crowd their own text Posts out of the same bounded page. See the Step
// 41.2C spec's "conservative fixed per-source page size" guidance.
const PROFILE_CONTENT_LIMIT = 40;

const EMPTY_TEXT: Record<ProfileTab, string> = {
  post: 'No posts yet',
  event: 'No events yet',
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
  const [activeTab, setActiveTab] = useState<ProfileTab>('post');

  const load = useCallback(async () => {
    if (!user) return;
    setStatus('loading');
    try {
      const [followers, following, textPostCount, reelCount, userContent, userReels] = await Promise.all([
        fetchFollowerCount(user.uid),
        fetchFollowingCount(user.uid),
        // Two exact server-side aggregations, summed — see
        // fetchProfilePostCount's and fetchProfileReelCount's own doc
        // comments for why neither is ever derived from the bounded
        // mixed/Reel queries below. A failure here falls into the same
        // catch as every other profile fetch, so a failed count is never
        // shown as a confident (wrong) 0 — the whole screen shows its
        // error state instead.
        fetchProfilePostCount(user.uid),
        fetchProfileReelCount(user.uid),
        // One bounded, mixed query (see PROFILE_CONTENT_LIMIT) — split
        // into the unified Posts tab's text-Post half and the Business
        // Events tab in-memory below, rather than running separate
        // queries. The Posts TAB stays bounded by this same fetch (merged
        // with the separately-bounded Reels fetch below); only the Posts
        // STAT above is exact.
        fetchPublicUserContent(user.uid, PROFILE_CONTENT_LIMIT),
        fetchProfileReels(user.uid),
      ]);
      setFollowerCount(followers);
      setFollowingCount(following);
      setPostsCount(textPostCount + reelCount);
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
  const tabs = isBusinessAccount(profile) ? PROFILE_TABS_BUSINESS : PROFILE_TABS_PERSONAL;
  const textPosts = useMemo(() => content.filter((item): item is PostContent => item.type === 'post'), [content]);
  const businessEvents = useMemo(() => content.filter((item): item is EventContent => item.type === 'event'), [content]);
  const mergedPosts = useMemo(() => mergeProfilePosts(reels, textPosts), [reels, textPosts]);

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
                <ProfileTabBar tabs={tabs} value={activeTab} onChange={setActiveTab} />

                {activeTab === 'post' ? (
                  mergedPosts.length === 0 ? (
                    <EmptyState
                      bare
                      icon="albums-outline"
                      title={EMPTY_TEXT.post}
                      action={<Button label="Create post" variant="secondary" onPress={() => router.push('/create/reel')} />}
                    />
                  ) : (
                    <View style={styles.postsGrid}>
                      {mergedPosts.map((item) =>
                        item.kind === 'reel' ? (
                          <ReelPreviewCard key={`reel-${item.reel.reelId}`} reel={item.reel} />
                        ) : (
                          <View key={`text-${item.content.contentId}`} style={styles.fullRow}>
                            <ContentCard item={item.content} currentUid={user?.uid ?? null} />
                          </View>
                        )
                      )}
                    </View>
                  )
                ) : businessEvents.length === 0 ? (
                  <EmptyState bare icon="calendar-outline" title={EMPTY_TEXT.event} />
                ) : (
                  <View style={styles.contentList}>
                    {businessEvents.map((item) => (
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
  postsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: Spacing.sm,
  },
  fullRow: {
    width: '100%',
  },
  contentList: {
    gap: Spacing.md,
    marginHorizontal: -Spacing.lg,
  },
});
