import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContentCard } from '@/components/ContentCard';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { InterestPills } from '@/components/InterestPills';
import { LoadingState } from '@/components/LoadingState';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ProfileHeader } from '@/components/ProfileHeader';
import { ProfileTabBar } from '@/components/ProfileTabBar';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { ReportModal } from '@/components/ReportModal';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { blockUser, isUserBlocked, unblockUser } from '@/services/blocks';
import { fetchProfilePostCount, fetchPublicUserContent } from '@/services/content';
import { fetchFollowerCount, fetchFollowingCount, followUser, isFollowing, unfollowUser } from '@/services/following';
import { fetchConversation, getConversationId } from '@/services/messages';
import { fetchMyNewMessagesFrom } from '@/services/privacySettings';
import { fetchPublicProfile } from '@/services/publicProfile';
import { fetchProfileReelCount, fetchProfileReels } from '@/services/reels';
import { fetchProfileReposts, type RepostedPostItem } from '@/services/reposts';
import type { Content, EventContent, PostContent } from '@/types/content';
import type { Reel } from '@/types/reel';
import type { PublicProfile } from '@/types/social';
import { isBusinessAccount } from '@/utils/accountCapabilities';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { mergeProfilePosts } from '@/utils/profilePosts';

type LoadStatus = 'loading' | 'loaded' | 'error';
// Step 41.2C — unified Posts tab: 'reel' (video Post) and legacy text
// 'post' now merge into a single 'post' tab, so this is no longer a
// per-technical-type selector, just Posts vs. 'repost' (Step 41.2F, PUBLIC
// — shown here too) vs. (Business-only) Events. Saved (Step 41.2E) is
// PRIVATE and never appears on this public profile route. Tab order is
// locked: Posts, Reposts, (Events).
type ProfileTab = 'post' | 'repost' | 'event';

const PROFILE_TABS_PERSONAL: { id: ProfileTab; label: string }[] = [
  { id: 'post', label: 'Posts' },
  { id: 'repost', label: 'Reposts' },
];
const PROFILE_TABS_BUSINESS: { id: ProfileTab; label: string }[] = [
  { id: 'post', label: 'Posts' },
  { id: 'repost', label: 'Reposts' },
  { id: 'event', label: 'Events' },
];

// See src/app/(app)/(tabs)/profile.tsx's own PROFILE_CONTENT_LIMIT doc
// comment — identical reasoning, kept as a separate local constant since
// this is a separate screen with its own bounded mixed fetch.
const PROFILE_CONTENT_LIMIT = 40;

const EMPTY_TEXT: Record<ProfileTab, string> = {
  post: 'No posts yet',
  repost: 'No reposts yet',
  event: 'No events yet',
};

/**
 * Public profile — Step 27 visual reconstruction. Shares ProfileHeader/
 * InterestPills/ProfileTabBar with the own-Profile tab
 * (src/app/(app)/(tabs)/profile.tsx) so the two read as one visual system
 * (Step 27 Section 19) — all data-fetching and Follow/Message/Block/Report
 * logic below is unchanged from before this step, only the render layer
 * was rebuilt.
 */
export default function PublicProfileScreen() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const { user } = useAuth();
  const isOwnProfile = user?.uid === uid;

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [postsCount, setPostsCount] = useState(0);
  const [amFollowing, setAmFollowing] = useState(false);
  const [isFollowSubmitting, setIsFollowSubmitting] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [content, setContent] = useState<Content[]>([]);
  const [reels, setReels] = useState<Reel[]>([]);
  const [repostedPosts, setRepostedPosts] = useState<RepostedPostItem[]>([]);
  const [contentTab, setContentTab] = useState<ProfileTab>('post');

  // Safety state — see src/services/blocks.ts / privacySettings.ts.
  // canMessage is only ever used to proactively enable/disable the
  // Message button before a Conversation exists; Firestore rules
  // independently re-enforce all of this on the actual write.
  const [amIBlockingThem, setAmIBlockingThem] = useState(false);
  const [canMessage, setCanMessage] = useState(true);
  const [isBlockSubmitting, setIsBlockSubmitting] = useState(false);
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
  const [isBlockConfirmOpen, setIsBlockConfirmOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    try {
      const [publicProfile, followers, following, textPostCount, reelCount, followingState, userContent, userReels, userReposts, blockedByMe] =
        await Promise.all([
          fetchPublicProfile(uid),
          fetchFollowerCount(uid),
          fetchFollowingCount(uid),
          // Two exact server-side aggregations, summed — see
          // fetchProfilePostCount's and fetchProfileReelCount's own doc
          // comments. A failure here falls into the same catch as every
          // other profile fetch below, so a failed count is never shown as
          // a confident (wrong) 0 — the whole screen shows its error state
          // instead, same as an own-profile load failure.
          fetchProfilePostCount(uid),
          fetchProfileReelCount(uid),
          !isOwnProfile && user ? isFollowing(user.uid, uid) : Promise.resolve(false),
          // One mixed, bounded query (see PROFILE_CONTENT_LIMIT) — split into
          // the unified Posts tab's text-Post half and the Business Events
          // tab in-memory below, rather than running separate queries. This
          // stays bounded on purpose; only the Posts STAT above is exact.
          fetchPublicUserContent(uid, PROFILE_CONTENT_LIMIT),
          // Reels are a separate root collection from content/{contentId}
          // (see src/types/reel.ts), so this is its own capped query, not
          // part of the mixed content query above.
          fetchProfileReels(uid),
          // PUBLIC (Step 41.2F) — reposts/{repostId} is a public root
          // collection, so this uid's Reposts are fetched exactly the same
          // way whether this is the caller's own profile or someone else's.
          fetchProfileReposts(uid),
          !isOwnProfile && user ? isUserBlocked(user.uid, uid) : Promise.resolve(false),
        ]);
      if (!publicProfile) {
        setStatus('error');
        return;
      }
      setProfile(publicProfile);
      setFollowerCount(followers);
      setFollowingCount(following);
      setPostsCount(textPostCount + reelCount);
      setAmFollowing(followingState);
      setContent(userContent);
      setReels(userReels);
      setRepostedPosts(userReposts);
      setAmIBlockingThem(blockedByMe);

      if (!isOwnProfile && user && !blockedByMe) {
        // Before an existing Conversation exists, the Message button must
        // respect the target's message privacy setting (see
        // src/types/privacy.ts) — but an ALREADY-existing conversation is
        // always continuable regardless of that setting (only a Block
        // stops it — see firestore.rules' isValidConversationSend).
        const [existingConversation, targetPrivacy, targetFollowsMe] = await Promise.all([
          fetchConversation(getConversationId(user.uid, uid)),
          fetchMyNewMessagesFrom(uid),
          isFollowing(uid, user.uid),
        ]);
        setCanMessage(
          existingConversation !== null || targetPrivacy === 'everyone' || (targetPrivacy === 'people_i_follow' && targetFollowsMe)
        );
      } else {
        setCanMessage(true);
      }

      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [uid, user, isOwnProfile]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleToggleFollow = async () => {
    if (!user || isFollowSubmitting) return;
    setIsFollowSubmitting(true);
    setFollowError(null);
    const result = amFollowing ? await unfollowUser(user.uid, uid) : await followUser(user.uid, uid);
    setIsFollowSubmitting(false);
    if (!result.ok) {
      setFollowError(result.message);
      return;
    }
    const [followers, followingState] = await Promise.all([fetchFollowerCount(uid), isFollowing(user.uid, uid)]);
    setFollowerCount(followers);
    setAmFollowing(followingState);
  };

  const handleConfirmBlock = async () => {
    if (!user || isBlockSubmitting) return;
    setIsBlockSubmitting(true);
    const result = await blockUser(user.uid, uid);
    setIsBlockSubmitting(false);
    setIsBlockConfirmOpen(false);
    if (!result.ok) {
      setFollowError(result.message);
      return;
    }
    await load();
  };

  const handleUnblock = async () => {
    if (!user || isBlockSubmitting) return;
    setIsBlockSubmitting(true);
    const result = await unblockUser(user.uid, uid);
    setIsBlockSubmitting(false);
    if (!result.ok) {
      setFollowError(result.message);
      return;
    }
    await load();
  };

  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : '';
  const tabs = isBusinessAccount(profile) ? PROFILE_TABS_BUSINESS : PROFILE_TABS_PERSONAL;
  const textPosts = useMemo(() => content.filter((item): item is PostContent => item.type === 'post'), [content]);
  const businessEvents = useMemo(() => content.filter((item): item is EventContent => item.type === 'event'), [content]);
  const mergedPosts = useMemo(() => mergeProfilePosts(reels, textPosts), [reels, textPosts]);

  const optionsMenuOptions: OptionsMenuOption[] = amIBlockingThem
    ? [
        { label: `Unblock ${profile?.displayName ?? 'this user'}`, onPress: handleUnblock },
        { label: 'Report user', onPress: () => setIsReportOpen(true) },
      ]
    : [
        { label: `Block ${profile?.displayName ?? 'this user'}`, onPress: () => setIsBlockConfirmOpen(true), destructive: true },
        { label: 'Report user', onPress: () => setIsReportOpen(true) },
      ];

  return (
    <HeaderScreenLayout title={profile ? `@${profile.username}` : 'Profile'}>
      {status === 'loading' ? (
        <LoadingState size="large" />
      ) : status === 'error' || !profile ? (
        <ErrorState title="Couldn't load this profile" onRetry={load} />
      ) : (
        <View style={styles.container}>
          <ProfileHeader
            displayName={profile.displayName}
            username={profile.username}
            cityLabel={cityLabel}
            bio={profile.bio}
            postsCount={postsCount}
            followersCount={followerCount}
            followingCount={followingCount}
            onPressFollowers={() => router.push(`/user/${uid}/followers`)}
            onPressFollowing={() => router.push(`/user/${uid}/following`)}
            headerRight={
              !isOwnProfile ? (
                <Pressable
                  onPress={() => setIsOptionsMenuOpen(true)}
                  style={styles.overflowButton}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="More options"
                >
                  <Ionicons name="ellipsis-horizontal" size={20} color={Colors.textSecondary} />
                </Pressable>
              ) : undefined
            }
          />

          {followError ? <Text style={styles.errorText}>{followError}</Text> : null}

          {isOwnProfile ? (
            <View style={styles.selfBadge}>
              <Text style={styles.selfBadgeText}>This is you</Text>
            </View>
          ) : amIBlockingThem ? (
            <View style={styles.blockedRow}>
              <View style={styles.blockedBadge}>
                <Text style={styles.blockedBadgeText}>Blocked</Text>
              </View>
              <View style={styles.actionButton}>
                <Button label="Unblock" variant="secondary" onPress={handleUnblock} loading={isBlockSubmitting} />
              </View>
            </View>
          ) : (
            <View style={styles.actionsColumn}>
              <View style={styles.actionsRow}>
                <View style={styles.actionButton}>
                  <Button
                    label={amFollowing ? 'Following' : 'Follow'}
                    variant={amFollowing ? 'secondary' : 'primary'}
                    onPress={handleToggleFollow}
                    loading={isFollowSubmitting}
                  />
                </View>
                <View style={styles.actionButton}>
                  <Button label="Message" variant="secondary" onPress={() => router.push(`/chat/${uid}`)} disabled={!canMessage} />
                </View>
              </View>
              {!canMessage ? <Text style={styles.messageHint}>This person isn&apos;t accepting new conversations right now.</Text> : null}
            </View>
          )}

          <InterestPills interestIds={profile.interests} />

          <View style={styles.contentSection}>
            <ProfileTabBar tabs={tabs} value={contentTab} onChange={setContentTab} />

            {contentTab === 'post' ? (
              mergedPosts.length === 0 ? (
                <EmptyState
                  bare
                  icon="albums-outline"
                  title={EMPTY_TEXT.post}
                  action={
                    isOwnProfile ? <Button label="Create post" variant="secondary" onPress={() => router.push('/create/reel/camera')} /> : undefined
                  }
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
            ) : contentTab === 'repost' ? (
              repostedPosts.length === 0 ? (
                <EmptyState bare icon="repeat-outline" title={EMPTY_TEXT.repost} />
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
        </View>
      )}

      <OptionsMenu visible={isOptionsMenuOpen} onClose={() => setIsOptionsMenuOpen(false)} options={optionsMenuOptions} />

      <ConfirmDialog
        visible={isBlockConfirmOpen}
        title={`Block ${profile?.displayName ?? 'this user'}?`}
        message="They won't be able to follow, like or comment on your content, or message you while blocked."
        confirmLabel="Block"
        isSubmitting={isBlockSubmitting}
        onConfirm={handleConfirmBlock}
        onCancel={() => setIsBlockConfirmOpen(false)}
      />

      {user ? (
        <ReportModal
          visible={isReportOpen}
          onClose={() => setIsReportOpen(false)}
          reporterUid={user.uid}
          target={{ type: 'user', targetUid: uid }}
        />
      ) : null}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.lg,
  },
  overflowButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  actionsColumn: {
    gap: Spacing.xs,
  },
  actionsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  actionButton: {
    flex: 1,
  },
  messageHint: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
  blockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  blockedBadge: {
    borderRadius: 999,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.error,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  blockedBadgeText: {
    color: Colors.error,
    fontSize: 13,
    fontWeight: '700',
  },
  selfBadge: {
    alignSelf: 'center',
    borderRadius: 999,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  selfBadgeText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  contentSection: {
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
    // Cancels out HeaderScreenLayout's own paddingHorizontal so ContentCard's
    // built-in marginHorizontal is the only inset — matching how cards look
    // everywhere else they're used (Home, Following).
    marginHorizontal: -Spacing.xl,
  },
});
