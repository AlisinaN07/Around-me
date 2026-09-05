import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Colors, Spacing } from '@/constants/theme';
import type { Notification } from '@/types/notification';
import { formatTimeAgo } from '@/utils/timeFormat';

/** Icon depends on responseStatus for event_response, not just type — see getNotificationIcon below. */
const TYPE_ICON: Record<Exclude<Notification['type'], 'event_response'>, keyof typeof Ionicons.glyphMap> = {
  like: 'heart',
  comment: 'chatbubble',
  follow: 'person-add',
  reel_like: 'heart',
  reel_comment: 'chatbubble',
  activity_join: 'people',
};

function getNotificationIcon(notification: Notification): keyof typeof Ionicons.glyphMap {
  if (notification.type === 'event_response') {
    return notification.responseStatus === 'going' ? 'checkmark-circle' : 'star';
  }
  return TYPE_ICON[notification.type];
}

function describeNotification(notification: Notification): string {
  switch (notification.type) {
    case 'like':
      return `${notification.actorDisplayName} liked your post`;
    case 'comment':
      return notification.previewText
        ? `${notification.actorDisplayName} commented: "${notification.previewText}"`
        : `${notification.actorDisplayName} commented on your post`;
    case 'follow':
      return `${notification.actorDisplayName} started following you`;
    case 'reel_like':
      return `${notification.actorDisplayName} liked your Reel`;
    case 'reel_comment':
      return notification.previewText
        ? `${notification.actorDisplayName} commented on your Reel: "${notification.previewText}"`
        : `${notification.actorDisplayName} commented on your Reel`;
    case 'event_response':
      return notification.responseStatus === 'going'
        ? `${notification.actorDisplayName} is going to your event`
        : `${notification.actorDisplayName} is interested in your event`;
    case 'activity_join':
      return `${notification.actorDisplayName} joined your activity`;
  }
}

type NotificationRowProps = {
  notification: Notification;
  onPress: (notification: Notification) => void;
};

/** A single Activity row — avatar with a type badge, activity sentence, time ago, unread state. */
export function NotificationRow({ notification, onPress }: NotificationRowProps) {
  const isUnread = !notification.read;

  return (
    <Pressable
      onPress={() => onPress(notification)}
      style={({ pressed }) => [styles.row, isUnread && styles.rowUnread, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={describeNotification(notification)}
    >
      <View style={styles.avatarWrap}>
        <Avatar name={notification.actorDisplayName} size={52} />
        <View style={styles.badge}>
          <Ionicons name={getNotificationIcon(notification)} size={11} color={Colors.background} />
        </View>
      </View>
      <View style={styles.body}>
        <Text style={styles.text} numberOfLines={2}>
          {describeNotification(notification)}
        </Text>
        <Text style={styles.time}>{formatTimeAgo(notification.createdAt.toDate())}</Text>
      </View>
      {isUnread ? <View style={styles.unreadDot} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowUnread: {
    backgroundColor: Colors.accentMuted,
  },
  rowPressed: {
    opacity: 0.75,
  },
  avatarWrap: {
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accent,
    borderWidth: 2,
    borderColor: Colors.background,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  text: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '600',
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.accent,
  },
});
