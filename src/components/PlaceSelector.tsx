import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { getPlaceCategory } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { searchAddresses, type AddressSearchResult } from '@/services/geocoding';
import { fetchCityPlaces } from '@/services/places';
import type { Place } from '@/types/place';
import { PLACE_NAME_MAX_LENGTH } from '@/types/place';

export type PlaceSelectorValue = { placeId: string | null; placeName: string };

// Same debounce value Edit Profile's own username-availability check
// uses (AVAILABILITY_DEBOUNCE_MS) — one shared convention for "wait for
// the user to stop typing before firing a network request," not a
// per-keystroke call. Nominatim's own usage policy asks for no more than
// ~1 request/second; a 600ms pause between keystrokes comfortably stays
// under that for normal typing.
const ADDRESS_SEARCH_DEBOUNCE_MS = 600;
// Below this many characters, a live geocoder query is more noise than
// signal (and burns through Nominatim's fair-use budget for nothing) —
// wait for a real fragment of a name or address first.
const MIN_ADDRESS_QUERY_LENGTH = 3;

// The completed result (or error) for one specific query string — never a
// bare "loading" flag set synchronously inside the debounce effect (see
// that effect's own comment for why): whether a search is still pending
// is DERIVED at render time by comparing this to the current trimmedQuery,
// the exact same technique Edit Profile's own username-availability check
// already uses (usernameAvailability's 'checking' branch).
type AddressSearchOutcome = { query: string; results: AddressSearchResult[] } | { query: string; error: true };

type PlaceSelectorProps = {
  label: string;
  cityKey: string;
  value: PlaceSelectorValue;
  onChange: (value: PlaceSelectorValue) => void;
  error?: string;
};

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * One reusable place picker for Create Post/Activity/Event: search a known
 * Place in the current city, search real-world addresses live, or fall
 * back to a manually-typed place name. A live address result is treated
 * exactly like a manually-typed one — `{ placeId: null, placeName:
 * <the real address> }` — never a new places/{placeId} document: Places
 * stay a curated, read-only-from-the-client, admin-populated collection
 * (see src/services/places.ts's own doc comment); this only makes the
 * ALREADY-EXISTING custom-place path faster to fill in with a real,
 * precise address instead of hand-typing one. Selecting a known Place
 * still never creates one either — see firestore.rules (places are
 * read-only from the client).
 */
export function PlaceSelector({ label, cityKey, value, onChange, error }: PlaceSelectorProps) {
  const [mode, setMode] = useState<'known' | 'custom'>('known');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[]>([]);
  const [status, setStatus] = useState<LoadStatus>('loading');

  const [addressOutcome, setAddressOutcome] = useState<AddressSearchOutcome | null>(null);

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

  const trimmedQuery = query.trim();

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return places;
    return places.filter((place) => place.name.toLowerCase().includes(trimmed));
  }, [places, query]);

  useEffect(() => {
    const trimmed = query.trim();
    // Nothing to fire below this length — see addressSearchStatus's own
    // render-time handling of this same case just below.
    if (trimmed.length < MIN_ADDRESS_QUERY_LENGTH) return;
    let cancelled = false;
    const timeout = setTimeout(async () => {
      try {
        // Deliberately unrestricted — see searchAddresses's own doc
        // comment for why this never scopes to cityKey.
        const results = await searchAddresses(trimmed);
        if (cancelled) return;
        setAddressOutcome({ query: trimmed, results });
      } catch {
        if (cancelled) return;
        setAddressOutcome({ query: trimmed, error: true });
      }
    }, ADDRESS_SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [query]);

  // Derived, not stored — 'loading' covers both "still debouncing" and "the
  // request for this exact query is in flight," since addressOutcome only
  // ever updates once a search for the CURRENT trimmedQuery actually
  // completes. Same technique as Edit Profile's usernameAvailability.
  const addressSearchStatus: 'loading' | 'loaded' | 'error' =
    addressOutcome?.query !== trimmedQuery ? 'loading' : 'error' in addressOutcome ? 'error' : 'loaded';
  const addressResults = addressOutcome?.query === trimmedQuery && 'results' in addressOutcome ? addressOutcome.results : [];

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
          <Ionicons name="create-outline" size={18} color={Colors.textSecondary} />
          <TextInput
            style={styles.customInput}
            value={value.placeName}
            onChangeText={(text) => onChange({ placeId: null, placeName: text })}
            placeholder="Enter a place name"
            placeholderTextColor={Colors.textSecondary}
            maxLength={PLACE_NAME_MAX_LENGTH}
          />
        </View>
        {/* Manual text, not a saved Place — visually distinct from the pin
            icon + accent border a known Place gets below, so it never
            reads as a verified/pinned location (Step 31). */}
        <Text style={styles.customHint}>Typed manually — not a saved place.</Text>
        <Pressable onPress={switchToKnown} accessibilityRole="button">
          <Text style={styles.linkText}>Choose from known places instead</Text>
        </Pressable>
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
    );
  }

  const hasKnownPlace = !!value.placeId;

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        style={[styles.trigger, hasKnownPlace && styles.triggerSelected, error && styles.inputError]}
        onPress={() => setIsModalOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Search places or addresses"
      >
        <Ionicons name={hasKnownPlace ? 'location' : 'location-outline'} size={18} color={hasKnownPlace ? Colors.accent : Colors.textSecondary} />
        <Text style={value.placeName ? styles.triggerValue : styles.triggerPlaceholder} numberOfLines={1}>
          {value.placeName || 'Search places or addresses'}
        </Text>
        {hasKnownPlace ? <Ionicons name="checkmark-circle" size={16} color={Colors.accent} /> : null}
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
            placeholder="Search places or type any address"
            placeholderTextColor={Colors.textSecondary}
            autoCorrect={false}
          />

          <ScrollView style={styles.resultsScroll} keyboardShouldPersistTaps="handled">
            {status === 'loading' ? (
              <View style={styles.centered}>
                <ActivityIndicator color={Colors.accent} />
              </View>
            ) : status === 'error' ? (
              <View style={styles.centered}>
                <Text style={styles.mutedText}>Couldn&apos;t load known places.</Text>
                <Pressable onPress={load} accessibilityRole="button">
                  <Text style={styles.linkText}>Try again</Text>
                </Pressable>
              </View>
            ) : (
              <>
                {filtered.length > 0 ? (
                  <>
                    <Text style={styles.sectionLabel}>Known places</Text>
                    {filtered.map((item) => {
                      const category = getPlaceCategory(item.categoryId);
                      return (
                        <Pressable
                          key={item.placeId}
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
                    })}
                  </>
                ) : null}

                {trimmedQuery.length >= MIN_ADDRESS_QUERY_LENGTH ? (
                  <>
                    <Text style={styles.sectionLabel}>Search results</Text>
                    {addressSearchStatus === 'loading' ? (
                      <View style={styles.centered}>
                        <ActivityIndicator color={Colors.accent} />
                      </View>
                    ) : addressSearchStatus === 'error' ? (
                      <View style={styles.centered}>
                        <Text style={styles.mutedText}>Couldn&apos;t search addresses right now.</Text>
                      </View>
                    ) : addressResults.length === 0 ? (
                      <View style={styles.centered}>
                        <Text style={styles.mutedText}>No addresses found.</Text>
                      </View>
                    ) : (
                      <>
                        {addressResults.map((result) => (
                          <Pressable
                            key={result.id}
                            style={[styles.row, styles.addressRow]}
                            onPress={() => {
                              onChange({ placeId: null, placeName: result.fullLine.slice(0, PLACE_NAME_MAX_LENGTH) });
                              setQuery('');
                              setIsModalOpen(false);
                            }}
                          >
                            {/* A distinct icon for the two kinds of result — see
                                AddressSearchResult['kind']'s own doc comment: a
                                named venue ('place') vs. a bare street ('address'). */}
                            <Ionicons
                              name={result.kind === 'place' ? 'business-outline' : 'location-outline'}
                              size={16}
                              color={Colors.textSecondary}
                              style={styles.addressRowIcon}
                            />
                            <View style={styles.rowText}>
                              <Text style={styles.rowName} numberOfLines={1}>
                                {result.primaryLine}
                              </Text>
                              {result.secondaryLine ? (
                                <Text style={styles.rowMeta} numberOfLines={1}>
                                  {result.secondaryLine}
                                </Text>
                              ) : null}
                            </View>
                          </Pressable>
                        ))}
                        {/* Nominatim's usage policy requires this attribution
                            wherever a result is shown — see
                            src/services/geocoding.ts's own doc comment. */}
                        <Text style={styles.attribution}>Search results © OpenStreetMap contributors</Text>
                      </>
                    )}
                  </>
                ) : null}

                {filtered.length === 0 && trimmedQuery.length < MIN_ADDRESS_QUERY_LENGTH ? (
                  <View style={styles.centered}>
                    <Text style={styles.mutedText}>
                      {places.length === 0
                        ? 'No known places yet — type to search any address.'
                        : 'Type to search any address, or pick a known place above.'}
                    </Text>
                  </View>
                ) : null}
              </>
            )}
          </ScrollView>

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
  triggerSelected: {
    borderColor: Colors.accent,
  },
  inputError: {
    borderColor: Colors.error,
  },
  errorText: {
    color: Colors.error,
    fontSize: 12,
  },
  customInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  customInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 16,
    paddingVertical: Spacing.md,
  },
  customHint: {
    color: Colors.textMuted,
    fontSize: 11,
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
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.xl,
    // Was flex: 1 when this was the FlatList's sole direct child; now it
    // sits inside a plain ScrollView alongside other sections, so it
    // needs real vertical breathing room of its own instead.
    paddingVertical: Spacing.xl,
  },
  mutedText: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
  },
  resultsScroll: {
    flex: 1,
  },
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.xs,
  },
  row: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowName: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  rowMeta: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  addressRowIcon: {
    marginTop: 2,
  },
  attribution: {
    color: Colors.textMuted,
    fontSize: 11,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  customRow: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
