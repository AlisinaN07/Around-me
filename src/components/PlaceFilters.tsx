import { Ionicons } from '@expo/vector-icons';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { CategoryChip } from '@/components/CategoryChip';
import { PLACE_CATEGORIES } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';

type PlaceFiltersProps = {
  cityLabel: string;
  query: string;
  onQueryChange: (query: string) => void;
  selectedCategory: string;
  onSelectCategory: (categoryId: string) => void;
};

/**
 * Presentational search box + category chip row — the same filter controls
 * used both by MapPlaceExplorer (web/Android list) and the iOS native map
 * screen. Purely controlled; all fetching/filtering lives in useCityPlaces.
 */
export function PlaceFilters({ cityLabel, query, onQueryChange, selectedCategory, onSelectCategory }: PlaceFiltersProps) {
  return (
    <>
      <View style={styles.searchRow}>
        <Ionicons name="search-outline" size={18} color={Colors.textSecondary} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={onQueryChange}
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
        <CategoryChip label="All" icon="apps-outline" selected={selectedCategory === 'all'} onPress={() => onSelectCategory('all')} />
        {PLACE_CATEGORIES.map((category) => (
          <CategoryChip
            key={category.id}
            label={category.label}
            icon={category.icon}
            selected={selectedCategory === category.id}
            onPress={() => onSelectCategory(category.id)}
          />
        ))}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
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
