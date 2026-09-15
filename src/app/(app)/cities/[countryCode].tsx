import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { citiesForCountry } from '@/constants/cities';
import { COUNTRIES } from '@/constants/countries';
import { useCity } from '@/providers/CityProvider';

/**
 * The drill-down screen after tapping a Country in the City Explorer
 * (src/app/(app)/cities.tsx) — lets the caller either explore the WHOLE
 * country (no specific city) or hand-pick one or more catalog cities
 * inside it (checkboxes, not single-select — see handleToggleCity).
 * Reached as `/cities/{countryCode}`; `countryCode` is only ever a real
 * ISO code from src/constants/countries.ts (cities.tsx only ever links
 * here with one), so an unrecognized value is treated as a load error
 * rather than silently falling back to some default country.
 *
 * Selection starts pre-checked from whatever of the Active Scope already
 * falls inside this country (a single matching City, or the overlap of a
 * 'cities' scope) — never derived from Home City, so revisiting this
 * screen always reflects what's actually being browsed right now.
 *
 * Finishing EITHER way (tapping "All of {country}", or "Explore N
 * cities") pops BOTH this screen and the City Explorer screen underneath
 * it (two router.back() calls) — the same "one tap, back to wherever
 * /cities was opened from" behavior picking a city straight from
 * cities.tsx's own Explore list already has, not left one level short on
 * the City Explorer.
 */
export default function CountryCitiesScreen() {
  const { countryCode } = useLocalSearchParams<{ countryCode: string }>();
  const { activeScope, setActiveCities, setActiveCountry } = useCity();
  const [query, setQuery] = useState('');

  const country = useMemo(() => COUNTRIES.find((candidate) => candidate.code === countryCode), [countryCode]);

  const allCitiesInCountry = useMemo(() => citiesForCountry(countryCode ?? ''), [countryCode]);

  // Seeded once from the CURRENT Active Scope, not re-synced afterward —
  // this is a plain "start from what's already active" default, the same
  // one-time-at-mount treatment a form's initial value gets elsewhere in
  // this app, not a value this screen needs to keep tracking live.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => {
    if (activeScope.kind === 'city') {
      return allCitiesInCountry.some((city) => city.cityKey === activeScope.cityKey) ? new Set([activeScope.cityKey]) : new Set();
    }
    if (activeScope.kind === 'cities') {
      const countryKeys = new Set(allCitiesInCountry.map((city) => city.cityKey));
      return new Set(activeScope.cityKeys.filter((key) => countryKeys.has(key)));
    }
    return new Set();
  });

  const cities = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery ? allCitiesInCountry.filter((city) => city.cityName.toLowerCase().includes(normalizedQuery)) : allCitiesInCountry;
  }, [allCitiesInCountry, query]);

  const goBackTwice = () => {
    router.back();
    router.back();
  };

  const handleSelectWholeCountry = () => {
    if (!country) return;
    setActiveCountry(country);
    goBackTwice();
  };

  const handleToggleCity = (cityKey: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(cityKey)) {
        next.delete(cityKey);
      } else {
        next.add(cityKey);
      }
      return next;
    });
  };

  const handleApplySelection = () => {
    if (selectedKeys.size === 0) return;
    setActiveCities([...selectedKeys]);
    goBackTwice();
  };

  if (!country) {
    return (
      <HeaderScreenLayout title="Choose a city">
        <Text style={styles.noResultsText}>Couldn&apos;t load this country.</Text>
      </HeaderScreenLayout>
    );
  }

  return (
    <HeaderScreenLayout title={country.name}>
      {allCitiesInCountry.length > 0 ? (
        <View style={styles.searchWrap}>
          <Ionicons name="search-outline" size={18} color={Colors.textSecondary} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder={`Search cities in ${country.name}`}
            placeholderTextColor={Colors.textSecondary}
            value={query}
            onChangeText={setQuery}
            autoCapitalize="words"
            autoCorrect={false}
          />
        </View>
      ) : null}

      <View style={styles.section}>
        <View style={styles.cityList}>
          <Pressable
            style={[styles.row, styles.rowLast]}
            onPress={handleSelectWholeCountry}
            accessibilityRole="button"
            accessibilityState={{ selected: activeScope.kind === 'country' && activeScope.countryCode === country.code }}
          >
            <View style={styles.rowIconWrap}>
              <Ionicons name="flag-outline" size={20} color={Colors.text} />
            </View>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>All of {country.name}</Text>
              <Text style={styles.rowSubtitle}>Don&apos;t pick a specific city</Text>
            </View>
            {activeScope.kind === 'country' && activeScope.countryCode === country.code ? (
              <Ionicons name="checkmark-circle" size={22} color={Colors.accent} />
            ) : null}
          </Pressable>
        </View>
      </View>

      {allCitiesInCountry.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>Cities — pick one or more</Text>
          <View style={styles.cityList}>
            {cities.map((city, index) => {
              const isSelected = selectedKeys.has(city.cityKey);
              return (
                <Pressable
                  key={city.cityKey}
                  style={[styles.row, index === cities.length - 1 && styles.rowLast]}
                  onPress={() => handleToggleCity(city.cityKey)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle}>{city.cityName}</Text>
                  </View>
                  <Ionicons
                    name={isSelected ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={isSelected ? Colors.accent : Colors.textSecondary}
                  />
                </Pressable>
              );
            })}
          </View>
          <View style={styles.applyButton}>
            <Button
              label={selectedKeys.size > 0 ? `Explore ${selectedKeys.size} ${selectedKeys.size === 1 ? 'city' : 'cities'}` : 'Select a city'}
              onPress={handleApplySelection}
              disabled={selectedKeys.size === 0}
            />
          </View>
        </View>
      ) : (
        <Text style={styles.noResultsText}>No specific cities available yet for {country.name} — explore the whole country instead.</Text>
      )}
    </HeaderScreenLayout>
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
  applyButton: {
    marginTop: Spacing.sm,
  },
  noResultsText: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: Spacing.lg,
  },
});
