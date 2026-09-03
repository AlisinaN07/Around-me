import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ContentCard } from '@/components/ContentCard';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { ReportModal } from '@/components/ReportModal';
import { SegmentedControl } from '@/components/SegmentedControl';
import { COUNTRIES } from '@/constants/countries';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { blockUser, isUserBlocked, unblockUser } from '@/services/blocks';
import { fetchPublicUserContent } from '@/services/content';
import { fetchFollowerCount, fetchFollowingCount, followUser, isFollowing, unfollowUser } from '@/services/following';
import { fetchConversation, getConversationId } from '@/services/messages';
import { fetchMyNewMessagesFrom } from '@/services/privacySettings';
import { fetchPublicProfile } from '@/services/publicProfile';
import { fetchProfileReels } from '@/services/reels';
import type { Content, ContentType } from '@/types/content';
import type { Reel } from '@/types/reel';
import type { PublicProfile } from '@/types/social';
import { formatCityDisplayName } from '@/utils/cityDisplay';

type LoadStatus = 'loading' | 'loaded' | 'error';
type ProfileTab = ContentType | 'reel';

const CONTENT_TABS: { id: ProfileTab; label: string; emptyText: string }[] = [
  { id: 'post', label: 'Posts', emptyText: 'No posts yet' },
  { id: 'activity', label: 'Activities', emptyText: 'No activities yet' },
  { id: 'event', label: 'Events', emptyText: 'No events yet' },
  { id: 'reel', label: 'Reels', emptyText: 'No Reels yet' },
];

export default function PublicProfileScreen() {
  const { uid } = useLocalSearchParams<{ uid: string }>();
  const { user } = useAuth();
  const isOwnProfile = user?.uid === uid;

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);
  const [amFollowing, setAmFollowing] = useState(false);
  const [isFollowSubmitting, setIsFollowSubmitting] = useState(false);
  const [followError, setFollowError] = useState<string | null>(null);
  const [content, setContent] = useState<Content[]>([]);
  const [reels, setReels] = useState<Reel[]>([]);
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
      const [publicProfile, followers, following, followingState, userContent, userReels, blockedByMe] = await Promise.all([
        fetchPublicProfile(uid),
        fetchFollowerCount(uid),
        fetchFollowingCount(uid),
        !isOwnProfile && user ? isFollowing(user.uid, uid) : Promise.resolve(false),
        // One mixed, limited query — then split into Posts/Activities/Events
        // tabs in-memory below, rather than running three separate queries
        // for a single profile page.
        fetchPublicUserContent(uid),
        // Reels are a separate root collection from content/{contentId}
        // (see src/types/reel.ts), so this is its own capped query, not
        // part of the mixed content query above.
        fetchProfileReels(uid),
        !isOwnProfile && user ? isUserBlocked(user.uid, uid) : Promise.resolve(false),
      ]);
      if (!publicProfile) {
        setStatus('error');
        return;
      }
      setProfile(publicProfile);
      setFollowerCount(followers);
      setFollowingCount(following);
      setAmFollowing(followingState);
      setContent(userContent);
      setReels(userReels);
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
  const countryLabel = COUNTRIES.find((country) => country.code === profile?.countryCode)?.name ?? '';
  const interestLabels = (profile?.interests ?? [])
    .map((id) => INTERESTS.find((interest) => interest.id === id)?.label)
    .filter((label): label is string => Boolean(label));

  const visibleContent = useMemo(
    () => (contentTab === 'reel' ? [] : content.filter((item) => item.type === contentTab)),
    [content, contentTab]
  );
  const activeTabInfo = CONTENT_TABS.find((tab) => tab.id === contentTab) ?? CONTENT_TABS[0];

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
        <View style={styles.centered}>
          <Text style={styles.mutedText}>Loading…</Text>
        </View>
      ) : status === 'error' || !profile ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.errorTitle}>Couldn&apos;t load this profile.</Text>
          <Button label="Try again" onPress={load} />
        </View>
      ) : (
        <View style={styles.container}>
          <View style={styles.header}>
            {!isOwnProfile ? (
              <Pressable
                onPress={() => setIsOptionsMenuOpen(true)}
                style={styles.overflowButton}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="More options"
              >
                <Ionicons name="ellipsis-horizontal" size={20} color={Colors.textSecondary} />
              </Pressable>
            ) : null}
            <Avatar name={profile.displayName} size={80} />
            <Text style={styles.displayName}>{profile.displayName}</Text>
            <Text style={styles.username}>@{profile.username}</Text>
            {cityLabel ? (
              <View style={styles.locationRow}>
                <Ionicons name="location" size={14} color={Colors.accent} />
                <Text style={styles.locationText}>
                  {cityLabel}
                  {countryLabel ? `, ${countryLabel}` : ''}
                </Text>
              </View>
            ) : null}
          </View>

          <View style={styles.countsRow}>
            <Pressable
              onPress={() => router.push(`/user/${uid}/followers`)}
              style={styles.countItem}
              accessibilityRole="button"
              accessibilityLabel={`${followerCount} followers`}
            >
              <Text style={styles.countValue}>{followerCount}</Text>
              <Text style={styles.countLabel}>Followers</Text>
            </Pressable>
            <Pressable
              onPress={() => router.push(`/user/${uid}/following`)}
              style={styles.countItem}
              accessibilityRole="button"
              accessibilityLabel={`${followingCount} following`}
            >
              <Text style={styles.countValue}>{followingCount}</Text>
              <Text style={styles.countLabel}>Following</Text>
            </Pressable>
          </View>

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

          {interestLabels.length > 0 && (
            <View style={styles.interestsSection}>
              <Text style={styles.interestsLabel}>Interests</Text>
              <Text style={styles.interestsValue}>{interestLabels.join(' · ')}</Text>
            </View>
          )}

          <View style={styles.contentSection}>
            <SegmentedControl
              options={CONTENT_TABS.map(({ id, label }) => ({ id, label }))}
              value={contentTab}
              onChange={setContentTab}
            />
            {contentTab === 'reel' ? (
              reels.length === 0 ? (
                <View style={styles.contentEmpty}>
                  <Text style={styles.contentEmptyText}>{activeTabInfo.emptyText}</Text>
                  {isOwnProfile ? (
                    <View style={styles.contentEmptyAction}>
                      <Button label="Create Reel" variant="secondary" onPress={() => router.push('/create/reel')} />
                    </View>
                  ) : null}
                </View>
              ) : (
                <View style={styles.reelGrid}>
                  {reels.map((reel) => (
                    <ReelPreviewCard key={reel.reelId} reel={reel} />
                  ))}
                </View>
              )
            ) : visibleContent.length === 0 ? (
              <View style={styles.contentEmpty}>
                <Text style={styles.contentEmptyText}>{activeTabInfo.emptyText}</Text>
              </View>
            ) : (
              <View style={styles.contentList}>
                {visibleContent.map((item) => (
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
  centered: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.xxl,
  },
  mutedText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  errorTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  container: {
    gap: Spacing.lg,
  },
  header: {
    alignItems: 'center',
    gap: 4,
  },
  overflowButton: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayName: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '800',
    marginTop: Spacing.sm,
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xs,
  },
  locationText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  countsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.xxl,
  },
  countItem: {
    alignItems: 'center',
    gap: 2,
  },
  countValue: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '800',
  },
  countLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
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
    borderRadius: Radius.full,
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
    borderRadius: Radius.full,
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
  interestsSection: {
    alignItems: 'center',
    gap: 4,
  },
  interestsLabel: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  interestsValue: {
    color: Colors.text,
    fontSize: 14,
    textAlign: 'center',
  },
  contentSection: {
    gap: Spacing.md,
  },
  contentEmpty: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: 'dashed',
    padding: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  contentEmptyAction: {
    minWidth: 160,
  },
  reelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: Spacing.sm,
  },
  contentEmptyText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  contentList: {
    // Cancels out HeaderScreenLayout's own paddingHorizontal so ContentCard's
    // built-in marginHorizontal is the only inset — matching how cards look
    // everywhere else they're used (Home, Following).
    marginHorizontal: -Spacing.xl,
  },
});
