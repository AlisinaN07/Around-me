import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/CategoryChip';
import { PlaceList } from '@/components/PlaceList';
import { PLACE_CATEGORIES } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { fetchCityPlaces } from '@/services/places';
import type { Place } from '@/types/place';

type LoadStatus = 'loading' | 'loaded' | 'error';

type MapPlaceExplorerProps = {
  cityKey: string;
  cityLabel: string;
};

/**
 * Fetch + search + category-filter for one city's Places. This is the
 * reusable unit a future native map (Step 14) can sit alongside: it owns
 * the Firestore fetch and the already-loaded Place[] filtering, and hands
 * the result to PlaceList (pure UI) — a native map component would receive
 * that same filtered Place[] instead of talking to Firestore itself.
 */
export function MapPlaceExplorer({ cityKey, cityLabel }: MapPlaceExplorerProps) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const result = await fetchCityPlaces(cityKey);
      setPlaces(result);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [cityKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Category chip taps and search keystrokes both filter the already-loaded
  // list in-memory — never a new Firestore query per chip tap or keystroke.
  const filtered = useMemo(() => {
    let list = places;
    if (selectedCategory !== 'all') {
      list = list.filter((place) => place.categoryId === selectedCategory);
    }
    const trimmed = query.trim().toLowerCase();
    if (trimmed) {
      list = list.filter((place) => place.name.toLowerCase().includes(trimmed));
    }
    return list;
  }, [places, selectedCategory, query]);

  return (
    <View style={styles.container}>
      <View style={styles.searchRow}>
        <Ionicons name="search-outline" size={18} color={Colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder={`Search places in ${cityLabel}`}
          placeholderTextColor={Colors.textSecondary}
          autoCorrect={false}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.horizontalScroll}
        contentContainerStyle={styles.chipsRow}
      >
        <CategoryChip label="All" icon="apps-outline" selected={selectedCategory === 'all'} onPress={() => setSelectedCategory('all')} />
        {PLACE_CATEGORIES.map((category) => (
          <CategoryChip
            key={category.id}
            label={category.label}
            icon={category.icon}
            selected={selectedCategory === category.id}
            onPress={() => setSelectedCategory(category.id)}
          />
        ))}
      </ScrollView>

      <PlaceList
        places={filtered}
        status={status}
        emptyText={
          places.length === 0
            ? `No known places in ${cityLabel} yet.`
            : 'No places match your search.'
        }
        onRetry={load}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  searchInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    paddingVertical: Spacing.sm,
  },
  horizontalScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  chipsRow: {
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
});
