import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConversationRow } from '@/components/ConversationRow';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { NotificationRow } from '@/components/NotificationRow';
import { SkeletonBlock } from '@/components/LoadingState';
import { Colors, Layout, Radius, Spacing, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchConversations, otherParticipantUid } from '@/services/messages';
import { fetchNotifications, markAllNotificationsRead, markNotificationRead } from '@/services/notifications';
import { fetchPublicProfile } from '@/services/publicProfile';
import type { Conversation } from '@/types/message';
import type { Notification } from '@/types/notification';
import type { PublicProfile } from '@/types/social';

type InboxMode = 'activity' | 'messages';
type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Inbox — Step 28 visual reconstruction. Real product model preserved
 * exactly: Activity (notifications) and Messages (1-to-1 conversations)
 * are the only two modes — never renamed to "Primary"/"Groups" from the
 * reference, since Groups doesn't exist. No Requests row, no active-
 * people/story strip, no online presence — none of that has real backend
 * support (see README "Inbox — Step 28").
 */
export default function InboxScreen() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [mode, setMode] = useState<InboxMode>('activity');

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [messagesStatus, setMessagesStatus] = useState<LoadStatus>('loading');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [otherProfiles, setOtherProfiles] = useState<Record<string, PublicProfile | null>>({});
  const [isMessagesRefreshing, setIsMessagesRefreshing] = useState(false);
  const [messageQuery, setMessageQuery] = useState('');

  const load = useCallback(
    async (isRefresh = false) => {
      if (!uid) {
        return;
      }
      if (isRefresh) {
        setIsRefreshing(true);
      } else {
        setStatus('loading');
      }
      try {
        const items = await fetchNotifications(uid);
        setNotifications(items);
        setStatus('loaded');
      } catch {
        setStatus('error');
      } finally {
        setIsRefreshing(false);
      }
    },
    [uid]
  );

  const loadMessages = useCallback(
    async (isRefresh = false) => {
      if (!uid) {
        return;
      }
      if (isRefresh) {
        setIsMessagesRefreshing(true);
      } else {
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
        setMessagesStatus('loaded');
      } catch {
        setMessagesStatus('error');
      } finally {
        setIsMessagesRefreshing(false);
      }
    },
    [uid]
  );

  // Fires on mount and again every time Inbox regains focus — e.g. after
  // tapping a notification/conversation and coming back. No realtime
  // listener for either list — Chat itself owns the one realtime listener
  // in this app while it's open (see src/app/(app)/chat/[uid].tsx).
  useFocusEffect(
    useCallback(() => {
      load();
      loadMessages();
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
        </View>

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
            onRefresh={() => load(true)}
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
            onRefresh={() => loadMessages(true)}
            onRetry={() => loadMessages()}
            onRowPress={handleConversationPress}
          />
        )}
      </View>
    </SafeAreaView>
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
      <ModePill label="Activity" active={value === 'activity'} onPress={() => onChange('activity')} />
      <ModePill
        label="Messages"
        active={value === 'messages'}
        onPress={() => onChange('messages')}
        badge={unreadMessages > 0 ? unreadMessages : undefined}
      />
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
  markAllText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  modeWrap: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.sm,
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
