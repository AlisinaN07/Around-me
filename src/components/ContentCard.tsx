import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthorLink } from '@/components/AuthorLink';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { Content } from '@/types/content';
import { formatEventTime, formatTimeAgo } from '@/utils/timeFormat';

type ContentCardProps = {
  item: Content;
  /** Signed-in user's own uid, to show the "You" indicator — never used for anything else. */
  currentUid: string | null;
};

const TYPE_LABEL: Record<Content['type'], string> = {
  post: 'Post',
  activity: 'Activity',
  event: 'Event',
};

/** Renders a real content/{contentId} document — no invented engagement numbers, ever. */
export function ContentCard({ item, currentUid }: ContentCardProps) {
  const isOwn = currentUid !== null && item.authorUid === currentUid;
  const category = INTERESTS.find((interest) => interest.id === item.categoryId);
  const timeLabel = item.type === 'post' ? formatTimeAgo(item.createdAt.toDate()) : formatEventTime(item.startsAt.toDate());

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/content/${item.contentId}`)}
      accessibilityRole="button"
      accessibilityLabel={`View ${item.type}`}
    >
      <View style={styles.header}>
        <View style={styles.authorRow}>
          <AuthorLink uid={item.authorUid} style={styles.authorLink}>
            <Text style={styles.authorName} numberOfLines={1}>
              {item.authorDisplayName}
            </Text>
            <Text style={styles.username} numberOfLines={1}>
              @{item.authorUsername}
            </Text>
          </AuthorLink>
          {isOwn && (
            <View style={styles.youBadge}>
              <Text style={styles.youText}>You</Text>
            </View>
          )}
        </View>
        <Text style={styles.time}>{timeLabel}</Text>
      </View>

      <View style={styles.metaRow}>
        <View style={styles.typeBadge}>
          <Text style={styles.typeBadgeText}>{TYPE_LABEL[item.type]}</Text>
        </View>
        {category && (
          <View style={styles.categoryPill}>
            <Text style={styles.categoryText}>
              {category.emoji} {category.label}
            </Text>
          </View>
        )}
      </View>

      {item.type === 'post' ? (
        <Text style={styles.body}>{item.body}</Text>
      ) : (
        <>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.description}>{item.description}</Text>
        </>
      )}

      {item.placeName ? (
        <View style={styles.placeRow}>
          <Ionicons name="location-outline" size={13} color={Colors.textSecondary} />
          <Text style={styles.place} numberOfLines={1}>
            {item.placeName}
          </Text>
        </View>
      ) : null}

      {item.type === 'activity' && item.maxParticipants ? (
        <Text style={styles.meta}>Up to {item.maxParticipants} people</Text>
      ) : null}

      {item.type !== 'post' && (
        <View style={styles.actionButton}>
          <Text style={styles.actionText}>{item.type === 'activity' ? 'View activity' : 'View event'}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    gap: Spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  authorLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  authorName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 13,
    flexShrink: 1,
  },
  youBadge: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 1,
  },
  youText: {
    color: Colors.accent,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginTop: 2,
  },
  typeBadge: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  typeBadgeText: {
    color: Colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  categoryPill: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  categoryText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  body: {
    color: Colors.text,
    fontSize: 15,
    lineHeight: 21,
    marginTop: Spacing.xs,
  },
  title: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginTop: Spacing.xs,
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xs,
  },
  place: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  meta: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  actionButton: {
    alignSelf: 'flex-start',
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
    marginTop: Spacing.xs,
  },
  actionText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
});
