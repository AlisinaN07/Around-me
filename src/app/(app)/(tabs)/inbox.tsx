import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { ConversationRow } from '@/components/ConversationRow';
import { NotificationRow } from '@/components/NotificationRow';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchConversations, otherParticipantUid } from '@/services/messages';
import { fetchNotifications, markAllNotificationsRead, markNotificationRead } from '@/services/notifications';
import { fetchPublicProfile } from '@/services/publicProfile';
import type { Conversation } from '@/types/message';
import type { Notification } from '@/types/notification';
import type { PublicProfile } from '@/types/social';

type InboxMode = 'activity' | 'messages';
type LoadStatus = 'loading' | 'loaded' | 'error';

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

  const modeOptions = useMemo(
    () => [
      { id: 'activity' as const, label: 'Activity' },
      { id: 'messages' as const, label: totalUnreadMessages > 0 ? `Messages (${totalUnreadMessages})` : 'Messages' },
    ],
    [totalUnreadMessages]
  );

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

        <View style={styles.segmentWrap}>
          <SegmentedControl options={modeOptions} value={mode} onChange={setMode} />
        </View>

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
            conversations={conversations}
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
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      ) : status === 'error' ? (
        <View style={styles.emptyPanel}>
          <Ionicons name="cloud-offline-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.emptyTitle}>Couldn&apos;t load activity</Text>
          <Button label="Try again" onPress={onRetry} />
        </View>
      ) : notifications.length === 0 ? (
        <View style={styles.emptyPanel}>
          <Ionicons name="notifications-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.emptyTitle}>No activity yet</Text>
          <Text style={styles.emptyBody}>
            When people like your posts, comment, or follow you, you&apos;ll see it here.
          </Text>
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
      {status === 'loading' && conversations.length === 0 ? (
        <>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </>
      ) : status === 'error' ? (
        <View style={styles.emptyPanel}>
          <Ionicons name="cloud-offline-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.emptyTitle}>Couldn&apos;t load messages</Text>
          <Button label="Try again" onPress={onRetry} />
        </View>
      ) : conversations.length === 0 ? (
        <View style={styles.emptyPanel}>
          <Ionicons name="chatbubbles-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.emptyTitle}>No messages yet</Text>
          <Text style={styles.emptyBody}>Start a conversation with someone around your city.</Text>
          <Button label="Explore Around" variant="secondary" onPress={() => router.push('/')} />
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

function SkeletonRow() {
  return <View style={styles.skeleton} />;
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
    fontSize: 26,
    fontWeight: '800',
  },
  markAllText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  segmentWrap: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: Spacing.xxl,
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
    height: 64,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    opacity: 0.5,
  },
});
