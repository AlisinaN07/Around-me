import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { PlaceCard } from '@/components/PlaceCard';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { Place } from '@/types/place';

type PlaceListStatus = 'loading' | 'loaded' | 'error';

type PlaceListProps = {
  places: Place[];
  status: PlaceListStatus;
  emptyText: string;
  onRetry: () => void;
};

/**
 * Pure `Place[] -> UI` rendering — no Firestore access here at all (see
 * MapPlaceExplorer, which owns fetching/search/filtering). This is the
 * boundary a future native map component can reuse: feed it the same
 * Place[] this list already renders, without coupling map rendering to
 * data fetching.
 */
export function PlaceList({ places, status, emptyText, onRetry }: PlaceListProps) {
  if (status === 'loading' && places.length === 0) {
    return (
      <View style={styles.container}>
        <SkeletonBlock />
        <SkeletonBlock />
        <SkeletonBlock />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.emptyPanel}>
        <Ionicons name="cloud-offline-outline" size={32} color={Colors.textSecondary} />
        <Text style={styles.emptyTitle}>Couldn&apos;t load places.</Text>
        <Button label="Try again" onPress={onRetry} />
      </View>
    );
  }

  if (places.length === 0) {
    return (
      <View style={styles.emptyPanel}>
        <Ionicons name="location-outline" size={32} color={Colors.textSecondary} />
        <Text style={styles.emptyTitle}>{emptyText}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {places.map((place) => (
        <PlaceCard key={place.placeId} place={place} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: Spacing.xs,
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
});

function SkeletonBlock() {
  return <View style={skeletonStyles.block} />;
}

const skeletonStyles = StyleSheet.create({
  block: {
    height: 76,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    opacity: 0.5,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
  },
});
