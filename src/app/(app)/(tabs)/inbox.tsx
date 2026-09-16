import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { ConversationRow } from '@/components/ConversationRow';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { NotificationRow } from '@/components/NotificationRow';
import { SkeletonBlock } from '@/components/LoadingState';
import { Colors, Layout, Radius, Spacing, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchFollowingUids } from '@/services/following';
import { fetchConversations, otherParticipantUid } from '@/services/messages';
import { fetchNotifications, markAllNotificationsRead, markNotificationRead } from '@/services/notifications';
import { fetchPublicProfile } from '@/services/publicProfile';
import { fetchActiveStoriesForFollowing, hasViewedStory } from '@/services/stories';
import type { Conversation } from '@/types/message';
import type { Notification } from '@/types/notification';
import type { PublicProfile } from '@/types/social';
import type { StoryGroup } from '@/types/story';
import { prefetchImageOnce } from '@/utils/imagePrefetch';

type InboxMode = 'activity' | 'messages';
type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Inbox — Step 28 visual reconstruction. Real product model preserved
 * exactly: Activity (notifications) and Messages (1-to-1 conversations)
 * are the only two modes — never renamed to "Primary"/"Groups" from the
 * reference, since Groups doesn't exist. No Requests row, no online
 * presence — neither has real backend support (see README "Inbox — Step
 * 28"). Shown under the header, above the mode tabs, regardless of mode:
 * FollowingAvatarRow — your own profile, then everyone you follow, left
 * to right. This is now ALSO where Stories live (there is no separate
 * tray on Home any more — see src/app/(app)/story/[uid].tsx) — anyone in
 * the row with a currently-active Story (src/types/story.ts) gets a
 * colored ring and opens the full-screen viewer on tap; everyone else
 * just opens a chat with them (or, for your own avatar, your Profile
 * tab), same as before Stories existed.
 */
export default function InboxScreen() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [mode, setMode] = useState<InboxMode>('messages');

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [messagesStatus, setMessagesStatus] = useState<LoadStatus>('loading');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [otherProfiles, setOtherProfiles] = useState<Record<string, PublicProfile | null>>({});
  const [isMessagesRefreshing, setIsMessagesRefreshing] = useState(false);
  const [messageQuery, setMessageQuery] = useState('');

  const [myProfile, setMyProfile] = useState<PublicProfile | null>(null);
  const [followingProfiles, setFollowingProfiles] = useState<PublicProfile[]>([]);
  // One entry per uid (self included) that currently has an active Story —
  // see src/types/story.ts. Absent from this map at all means "no active
  // Story," the ordinary case for most people in the row.
  const [storyGroupByUid, setStoryGroupByUid] = useState<Map<string, StoryGroup>>(new Map());
  // Every uid (self included) whose CURRENT Story group still has at
  // least one Story you (the viewer) haven't watched yet — the colored
  // vs. gray ring distinction in FollowingAvatarRow. A uid only leaves
  // this set once every Story in its group has a real view doc for you
  // (see hasViewedStory in src/services/stories.ts) — watching some but
  // not all of a group's Stories still shows it as unseen, same as every
  // real Stories feature.
  const [unseenAuthorUids, setUnseenAuthorUids] = useState<Set<string>>(new Set());

  // Whether this row's own fetch is currently in flight — a silent
  // revalidate skips entirely rather than overlap one already running
  // (see the useFocusEffect below for the full stale-while-revalidate
  // pattern, same one already proven on Home/Events/Profile). This row
  // has no dedicated loading/error UI of its own (it just quietly
  // populates whenever data arrives), so the only thing `silent` changes
  // here is this overlap guard — there's no status to avoid touching.
  const isFollowingRowInFlightRef = useRef(false);
  const loadFollowingRow = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!uid) return;
      const silent = options?.silent ?? false;
      if (silent && isFollowingRowInFlightRef.current) return;
      isFollowingRowInFlightRef.current = true;
      try {
        const [me, followedUids, activeStoryGroups] = await Promise.all([
          fetchPublicProfile(uid),
          fetchFollowingUids(uid),
          fetchActiveStoriesForFollowing(uid),
        ]);
        setMyProfile(me);
        // Phase 3 perf pass — reuses the Phase 2 public-profile cache
        // above (no extra Firestore read just for this); only warms RN's
        // own image cache for a photo already in hand. myProfile's own
        // avatar is the leftmost item in this same row, so it's included
        // too.
        prefetchImageOnce(me?.photoURL);
        // Bounded by fetchFollowingUids' own default limit — same bounded
        // Promise.all reasoning as loadMessages' own otherProfiles fetch below.
        const profiles = await Promise.all(followedUids.map((followedUid) => fetchPublicProfile(followedUid)));
        const followedProfiles = profiles.filter((profile): profile is PublicProfile => profile !== null);
        setFollowingProfiles(followedProfiles);
        followedProfiles.forEach((profile) => prefetchImageOnce(profile.photoURL));
        setStoryGroupByUid(new Map(activeStoryGroups.map((group) => [group.authorUid, group])));

        // One hasViewedStory call per active Story across every group shown
        // in this row — small and bounded, same read-cost shape as
        // everything else here. A group counts as "unseen" the moment ANY
        // of its Stories comes back unwatched.
        const unseen = new Set<string>();
        await Promise.all(
          activeStoryGroups.map(async (group) => {
            for (const story of group.stories) {
              const seen = await hasViewedStory(story.storyId, uid);
              if (!seen) {
                unseen.add(group.authorUid);
                return;
              }
            }
          })
        );
        setUnseenAuthorUids(unseen);
      } catch {
        // This row never had a dedicated error state before this pattern
        // existed — a failed refresh (silent or not) just leaves it
        // showing whatever it last successfully loaded, same as it
        // already implicitly did.
      } finally {
        isFollowingRowInFlightRef.current = false;
      }
    },
    [uid]
  );

  // Whether notifications/messages are currently in flight — same overlap
  // guard as loadFollowingRow's own isFollowingRowInFlightRef above, and
  // the same pattern already proven on Home/Events/Profile: a silent call
  // skips entirely rather than overlap one already running (covers both
  // "two silent revalidates overlap" from rapidly leaving/returning, and
  // "a silent revalidate fires before the very first real load has even
  // resolved"). Neither a pull-to-refresh nor an explicit retry ever
  // checks this — an explicit user action is never silently dropped.
  const isNotificationsInFlightRef = useRef(false);
  const isMessagesInFlightRef = useRef(false);

  /**
   * `isRefresh`/`silent` are mutually exclusive and cover Inbox's whole
   * stale-while-revalidate behavior, same shape as Home/Events/Profile's
   * own `{silent?: boolean}` (isRefresh is Inbox-specific: it already
   * existed here, wired to the real pull-to-refresh spinner). Plain call
   * (neither flag): a REAL load — sets `status` to 'loading', used for the
   * first-ever load and ErrorState's Try again. `isRefresh: true`: pull-
   * to-refresh — sets `isRefreshing` (the RefreshControl spinner) instead
   * of `status`, still a real refetch. `silent: true`: a background
   * revalidate — touches neither `status` nor `isRefreshing`, so nothing
   * currently on screen changes while this refetches behind it; on
   * success it updates `notifications` in place, and on failure it leaves
   * whatever's already shown untouched rather than surfacing the error
   * state over content that was working a moment ago.
   */
  const load = useCallback(
    async (options?: { isRefresh?: boolean; silent?: boolean }) => {
      if (!uid) {
        return;
      }
      const isRefresh = options?.isRefresh ?? false;
      const silent = options?.silent ?? false;
      if (silent && isNotificationsInFlightRef.current) return;
      isNotificationsInFlightRef.current = true;
      if (isRefresh) {
        setIsRefreshing(true);
      } else if (!silent) {
        setStatus('loading');
      }
      try {
        const items = await fetchNotifications(uid);
        setNotifications(items);
        setStatus('loaded');
      } catch {
        if (!silent) setStatus('error');
      } finally {
        setIsRefreshing(false);
        isNotificationsInFlightRef.current = false;
      }
    },
    [uid]
  );

  const loadMessages = useCallback(
    async (options?: { isRefresh?: boolean; silent?: boolean }) => {
      if (!uid) {
        return;
      }
      const isRefresh = options?.isRefresh ?? false;
      const silent = options?.silent ?? false;
      if (silent && isMessagesInFlightRef.current) return;
      isMessagesInFlightRef.current = true;
      if (isRefresh) {
        setIsMessagesRefreshing(true);
      } else if (!silent) {
        setMessagesStatus('loading');
      }
      try {
        const items = await fetchConversations(uid);
        // Capped at DEFAULT_CONVERSATIONS_LIMIT (30) by fetchConversations,
        // so this is a bounded Promise.all, never an unbounded fan-out.
        const otherUids = items.map((conversation) => otherParticipantUid(conversation, uid));
        const profiles = await Promise.all(otherUids.map((otherUid) => fetchPublicProfile(otherUid)));
        const profilesByUid: Record<string, PublicProfile | null> = {};
        otherUids.forEach((otherUid, index) => {
          profilesByUid[otherUid] = profiles[index] ?? null;
        });
        setConversations(items);
        setOtherProfiles(profilesByUid);
        // Phase 3 perf pass — same reasoning as loadFollowingRow's own
        // prefetch above: reuses these already-fetched profiles, no extra
        // Firestore read, only warms RN's own image cache for this
        // already-bounded (DEFAULT_CONVERSATIONS_LIMIT) page of rows.
        profiles.forEach((profile) => prefetchImageOnce(profile?.photoURL));
        setMessagesStatus('loaded');
      } catch {
        if (!silent) setMessagesStatus('error');
      } finally {
        setIsMessagesRefreshing(false);
        isMessagesInFlightRef.current = false;
      }
    },
    [uid]
  );

  // Stale-while-revalidate — same key-comparison pattern already proven on
  // Home/Events/Profile (see their own doc comments). Inbox has no
  // scope/city dimension the way those do — just the account itself — so
  // the key is `uid` alone. First focus for a uid (fresh sign-in, or the
  // very first mount): a real load for all three, the skeleton is
  // expected then. Every later refocus with the SAME uid (the ordinary
  // "tapped a notification/conversation, came back" case): a silent
  // background revalidate instead — notifications/messages/the following
  // row all stay showing exactly as they were while this refetches
  // quietly behind them. A genuine account switch (uid actually changes)
  // still gets a real load for all three, same as before.
  const loadedUidRef = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!uid) return;
      if (loadedUidRef.current !== uid) {
        loadedUidRef.current = uid;
        load();
        loadMessages();
        loadFollowingRow();
      } else {
        load({ silent: true });
        loadMessages({ silent: true });
        loadFollowingRow({ silent: true });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uid])
  );

  const unreadIds = notifications.filter((item) => !item.read).map((item) => item.notificationId);

  const totalUnreadMessages = useMemo(
    () => (uid ? conversations.reduce((sum, conversation) => sum + (conversation.unreadCounts[uid] ?? 0), 0) : 0),
    [conversations, uid]
  );

  // Local-only filter over the already-fetched, bounded conversation list
  // (Step 28 Section 7/28) — never a new Firestore query, no debounce
  // needed since it's just an in-memory Array.filter. Matches the other
  // user's real displayName/username or the real last-message preview.
  const filteredConversations = useMemo(() => {
    const q = messageQuery.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter((conversation) => {
      const otherProfile = otherProfiles[otherParticipantUid(conversation, uid ?? '')];
      return (
        (otherProfile?.displayName.toLowerCase().includes(q) ?? false) ||
        (otherProfile?.username.toLowerCase().includes(q) ?? false) ||
        conversation.lastMessageText.toLowerCase().includes(q)
      );
    });
  }, [conversations, otherProfiles, messageQuery, uid]);

  function handleRowPress(notification: Notification) {
    if (!notification.read) {
      setNotifications((prev) =>
        prev.map((item) => (item.notificationId === notification.notificationId ? { ...item, read: true } : item))
      );
      // Never block navigation on this — a failed mark-read just means the
      // row stays unread next time the Inbox is fetched.
      markNotificationRead(notification.notificationId).catch(() => {});
    }

    if (notification.type === 'follow') {
      router.push(`/user/${notification.actorUid}`);
    } else if (notification.reelId) {
      router.push(`/reel/${notification.reelId}`);
    } else if (notification.contentId) {
      router.push(`/content/${notification.contentId}`);
    }
  }

  async function handleMarkAllRead() {
    if (unreadIds.length === 0) {
      return;
    }
    setNotifications((prev) => prev.map((item) => ({ ...item, read: true })));
    await markAllNotificationsRead(unreadIds);
  }

  function handleConversationPress(conversation: Conversation) {
    if (!uid) return;
    router.push(`/chat/${otherParticipantUid(conversation, uid)}`);
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>Inbox</Text>
          <View style={styles.headerRightGroup}>
            {mode === 'activity' && unreadIds.length > 0 ? (
              <Pressable
                onPress={handleMarkAllRead}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Mark all as read"
              >
                <Text style={styles.markAllText}>Mark all as read</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => router.push('/inbox/search')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Search people you follow"
            >
              <Ionicons name="search-outline" size={20} color={Colors.text} />
            </Pressable>
          </View>
        </View>

        <FollowingAvatarRow
          myProfile={myProfile}
          followingProfiles={followingProfiles}
          storyGroupByUid={storyGroupByUid}
          unseenAuthorUids={unseenAuthorUids}
        />

        <View style={styles.modeWrap}>
          <InboxModeTabs value={mode} onChange={setMode} unreadMessages={totalUnreadMessages} />
        </View>

        {mode === 'messages' && conversations.length > 0 ? (
          <View style={styles.searchWrap}>
            <View style={styles.searchField}>
              <Ionicons name="search" size={16} color={Colors.textSecondary} />
              <TextInput
                value={messageQuery}
                onChangeText={setMessageQuery}
                placeholder="Search messages"
                placeholderTextColor={Colors.textMuted}
                style={styles.searchInput}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>
        ) : null}

        {mode === 'activity' ? (
          <ActivityList
            status={status}
            notifications={notifications}
            isRefreshing={isRefreshing}
            onRefresh={() => load({ isRefresh: true })}
            onRetry={() => load()}
            onRowPress={handleRowPress}
          />
        ) : (
          <MessagesList
            status={messagesStatus}
            conversations={filteredConversations}
            hasAnyConversations={conversations.length > 0}
            isSearching={messageQuery.trim().length > 0}
            otherProfiles={otherProfiles}
            currentUid={uid}
            isRefreshing={isMessagesRefreshing}
            onRefresh={() => loadMessages({ isRefresh: true })}
            onRetry={() => loadMessages()}
            onRowPress={handleConversationPress}
          />
        )}
      </View>
    </SafeAreaView>
  );
}

type FollowingAvatarRowProps = {
  myProfile: PublicProfile | null;
  followingProfiles: PublicProfile[];
  storyGroupByUid: Map<string, StoryGroup>;
  unseenAuthorUids: Set<string>;
};

/**
 * "Your profile, then everyone you follow, left to right" — this is also
 * where Stories live now (see this screen's own doc comment). Anyone in
 * the row with a currently-active Story gets a ring — accent-colored
 * while any of their Stories is still unwatched, gray once you've seen
 * all of them (see unseenAuthorUids' own doc comment above) — and opens
 * the full-screen viewer (src/app/(app)/story/[uid].tsx) on tap EITHER
 * way (a gray ring still opens the Story, it just isn't announcing new
 * content any more), carrying a `queue` of every OTHER story-having uid
 * in this same row so finishing one person's Stories advances straight
 * into the next's. Everyone without an active Story just opens a chat
 * with them (or, for your own avatar, your Profile tab) — the original,
 * pre-Stories behavior. Renders nothing until your own profile has
 * loaded (never a bare "You" bubble flashing in before it's ready).
 */
function FollowingAvatarRow({ myProfile, followingProfiles, storyGroupByUid, unseenAuthorUids }: FollowingAvatarRowProps) {
  if (!myProfile) return null;

  const items = [
    { uid: myProfile.uid, profile: myProfile, isSelf: true },
    ...followingProfiles.map((profile) => ({ uid: profile.uid, profile, isSelf: false })),
  ];
  const storyQueue = items.filter((item) => storyGroupByUid.has(item.uid)).map((item) => item.uid);

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.followingScroll} contentContainerStyle={styles.followingRow}>
      {items.map(({ uid, profile, isSelf }) => {
        const hasStory = storyGroupByUid.has(uid);
        const isUnseen = unseenAuthorUids.has(uid);
        return (
          <Pressable
            key={uid}
            onPress={() => {
              if (hasStory) {
                router.push(`/story/${uid}?queue=${encodeURIComponent(storyQueue.join(','))}`);
              } else if (isSelf) {
                router.push('/profile');
              } else {
                router.push(`/chat/${uid}`);
              }
            }}
            style={styles.followingItem}
            accessibilityRole="button"
            accessibilityLabel={
              isSelf ? (hasStory ? 'Your Story' : 'Your profile') : hasStory ? `${profile.displayName}'s Story` : `Message ${profile.displayName}`
            }
          >
            <View style={hasStory ? (isUnseen ? styles.avatarRing : styles.avatarRingSeen) : undefined}>
              <Avatar name={profile.displayName} photoURL={profile.photoURL} size={52} />
            </View>
            <Text style={styles.followingLabel} numberOfLines={1}>
              {isSelf ? (hasStory ? 'Your Story' : 'You') : profile.displayName}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

type InboxModeTabsProps = {
  value: InboxMode;
  onChange: (mode: InboxMode) => void;
  unreadMessages: number;
};

/**
 * Activity/Messages pill selector (Step 28) — real unread-count badge on
 * Messages, never renamed to Primary/Groups. Kept local to this screen
 * rather than folded into the generic SegmentedControl, so its badge
 * support and pill styling can't affect SegmentedControl's other callers
 * (Events' type filter).
 */
function InboxModeTabs({ value, onChange, unreadMessages }: InboxModeTabsProps) {
  return (
    <View style={styles.modeTrack}>
      <ModePill
        label="Messages"
        active={value === 'messages'}
        onPress={() => onChange('messages')}
        badge={unreadMessages > 0 ? unreadMessages : undefined}
      />
      <ModePill label="Activity" active={value === 'activity'} onPress={() => onChange('activity')} />
    </View>
  );
}

function ModePill({ label, active, onPress, badge }: { label: string; active: boolean; onPress: () => void; badge?: number }) {
  return (
    <Pressable onPress={onPress} style={[styles.modePill, active && styles.modePillActive]} accessibilityRole="tab" accessibilityState={{ selected: active }}>
      <Text style={[styles.modePillText, active && styles.modePillTextActive]}>{label}</Text>
      {badge ? (
        <View style={styles.modeBadge}>
          <Text style={styles.modeBadgeText}>{badge > 99 ? '99+' : badge}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

type ActivityListProps = {
  status: LoadStatus;
  notifications: Notification[];
  isRefreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onRowPress: (notification: Notification) => void;
};

function ActivityList({ status, notifications, isRefreshing, onRefresh, onRetry, onRowPress }: ActivityListProps) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        Platform.OS === 'web' ? undefined : (
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
        )
      }
    >
      {status === 'loading' && notifications.length === 0 ? (
        <>
          <InboxRowSkeleton />
          <InboxRowSkeleton />
          <InboxRowSkeleton />
        </>
      ) : status === 'error' ? (
        <View style={styles.statusPad}>
          <ErrorState title="Couldn't load activity" onRetry={onRetry} />
        </View>
      ) : notifications.length === 0 ? (
        <View style={styles.statusPad}>
          <EmptyState
            icon="notifications-outline"
            title="No activity yet"
            body="Likes, comments and follows will appear here."
          />
        </View>
      ) : (
        notifications.map((notification) => (
          <NotificationRow key={notification.notificationId} notification={notification} onPress={onRowPress} />
        ))
      )}
    </ScrollView>
  );
}

type MessagesListProps = {
  status: LoadStatus;
  conversations: Conversation[];
  hasAnyConversations: boolean;
  isSearching: boolean;
  otherProfiles: Record<string, PublicProfile | null>;
  currentUid: string | null;
  isRefreshing: boolean;
  onRefresh: () => void;
  onRetry: () => void;
  onRowPress: (conversation: Conversation) => void;
};

function MessagesList({
  status,
  conversations,
  hasAnyConversations,
  isSearching,
  otherProfiles,
  currentUid,
  isRefreshing,
  onRefresh,
  onRetry,
  onRowPress,
}: MessagesListProps) {
  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        Platform.OS === 'web' ? undefined : (
          <RefreshControl refreshing={isRefreshing} onRefresh={onRefresh} tintColor={Colors.accent} />
        )
      }
    >
      {status === 'loading' && conversations.length === 0 && !hasAnyConversations ? (
        <>
          <InboxRowSkeleton />
          <InboxRowSkeleton />
          <InboxRowSkeleton />
        </>
      ) : status === 'error' ? (
        <View style={styles.statusPad}>
          <ErrorState title="Couldn't load messages" onRetry={onRetry} />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.statusPad}>
          {isSearching ? (
            <EmptyState icon="search-outline" title="No conversations found." bare />
          ) : (
            <EmptyState
              icon="chatbubbles-outline"
              title="No messages yet"
              body="Start a conversation from someone's profile."
            />
          )}
        </View>
      ) : (
        conversations.map((conversation) => (
          <ConversationRow
            key={conversation.conversationId}
            conversation={conversation}
            otherProfile={otherProfiles[otherParticipantUid(conversation, currentUid ?? '')] ?? null}
            unreadCount={currentUid ? (conversation.unreadCounts[currentUid] ?? 0) : 0}
            onPress={() => onRowPress(conversation)}
          />
        ))
      )}
    </ScrollView>
  );
}

/** Row-shaped loading placeholder (Step 28) — matches ConversationRow/NotificationRow's avatar+two-lines shape instead of a plain spinner. */
function InboxRowSkeleton() {
  return (
    <View style={styles.skeletonRow}>
      <SkeletonBlock width={52} height={52} />
      <View style={styles.skeletonLines}>
        <SkeletonBlock width="60%" height={14} />
        <SkeletonBlock width="85%" height={12} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  page: {
    flex: 1,
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    alignSelf: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  title: {
    color: Colors.text,
    ...Typography.screenTitle,
  },
  headerRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  markAllText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  modeWrap: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  followingScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  followingRow: {
    flexGrow: 0,
    alignItems: 'flex-start',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  followingItem: {
    alignItems: 'center',
    width: 60,
    gap: 4,
  },
  // Only applied to an avatar with a currently-active Story — see
  // FollowingAvatarRow's own doc comment.
  avatarRing: {
    borderWidth: 2,
    borderColor: Colors.accent,
    borderRadius: 32,
    padding: 2,
  },
  // Same shape as avatarRing, just gray — an active Story you've already
  // watched in full (see FollowingAvatarRow's own doc comment).
  avatarRingSeen: {
    borderWidth: 2,
    borderColor: Colors.textMuted,
    borderRadius: 32,
    padding: 2,
  },
  followingLabel: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  modeTrack: {
    flexDirection: 'row',
    gap: Spacing.xs,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 4,
  },
  modePill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.full,
  },
  modePillActive: {
    backgroundColor: Colors.background,
  },
  modePillText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  modePillTextActive: {
    color: Colors.accent,
  },
  modeBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  modeBadgeText: {
    color: Colors.background,
    fontSize: 10,
    fontWeight: '800',
  },
  searchWrap: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
  },
  searchField: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    height: 40,
  },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 14,
    height: '100%',
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: Spacing.xxl,
  },
  statusPad: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  skeletonLines: {
    flex: 1,
    gap: Spacing.sm,
  },
});
