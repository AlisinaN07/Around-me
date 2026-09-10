import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { ContentCard } from '@/components/ContentCard';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { EventCard } from '@/components/EventCard';
import { InterestPills } from '@/components/InterestPills';
import { LoadingState } from '@/components/LoadingState';
import { ProfileHeader } from '@/components/ProfileHeader';
import { ProfileTabBar } from '@/components/ProfileTabBar';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { SoundSheet } from '@/components/SoundSheet';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import type { Content, EventContent, PostContent } from '@/types/content';
import type { Reel } from '@/types/reel';
import { fetchFollowerCount, fetchFollowingCount } from '@/services/following';
import { fetchProfilePostCount, fetchPublicUserContent } from '@/services/content';
import { fetchLifetimeLikedCount } from '@/services/profileLiked';
import { fetchProfileActivities, type ProfileActivity } from '@/services/profileActivities';
import { fetchProfileReelCount, fetchProfileReels } from '@/services/reels';
import { fetchProfileReposts, type RepostedPostItem } from '@/services/reposts';
import { fetchSavedPosts, type SavedPostItem } from '@/services/saved';
import { isBusinessAccount } from '@/utils/accountCapabilities';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { mergeProfilePosts } from '@/utils/profilePosts';

type LoadStatus = 'loading' | 'loaded' | 'error';
// Step 41.2C — unified Posts tab: 'reel' (video Post) and legacy text
// 'post' now merge into a single 'post' tab, so this is no longer a
// per-technical-type selector, just Posts vs. (Business-only) Events vs.
// 'repost' (Step 41.2F, PUBLIC) vs. 'activity' (Step 41.2G, PUBLIC — Events
// this profile owner marked Interested/Going, NOT the retired legacy
// content.type=='activity') vs. 'saved' (Step 41.2E, PRIVATE — own Profile
// only, never shown on the public profile route). Tab order is locked:
// Posts, Reposts, (Events), Activities, Saved.
type ProfileTab = 'post' | 'repost' | 'event' | 'activity' | 'saved';

const PROFILE_TABS_PERSONAL: { id: ProfileTab; label: string }[] = [
  { id: 'post', label: 'Posts' },
  { id: 'repost', label: 'Reposts' },
  { id: 'activity', label: 'Activities' },
  { id: 'saved', label: 'Saved' },
];
const PROFILE_TABS_BUSINESS: { id: ProfileTab; label: string }[] = [
  { id: 'post', label: 'Posts' },
  { id: 'repost', label: 'Reposts' },
  { id: 'event', label: 'Events' },
  { id: 'activity', label: 'Activities' },
  { id: 'saved', label: 'Saved' },
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
  repost: 'No reposts yet',
  event: 'No events yet',
  activity: 'No activities yet',
  saved: 'No saved posts yet',
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
  // Whether THIS screen is the one currently on top — see
  // soundSheetReel's own doc comment and the SoundSheet render below.
  const isScreenFocused = useIsFocused();
  const { profile } = useProfile();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [postsCount, setPostsCount] = useState(0);
  // Step 41.2H.4 — undefined means "not (yet) ready/available", never a
  // fake 0; see ProfileHeader's likedCount doc comment.
  const [likedCount, setLikedCount] = useState<number | undefined>(undefined);
  const [content, setContent] = useState<Content[]>([]);
  const [reels, setReels] = useState<Reel[]>([]);
  const [repostedPosts, setRepostedPosts] = useState<RepostedPostItem[]>([]);
  const [activities, setActivities] = useState<ProfileActivity[]>([]);
  const [savedPosts, setSavedPosts] = useState<SavedPostItem[]>([]);
  // The sound sheet, opened from a saved 'sound' card below — SoundSheet
  // takes a real Reel (see its own doc comment); a saved sound's
  // originReel already carries a real musicHash/soundOriginAuthorUid.
  // Deliberately NOT reset when this screen loses focus (tapping a post
  // inside the sheet's own grid pushes the reel detail screen on top) —
  // isScreenFocused above is what actually hides the Modal while away,
  // so navigating back here reveals this exact sheet again.
  const [soundSheetReel, setSoundSheetReel] = useState<Reel | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 2500);
  }, []);
  const [activeTab, setActiveTab] = useState<ProfileTab>('post');

  const load = useCallback(async () => {
    if (!user) return;
    setStatus('loading');
    try {
      const [followers, following, textPostCount, reelCount, likedResult, userContent, userReels, userReposts, userActivities, userSavedPosts] =
        await Promise.all([
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
          // Step 41.2H.4 — the ONE stat allowed to be simply absent for a
          // given load: fetchLifetimeLikedCount never throws (see its own
          // doc comment), so its presence here doesn't put Liked on the
          // same all-or-nothing footing as the counts above.
          fetchLifetimeLikedCount(user.uid),
          // One bounded, mixed query (see PROFILE_CONTENT_LIMIT) — split
          // into the unified Posts tab's text-Post half and the Business
          // Events tab in-memory below, rather than running separate
          // queries. The Posts TAB stays bounded by this same fetch (merged
          // with the separately-bounded Reels fetch below); only the Posts
          // STAT above is exact.
          fetchPublicUserContent(user.uid, PROFILE_CONTENT_LIMIT),
          fetchProfileReels(user.uid),
          // PUBLIC (Step 41.2F) — same query a visitor's public profile view
          // would run for this uid; fetched here unconditionally like every
          // other tab's data, regardless of which tab is currently active.
          fetchProfileReposts(user.uid),
          // PUBLIC (Step 41.2G) — one bounded collectionGroup query; see
          // fetchProfileActivities' own doc comment.
          fetchProfileActivities(user.uid),
          // Private to this account (Step 41.2E) — fetched here unconditionally,
          // same as every other own-Profile tab's data, regardless of which tab
          // is currently active; never fetched on the public profile route.
          fetchSavedPosts(user.uid),
        ]);
      setFollowerCount(followers);
      setFollowingCount(following);
      setPostsCount(textPostCount + reelCount);
      setLikedCount(likedResult.ready ? likedResult.likedCount : undefined);
      setContent(userContent);
      setReels(userReels);
      setRepostedPosts(userReposts);
      setActivities(userActivities);
      setSavedPosts(userSavedPosts);
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
                photoURL={profile?.photoURL}
                coverPhotoURL={profile?.coverPhotoURL}
                coverEdgeInset={Spacing.lg}
                postsCount={postsCount}
                followersCount={followerCount}
                followingCount={followingCount}
                likedCount={likedCount}
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
                      action={<Button label="Create post" variant="secondary" onPress={() => router.push('/create/reel/camera')} />}
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
                ) : activeTab === 'repost' ? (
                  repostedPosts.length === 0 ? (
                    <EmptyState bare icon="repeat-outline" title={EMPTY_TEXT.repost} body="Posts you repost will appear here." />
                  ) : (
                    <View style={styles.postsGrid}>
                      {repostedPosts.map((item) =>
                        item.kind === 'reel' ? (
                          <ReelPreviewCard key={`repost-reel-${item.repostId}`} reel={item.reel} />
                        ) : (
                          <View key={`repost-text-${item.repostId}`} style={styles.fullRow}>
                            <ContentCard item={item.content} currentUid={user?.uid ?? null} />
                          </View>
                        )
                      )}
                    </View>
                  )
                ) : activeTab === 'event' ? (
                  businessEvents.length === 0 ? (
                    <EmptyState bare icon="calendar-outline" title={EMPTY_TEXT.event} />
                  ) : (
                    <View style={styles.contentList}>
                      {businessEvents.map((item) => (
                        <ContentCard key={item.contentId} item={item} currentUid={user?.uid ?? null} />
                      ))}
                    </View>
                  )
                ) : activeTab === 'activity' ? (
                  activities.length === 0 ? (
                    <EmptyState
                      bare
                      icon="star-outline"
                      title={EMPTY_TEXT.activity}
                      body="Events you're interested in or going to will appear here."
                    />
                  ) : (
                    <View style={styles.contentList}>
                      {activities.map(({ event, responseStatus }) => (
                        <EventCard key={event.contentId} item={event} variant="row" responseStatus={responseStatus} />
                      ))}
                    </View>
                  )
                ) : savedPosts.length === 0 ? (
                  <EmptyState bare icon="bookmark-outline" title={EMPTY_TEXT.saved} body="Posts you save will appear here." />
                ) : (
                  <View style={styles.postsGrid}>
                    {savedPosts.map((item) =>
                      item.kind === 'reel' ? (
                        <ReelPreviewCard key={`saved-reel-${item.savedId}`} reel={item.reel} />
                      ) : item.kind === 'sound' ? (
                        <View key={`saved-sound-${item.savedId}`} style={styles.soundCard}>
                          <ReelPreviewCard
                            reel={item.originReel}
                            onPress={() => setSoundSheetReel(item.originReel)}
                            style={styles.soundCardThumbnail}
                          />
                          <View style={styles.soundCardBadge} pointerEvents="none">
                            <Ionicons name="musical-notes" size={12} color={Colors.text} />
                            <Text style={styles.soundCardBadgeText}>{item.postCount}</Text>
                          </View>
                        </View>
                      ) : (
                        <View key={`saved-text-${item.savedId}`} style={styles.fullRow}>
                          <ContentCard item={item.content} currentUid={user?.uid ?? null} />
                        </View>
                      )
                    )}
                  </View>
                )}
              </View>
            </>
          )}
        </View>
      </ScrollView>

      {soundSheetReel ? (
        // isScreenFocused, not just soundSheetReel alone — see its own
        // doc comment: this is what hides the Modal while a post tapped
        // inside it is open full-screen, and reveals it again on the way
        // back rather than requiring soundSheetReel to be re-set.
        <SoundSheet visible={isScreenFocused} reel={soundSheetReel} onClose={() => setSoundSheetReel(null)} onToast={showToast} />
      ) : null}

      {toastMessage ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}
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
  interestsSection: {
    alignItems: 'center',
  },
  tabsSection: {
    gap: Spacing.md,
  },
  // flex-start + an explicit columnGap, not space-between — with
  // space-between, any row that isn't completely full (the very last row
  // almost always, and this screen's only 1-2 total Posts case entirely)
  // stretches its few items across the full row width with a big gap in
  // the middle instead of packing them from the left like a real grid.
  postsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    columnGap: Spacing.sm,
    rowGap: Spacing.sm,
  },
  fullRow: {
    width: '100%',
  },
  soundCard: {
    width: '31%',
    aspectRatio: 9 / 16,
    position: 'relative',
  },
  // Overrides ReelPreviewCard's own default 31%-of-parent width — here its
  // parent is soundCard above, which already carries the real 31% (of the
  // grid), so the card itself just fills that wrapper completely.
  soundCardThumbnail: {
    width: '100%',
  },
  soundCardBadge: {
    position: 'absolute',
    bottom: Spacing.xs,
    right: Spacing.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(11, 11, 15, 0.7)',
    borderRadius: Radius.full,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  soundCardBadgeText: {
    color: Colors.text,
    fontSize: 10,
    fontWeight: '700',
  },
  toast: {
    position: 'absolute',
    bottom: Spacing.xxl,
    alignSelf: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.9)',
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  toastText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  contentList: {
    gap: Spacing.md,
    marginHorizontal: -Spacing.lg,
  },
});
