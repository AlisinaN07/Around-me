import { Ionicons } from '@expo/vector-icons';
import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { NativeCityMap } from '@/components/NativeCityMap';
import type { NativeCityMapHandle } from '@/components/NativeCityMap.types';
import { PlaceFilters } from '@/components/PlaceFilters';
import { PlaceList } from '@/components/PlaceList';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useCityPlaces } from '@/hooks/useCityPlaces';
import { getCurrentCoordinates } from '@/services/location';
import { computeInitialCamera } from '@/utils/mapCamera';

type LocationButtonStatus = 'idle' | 'loading' | 'denied' | 'error';

type NativeMapScreenProps = {
  cityKey: string;
  cityLabel: string;
};

/**
 * iOS Map tab (Step 14): real Apple Map + the same filtered Place[] also
 * rendered as a card list below it, so search/category filtering controls
 * both surfaces from one Firestore fetch (useCityPlaces). "My location" is
 * a one-time, explicitly-tapped camera move only — see
 * src/services/location.ts; nothing here is ever written to Firestore or
 * persisted.
 */
export function NativeMapScreen({ cityKey, cityLabel }: NativeMapScreenProps) {
  const { places, filteredPlaces, status, query, setQuery, selectedCategory, setSelectedCategory, reload } = useCityPlaces(cityKey);
  const [selectedPlaceId, setSelectedPlaceId] = useState<string | null>(null);
  const [locationStatus, setLocationStatus] = useState<LocationButtonStatus>('idle');
  const mapRef = useRef<NativeCityMapHandle>(null);

  // Computed once per loaded city Place set — not recomputed on every
  // filter tap, so the map's initial framing stays stable while the user
  // searches/filters (only markers change after that).
  const initialCamera = useMemo(() => computeInitialCamera(places), [places]);

  const handleMyLocation = async () => {
    if (locationStatus === 'loading') return;
    setLocationStatus('loading');
    const result = await getCurrentCoordinates();
    if (!result.ok) {
      setLocationStatus(result.reason === 'permission-denied' ? 'denied' : 'error');
      return;
    }
    setLocationStatus('idle');
    mapRef.current?.centerOn(result.coordinates, 15);
  };

  return (
    <View style={styles.container}>
      <PlaceFilters
        cityLabel={cityLabel}
        query={query}
        onQueryChange={setQuery}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
      />

      <View style={styles.mapArea}>
        {status === 'loading' && places.length === 0 ? (
          <View style={styles.mapMessage}>
            <ActivityIndicator color={Colors.accent} />
          </View>
        ) : status === 'error' ? (
          <View style={styles.mapMessage}>
            <Ionicons name="cloud-offline-outline" size={28} color={Colors.textSecondary} />
            <Text style={styles.mapMessageTitle}>Couldn&apos;t load places in {cityLabel}.</Text>
            <Pressable onPress={reload} accessibilityRole="button">
              <Text style={styles.retryText}>Try again</Text>
            </Pressable>
          </View>
        ) : !initialCamera ? (
          <View style={styles.mapMessage}>
            <Ionicons name="location-outline" size={28} color={Colors.textSecondary} />
            <Text style={styles.mapMessageTitle}>No places here yet.</Text>
          </View>
        ) : (
          <>
            <NativeCityMap
              ref={mapRef}
              places={filteredPlaces}
              selectedPlaceId={selectedPlaceId}
              onSelectPlace={setSelectedPlaceId}
              initialCamera={initialCamera}
            />
            <Pressable
              style={styles.myLocationButton}
              onPress={handleMyLocation}
              accessibilityRole="button"
              accessibilityLabel="My location"
            >
              {locationStatus === 'loading' ? (
                <ActivityIndicator size="small" color={Colors.text} />
              ) : (
                <Ionicons name="locate" size={20} color={Colors.text} />
              )}
            </Pressable>
          </>
        )}
      </View>

      {locationStatus === 'denied' ? (
        <Text style={styles.locationBannerText}>Location access is off. You can still explore places in {cityLabel}.</Text>
      ) : null}

      <PlaceList
        places={filteredPlaces}
        status={status}
        emptyText={places.length === 0 ? `No known places in ${cityLabel} yet.` : 'No places match your search.'}
        onRetry={reload}
        selectedPlaceId={selectedPlaceId}
        onSelectPlace={setSelectedPlaceId}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  mapArea: {
    height: 380,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.sm,
    marginBottom: Spacing.md,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  mapMessage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  mapMessageTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  retryText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  myLocationButton: {
    position: 'absolute',
    bottom: Spacing.md,
    right: Spacing.md,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  locationBannerText: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
});
