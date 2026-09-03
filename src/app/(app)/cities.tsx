import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { searchCities, type City } from '@/constants/cities';
import { useCity } from '@/providers/CityProvider';

/**
 * City Explorer / switcher — sets Active City only (see
 * src/providers/CityProvider.tsx). Never touches the signed-in user's Home
 * City profile fields. No map, no GPS, no external city API — a search
 * over the static catalog in src/constants/cities.ts.
 */
export default function CitiesScreen() {
  const { homeCity, activeCity, isExploringAnotherCity, setActiveCity, resetToHomeCity } = useCity();
  const [query, setQuery] = useState('');

  const exploreCities = useMemo(() => {
    const results = searchCities(query);
    // Home City gets its own section above — never duplicated here, even
    // when it's one of the catalog cities (the common case).
    return homeCity ? results.filter((city) => city.cityKey !== homeCity.cityKey) : results;
  }, [query, homeCity]);

  const handleSelect = (city: City) => {
    setActiveCity(city);
    router.back();
  };

  const handleBackToHome = () => {
    resetToHomeCity();
    router.back();
  };

  return (
    <HeaderScreenLayout title="Choose a city">
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={18} color={Colors.textSecondary} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search cities"
          placeholderTextColor={Colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="words"
          autoCorrect={false}
        />
      </View>

      {isExploringAnotherCity && (
        <Pressable style={styles.backToHomeButton} onPress={handleBackToHome} accessibilityRole="button">
          <Ionicons name="home" size={16} color={Colors.accent} />
          <Text style={styles.backToHomeText}>Back to {homeCity?.cityName}</Text>
        </Pressable>
      )}

      {homeCity ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Home</Text>
          <View style={styles.cityList}>
            <CityRow
              city={homeCity}
              isActive={activeCity?.cityKey === homeCity.cityKey}
              subtitle="Your home city"
              onPress={() => handleSelect(homeCity)}
              isLast
            />
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Explore</Text>
        {exploreCities.length === 0 ? (
          <Text style={styles.noResultsText}>No cities match &quot;{query}&quot;.</Text>
        ) : (
          <View style={styles.cityList}>
            {exploreCities.map((city, index) => (
              <CityRow
                key={city.cityKey}
                city={city}
                isActive={activeCity?.cityKey === city.cityKey}
                onPress={() => handleSelect(city)}
                isLast={index === exploreCities.length - 1}
              />
            ))}
          </View>
        )}
      </View>
    </HeaderScreenLayout>
  );
}

function CityRow({
  city,
  isActive,
  subtitle,
  onPress,
  isLast,
}: {
  city: City;
  isActive: boolean;
  subtitle?: string;
  onPress: () => void;
  isLast?: boolean;
}) {
  return (
    <Pressable
      style={[styles.row, isLast && styles.rowLast]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{city.cityName}</Text>
        <Text style={styles.rowSubtitle}>{subtitle ?? city.countryName}</Text>
      </View>
      {isActive ? <Ionicons name="checkmark-circle" size={22} color={Colors.accent} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  searchIcon: {
    marginTop: 1,
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    color: Colors.text,
    fontSize: 15,
  },
  backToHomeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingVertical: Spacing.sm,
  },
  backToHomeText: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  section: {
    gap: Spacing.xs,
  },
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    marginBottom: 2,
  },
  cityList: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    minHeight: 56,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowText: {
    gap: 2,
  },
  rowTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  rowSubtitle: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  noResultsText: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: Spacing.lg,
  },
});
