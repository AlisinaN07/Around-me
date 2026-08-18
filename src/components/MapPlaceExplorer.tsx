import { StyleSheet, View } from 'react-native';

import { PlaceFilters } from '@/components/PlaceFilters';
import { PlaceList } from '@/components/PlaceList';
import { useCityPlaces } from '@/hooks/useCityPlaces';

type MapPlaceExplorerProps = {
  cityKey: string;
  cityLabel: string;
};

/**
 * Web/Android Places discovery: search + category filter (PlaceFilters)
 * over one fetched city page (useCityPlaces), rendered as a plain list
 * (PlaceList). The iOS native map screen (Step 14) uses the exact same
 * hook and filter component, feeding the same filtered Place[] to a real
 * map instead of — or alongside — this list.
 */
export function MapPlaceExplorer({ cityKey, cityLabel }: MapPlaceExplorerProps) {
  const { places, filteredPlaces, status, query, setQuery, selectedCategory, setSelectedCategory, reload } = useCityPlaces(cityKey);

  return (
    <View style={styles.container}>
      <PlaceFilters
        cityLabel={cityLabel}
        query={query}
        onQueryChange={setQuery}
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
      />

      <PlaceList
        places={filteredPlaces}
        status={status}
        emptyText={places.length === 0 ? `No known places in ${cityLabel} yet.` : 'No places match your search.'}
        onRetry={reload}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
