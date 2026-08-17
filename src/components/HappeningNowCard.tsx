import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';
import type { HappeningNowItem } from '@/fixtures/homeFeed';

export function HappeningNowCard({ item }: { item: HappeningNowItem }) {
  return (
    <Pressable style={styles.card} accessibilityRole="button" accessibilityLabel={`${item.title} at ${item.place}`}>
      <View style={styles.media}>
        <Ionicons name="image-outline" size={28} color={Colors.textSecondary} />
        <View style={styles.timeBadge}>
          <Text style={styles.timeBadgeText}>{item.time}</Text>
        </View>
      </View>
      <View style={styles.body}>
        <Text style={styles.category}>{item.category}</Text>
        <Text style={styles.title} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.place} numberOfLines={1}>
          {item.place}
        </Text>
      </View>
    </Pressable>
  );
}

const CARD_WIDTH = 168;

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  media: {
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
  },
  timeBadge: {
    position: 'absolute',
    top: Spacing.xs,
    left: Spacing.xs,
    backgroundColor: Colors.accent,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  timeBadgeText: {
    color: Colors.background,
    fontSize: 11,
    fontWeight: '700',
  },
  body: {
    padding: Spacing.sm,
    gap: 2,
  },
  category: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  title: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  place: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
});
