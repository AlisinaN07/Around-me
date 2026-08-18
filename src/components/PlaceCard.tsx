import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getPlaceCategory } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { Place } from '@/types/place';
import { formatCityDisplayName } from '@/utils/cityDisplay';

type PlaceCardProps = {
  place: Place;
  /** Highlights the card — used when this Place is selected on the map (Step 14). */
  selected?: boolean;
  /**
   * Overrides the default tap behavior. When provided (e.g. the native map
   * screen), tapping the card body selects the Place instead of navigating
   * — the chevron on the right always still opens the Place detail
   * directly, so "open detail" is never lost. When omitted (the plain
   * Places list), the whole card navigates on tap, unchanged from Step 13.
   */
  onPress?: () => void;
};

/** Renders a real places/{placeId} document — no fake ratings, distances, or review counts. */
export function PlaceCard({ place, selected, onPress }: PlaceCardProps) {
  const category = getPlaceCategory(place.categoryId);
  const openDetail = () => router.push(`/place/${place.placeId}`);

  return (
    <Pressable
      style={[styles.card, selected && styles.cardSelected]}
      onPress={onPress ?? openDetail}
      accessibilityRole="button"
      accessibilityLabel={`View ${place.name}`}
    >
      <View style={styles.iconCircle}>
        <Ionicons name={category?.icon ?? 'location-outline'} size={20} color={Colors.accent} />
      </View>
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={1}>
          {place.name}
        </Text>
        {category ? <Text style={styles.category}>{category.label}</Text> : null}
        <View style={styles.locationRow}>
          <Ionicons name="location-outline" size={13} color={Colors.textSecondary} />
          <Text style={styles.address} numberOfLines={1}>
            {place.address} · {formatCityDisplayName(place.cityName)}
          </Text>
        </View>
      </View>
      <Pressable
        onPress={(event) => {
          event.stopPropagation();
          openDetail();
        }}
        hitSlop={8}
        accessibilityRole="link"
        accessibilityLabel="View place"
      >
        <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
  cardSelected: {
    borderColor: Colors.accent,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  body: {
    flex: 1,
    gap: 2,
  },
  name: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  category: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  address: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 12,
  },
});
