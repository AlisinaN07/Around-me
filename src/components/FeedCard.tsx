import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';
import type { AroundYouItem } from '@/fixtures/homeFeed';

export function FeedCard({ item }: { item: AroundYouItem }) {
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.kindBadge}>
          <Ionicons name={KIND_ICON[item.kind]} size={12} color={Colors.accent} />
          <Text style={styles.kindLabel}>{KIND_LABEL[item.kind]}</Text>
        </View>
        <Text style={styles.time}>{item.time}</Text>
      </View>

      {item.kind === 'activity' && (
        <>
          <Text style={styles.title}>{item.title}</Text>
          <Text style={styles.description}>{item.description}</Text>
        </>
      )}
      {item.kind === 'event' && <Text style={styles.title}>{item.title}</Text>}
      {item.kind === 'business' && (
        <>
          <Text style={styles.title}>{item.businessName}</Text>
          <Text style={styles.description}>{item.message}</Text>
        </>
      )}

      <View style={styles.footer}>
        <View style={styles.placeRow}>
          <Ionicons name="location-outline" size={13} color={Colors.textSecondary} />
          <Text style={styles.place} numberOfLines={1}>
            {item.place}
          </Text>
        </View>

        {item.kind !== 'business' && (
          <Pressable style={styles.interestedPill} accessibilityRole="button" accessibilityLabel="Interested">
            <Text style={styles.interestedText}>Interested · {item.interestedCount}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const KIND_ICON: Record<AroundYouItem['kind'], keyof typeof Ionicons.glyphMap> = {
  activity: 'people-outline',
  event: 'calendar-outline',
  business: 'storefront-outline',
};

const KIND_LABEL: Record<AroundYouItem['kind'], string> = {
  activity: 'Activity',
  event: 'Event',
  business: 'Local business',
};

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
  },
  kindBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  kindLabel: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  title: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.xs,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    flexShrink: 1,
  },
  place: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  interestedPill: {
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  interestedText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
});
