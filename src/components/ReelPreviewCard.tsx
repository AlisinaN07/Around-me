import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';
import type { ReelPreview } from '@/fixtures/homeFeed';

export function ReelPreviewCard({ item }: { item: ReelPreview }) {
  return (
    <Pressable
      style={styles.card}
      accessibilityRole="button"
      accessibilityLabel={`Reel from ${item.username} at ${item.place}`}
    >
      <View style={styles.media}>
        <Ionicons name="play-circle" size={36} color={Colors.text} style={styles.playIcon} />
      </View>
      <View style={styles.overlay}>
        <Text style={styles.username} numberOfLines={1}>
          {item.username}
        </Text>
        <Text style={styles.place} numberOfLines={1}>
          {item.place}
        </Text>
        <View style={styles.metaRow}>
          <Ionicons name="eye-outline" size={12} color={Colors.textSecondary} />
          <Text style={styles.metaText}>{item.views}</Text>
          <Text style={styles.metaDot}>·</Text>
          <Text style={styles.metaText}>{item.timeAgo}</Text>
        </View>
      </View>
    </Pressable>
  );
}

const CARD_WIDTH = 128;
const CARD_HEIGHT = 200;

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  media: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    opacity: 0.85,
  },
  overlay: {
    padding: Spacing.sm,
    gap: 2,
  },
  username: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
  },
  place: {
    color: Colors.textSecondary,
    fontSize: 11,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  metaText: {
    color: Colors.textSecondary,
    fontSize: 11,
  },
  metaDot: {
    color: Colors.textSecondary,
    fontSize: 11,
  },
});
