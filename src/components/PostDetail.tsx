import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { AuthorLink } from '@/components/AuthorLink';
import { EngagementSection } from '@/components/EngagementSection';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { PostContent } from '@/types/content';
import { formatTimeAgo } from '@/utils/timeFormat';

export function PostDetail({ content }: { content: PostContent }) {
  const category = INTERESTS.find((interest) => interest.id === content.categoryId);

  return (
    <View style={styles.container}>
      {category && (
        <View style={styles.metaRow}>
          <View style={styles.categoryPill}>
            <Text style={styles.categoryText}>
              {category.emoji} {category.label}
            </Text>
          </View>
        </View>
      )}

      <AuthorLink uid={content.authorUid} style={styles.authorRow}>
        <Text style={styles.authorName}>{content.authorDisplayName}</Text>
        <Text style={styles.username}>@{content.authorUsername}</Text>
      </AuthorLink>

      <Text style={styles.body}>{content.body}</Text>

      {content.placeName ? (
        <View style={styles.infoRow}>
          <Ionicons name="location-outline" size={16} color={Colors.textSecondary} />
          <Text style={styles.infoText}>{content.placeName}</Text>
        </View>
      ) : null}

      <Text style={styles.time}>{formatTimeAgo(content.createdAt.toDate())}</Text>

      <EngagementSection contentId={content.contentId} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.sm,
  },
  metaRow: {
    flexDirection: 'row',
  },
  categoryPill: {
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  categoryText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  authorName: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  body: {
    color: Colors.text,
    fontSize: 17,
    lineHeight: 24,
    marginTop: Spacing.xs,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  infoText: {
    color: Colors.text,
    fontSize: 14,
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
});
