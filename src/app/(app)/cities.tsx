import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { searchCities, type City } from '@/constants/cities';
import { COUNTRIES, type Country } from '@/constants/countries';
import { useCity } from '@/providers/CityProvider';

/**
 * City/Country/World Explorer / switcher — sets Active Scope only (see
 * src/providers/CityProvider.tsx). Never touches the signed-in user's Home
 * City profile fields. No map, no GPS, no external city/country API — a
 * search over the static catalogs in src/constants/cities.ts and
 * src/constants/countries.ts.
 */
export default function CitiesScreen() {
  const { homeCity, activeScope, isExploringElsewhere, setActiveCity, setActiveWorld, resetToHomeCity } = useCity();
  const [query, setQuery] = useState('');

  const homeCountry = useMemo(() => (homeCity ? COUNTRIES.find((country) => country.code === homeCity.countryCode) : undefined), [homeCity]);

  const exploreCities = useMemo(() => {
    const results = searchCities(query);
    // Home City gets its own section above — never duplicated here, even
    // when it's one of the catalog cities (the common case).
    return homeCity ? results.filter((city) => city.cityKey !== homeCity.cityKey) : results;
  }, [query, homeCity]);

  const exploreCountries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const results = normalizedQuery ? COUNTRIES.filter((country) => country.name.toLowerCase().includes(normalizedQuery)) : COUNTRIES;
    // Home Country gets its own row above — never duplicated here.
    return homeCountry ? results.filter((country) => country.code !== homeCountry.code) : results;
  }, [query, homeCountry]);

  const handleSelectCity = (city: City) => {
    setActiveCity(city);
    router.back();
  };

  // Opens the drill-down screen (src/app/(app)/cities/[countryCode].tsx) —
  // choosing a country here is never final by itself; that screen is what
  // actually applies either "the whole country" or one specific city
  // inside it, then pops both screens back to wherever /cities was opened
  // from.
  const handleSelectCountry = (country: Country) => {
    router.push(`/cities/${country.code}`);
  };

  const handleSelectWorld = () => {
    setActiveWorld();
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
          placeholder="Search cities or countries"
          placeholderTextColor={Colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="words"
          autoCorrect={false}
        />
      </View>

      {isExploringElsewhere && (
        <Pressable style={styles.backToHomeButton} onPress={handleBackToHome} accessibilityRole="button">
          <Ionicons name="home" size={16} color={Colors.accent} />
          <Text style={styles.backToHomeText}>Back to {homeCity?.cityName}</Text>
        </Pressable>
      )}

      <View style={styles.section}>
        <View style={styles.cityList}>
          <Pressable
            style={[styles.row, styles.rowLast]}
            onPress={handleSelectWorld}
            accessibilityRole="button"
            accessibilityState={{ selected: activeScope.kind === 'world' }}
          >
            <View style={styles.rowIconWrap}>
              <Ionicons name="globe-outline" size={20} color={Colors.text} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>Worldwide</Text>
              <Text style={styles.rowSubtitle}>Every city, every country</Text>
            </View>
            {activeScope.kind === 'world' ? <Ionicons name="checkmark-circle" size={22} color={Colors.accent} /> : null}
          </Pressable>
        </View>
      </View>

      {homeCity ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Home</Text>
          <View style={styles.cityList}>
            <CityRow
              city={homeCity}
              isActive={activeScope.kind === 'city' && activeScope.cityKey === homeCity.cityKey}
              subtitle="Your home city"
              onPress={() => handleSelectCity(homeCity)}
              isLast
            />
          </View>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Country</Text>
        <View style={styles.cityList}>
          {homeCountry ? (
            <CountryRow
              country={homeCountry}
              isActive={activeScope.kind === 'country' && activeScope.countryCode === homeCountry.code}
              subtitle="Your home country"
              onPress={() => handleSelectCountry(homeCountry)}
              isLast={exploreCountries.length === 0}
            />
          ) : null}
          {exploreCountries.map((country, index) => (
            <CountryRow
              key={country.code}
              country={country}
              isActive={activeScope.kind === 'country' && activeScope.countryCode === country.code}
              onPress={() => handleSelectCountry(country)}
              isLast={index === exploreCountries.length - 1}
            />
          ))}
        </View>
      </View>

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
                isActive={activeScope.kind === 'city' && activeScope.cityKey === city.cityKey}
                onPress={() => handleSelectCity(city)}
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

function CountryRow({
  country,
  isActive,
  subtitle,
  onPress,
  isLast,
}: {
  country: Country;
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
        <Text style={styles.rowTitle}>{country.name}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
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
  rowIconWrap: {
    width: 32,
    alignItems: 'center',
  },
  rowText: {
    flex: 1,
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
