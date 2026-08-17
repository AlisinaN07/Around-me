import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getPlaceCategory } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { fetchCityPlaces } from '@/services/places';
import type { Place } from '@/types/place';
import { PLACE_NAME_MAX_LENGTH } from '@/types/place';

export type PlaceSelectorValue = { placeId: string | null; placeName: string };

type PlaceSelectorProps = {
  label: string;
  cityKey: string;
  cityLabel: string;
  value: PlaceSelectorValue;
  onChange: (value: PlaceSelectorValue) => void;
  error?: string;
};

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * One reusable place picker for Create Post/Activity/Event: search a known
 * Place in the current city, or fall back to a manually-typed place name.
 * Selecting a known Place never creates one — see src/services/places.ts
 * and firestore.rules (places are read-only from the client).
 */
export function PlaceSelector({ label, cityKey, cityLabel, value, onChange, error }: PlaceSelectorProps) {
  const [mode, setMode] = useState<'known' | 'custom'>('known');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');

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

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return places;
    return places.filter((place) => place.name.toLowerCase().includes(trimmed));
  }, [places, query]);

  const switchToCustom = () => {
    setIsModalOpen(false);
    setMode('custom');
    onChange({ placeId: null, placeName: '' });
  };

  const switchToKnown = () => {
    setMode('known');
    onChange({ placeId: null, placeName: '' });
  };

  if (mode === 'custom') {
    return (
      <View style={styles.container}>
        <Text style={styles.label}>{label}</Text>
        <View style={[styles.customInputRow, error && styles.inputError]}>
          <TextInput
            style={styles.customInput}
            value={value.placeName}
            onChangeText={(text) => onChange({ placeId: null, placeName: text })}
            placeholder="Enter a place name"
            placeholderTextColor={Colors.textSecondary}
            maxLength={PLACE_NAME_MAX_LENGTH}
          />
        </View>
        <Pressable onPress={switchToKnown} accessibilityRole="button">
          <Text style={styles.linkText}>Choose from known places instead</Text>
        </Pressable>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        style={[styles.trigger, error && styles.inputError]}
        onPress={() => setIsModalOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Search places in ${cityLabel}`}
      >
        <Ionicons name="location-outline" size={18} color={Colors.textSecondary} />
        <Text style={value.placeName ? styles.triggerValue : styles.triggerPlaceholder} numberOfLines={1}>
          {value.placeName || `Search places in ${cityLabel}`}
        </Text>
      </Pressable>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      <Modal visible={isModalOpen} animationType="slide" onRequestClose={() => setIsModalOpen(false)}>
        <SafeAreaView style={styles.modalSafeArea}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select a place</Text>
            <Pressable onPress={() => setIsModalOpen(false)} hitSlop={12} accessibilityRole="button">
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder={`Search places in ${cityLabel}`}
            placeholderTextColor={Colors.textSecondary}
            autoCorrect={false}
          />

          {status === 'loading' ? (
            <View style={styles.centered}>
              <ActivityIndicator color={Colors.accent} />
            </View>
          ) : status === 'error' ? (
            <View style={styles.centered}>
              <Text style={styles.mutedText}>Couldn&apos;t load places.</Text>
              <Pressable onPress={load} accessibilityRole="button">
                <Text style={styles.linkText}>Try again</Text>
              </Pressable>
            </View>
          ) : filtered.length === 0 ? (
            <View style={styles.centered}>
              <Text style={styles.mutedText}>
                {places.length === 0 ? `No known places in ${cityLabel} yet.` : 'No places match your search.'}
              </Text>
            </View>
          ) : (
            <FlatList
              data={filtered}
              keyExtractor={(item) => item.placeId}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const category = getPlaceCategory(item.categoryId);
                return (
                  <Pressable
                    style={styles.row}
                    onPress={() => {
                      onChange({ placeId: item.placeId, placeName: item.name });
                      setQuery('');
                      setIsModalOpen(false);
                    }}
                  >
                    <View style={styles.rowText}>
                      <Text style={styles.rowName}>{item.name}</Text>
                      <Text style={styles.rowMeta}>
                        {category ? `${category.label} · ` : ''}
                        {item.address}
                      </Text>
                    </View>
                  </Pressable>
                );
              }}
            />
          )}

          <Pressable style={styles.customRow} onPress={switchToCustom} accessibilityRole="button">
            <Text style={styles.linkText}>Can&apos;t find it? Use custom place</Text>
          </Pressable>
        </SafeAreaView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.xs,
  },
  label: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  triggerValue: {
    flex: 1,
    color: Colors.text,
    fontSize: 16,
  },
  triggerPlaceholder: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 16,
  },
  inputError: {
    borderColor: Colors.error,
  },
  errorText: {
    color: Colors.error,
    fontSize: 12,
  },
  customInputRow: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  customInput: {
    color: Colors.text,
    fontSize: 16,
    paddingVertical: Spacing.md,
  },
  linkText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  modalSafeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  modalTitle: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  modalClose: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  search: {
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    color: Colors.text,
    fontSize: 16,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  mutedText: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
  row: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowText: {
    gap: 2,
  },
  rowName: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  rowMeta: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  customRow: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
