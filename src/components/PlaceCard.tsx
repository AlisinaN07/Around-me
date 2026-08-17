import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { getPlaceCategory } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { Place } from '@/types/place';
import { formatCityDisplayName } from '@/utils/cityDisplay';

/** Renders a real places/{placeId} document — no fake ratings, distances, or review counts. */
export function PlaceCard({ place }: { place: Place }) {
  const category = getPlaceCategory(place.categoryId);

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/place/${place.placeId}`)}
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
      <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
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
