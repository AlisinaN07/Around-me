import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { Conversation } from '@/types/message';
import type { PublicProfile } from '@/types/social';
import { formatTimeAgo } from '@/utils/timeFormat';

type ConversationRowProps = {
  conversation: Conversation;
  otherProfile: PublicProfile | null;
  unreadCount: number;
  onPress: () => void;
};

/** A single Messages row — avatar, name, last-message preview, time, unread badge. */
export function ConversationRow({ conversation, otherProfile, unreadCount, onPress }: ConversationRowProps) {
  const isUnread = unreadCount > 0;
  const displayName = otherProfile?.displayName ?? 'Unknown user';

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.row, isUnread && styles.rowUnread, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`Conversation with ${displayName}`}
    >
      <Avatar name={displayName} size={44} />
      <View style={styles.body}>
        <View style={styles.line}>
          <Text style={[styles.name, isUnread && styles.nameUnread]} numberOfLines={1}>
            {displayName}
          </Text>
          <Text style={styles.time}>{formatTimeAgo(conversation.lastMessageAt.toDate())}</Text>
        </View>
        <View style={styles.line}>
          <Text style={[styles.preview, isUnread && styles.previewUnread]} numberOfLines={1}>
            {conversation.lastMessageText}
          </Text>
          {isUnread ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unreadCount > 99 ? '99+' : unreadCount}</Text>
            </View>
          ) : null}
        </View>
      </View>
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
    backgroundColor: 'rgba(255, 107, 44, 0.08)',
  },
  rowPressed: {
    opacity: 0.75,
  },
  body: {
    flex: 1,
    gap: 4,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  name: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  nameUnread: {
    fontWeight: '800',
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  preview: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 13,
  },
  previewUnread: {
    color: Colors.text,
    fontWeight: '600',
  },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: Colors.background,
    fontSize: 11,
    fontWeight: '800',
  },
});
