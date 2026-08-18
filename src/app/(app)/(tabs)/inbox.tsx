import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { NotificationRow } from '@/components/NotificationRow';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchNotifications, markAllNotificationsRead, markNotificationRead } from '@/services/notifications';
import type { Notification } from '@/types/notification';

type InboxMode = 'activity' | 'messages';
type LoadStatus = 'loading' | 'loaded' | 'error';

// Activity defaults on because it's functional today; Messages is a visual
// foundation only until a real DM backend exists (see MessagesEmptyState).
const MODE_OPTIONS: { id: InboxMode; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'messages', label: 'Messages' },
];

export default function InboxScreen() {
  const { user } = useAuth();
  const uid = user?.uid ?? null;

  const [mode, setMode] = useState<InboxMode>('activity');
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  // Fires on mount and again every time Inbox regains focus — e.g. after
  // tapping a notification and coming back. No realtime listener.
  useFocusEffect(
    useCallback(() => {
      load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uid])
  );

  const unreadIds = notifications.filter((item) => !item.read).map((item) => item.notificationId);

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
          <SegmentedControl options={MODE_OPTIONS} value={mode} onChange={setMode} />
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
          <MessagesEmptyState />
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

function MessagesEmptyState() {
  return (
    <View style={styles.messagesWrap}>
      <View style={styles.emptyPanel}>
        <Ionicons name="chatbubbles-outline" size={32} color={Colors.textSecondary} />
        <Text style={styles.emptyTitle}>Messages</Text>
        <Text style={styles.emptyBody}>Your conversations will appear here.</Text>
        <Text style={styles.emptyBody}>Start conversations with people around your city.</Text>
      </View>
    </View>
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
  messagesWrap: {
    flex: 1,
    paddingTop: Spacing.md,
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
