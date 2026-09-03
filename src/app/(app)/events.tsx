import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { CategoryChip } from '@/components/CategoryChip';
import { EventCard } from '@/components/EventCard';
import { SegmentedControl } from '@/components/SegmentedControl';
import { KARLSTAD_LAUNCH_CATEGORIES } from '@/constants/launchCategories';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useCity } from '@/providers/CityProvider';
import { fetchDiscoverySections } from '@/services/content';
import type { ActivityContent, EventContent } from '@/types/content';

type LoadStatus = 'loading' | 'loaded' | 'error';
type TypeFilter = 'all' | 'events' | 'activities';

const TYPE_FILTER_OPTIONS: { id: TypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'events', label: 'Events' },
  { id: 'activities', label: 'Activities' },
];

// Bounded per section (happening/today/upcoming), matching the "30
// initial, no infinite scroll" recommendation for this screen — see
// Section 43 of the Step 22 spec. Three sections at 15 each caps the
// total at 45 real Firestore reads per visit, close to that figure
// without an extra client-side truncation step that could otherwise hide
// results a filter would have matched further down an unsliced list.
const SECTION_LIMIT = 15;

export default function EventsScreen() {
  const { activeCity, homeCity, isExploringAnotherCity, isReady: isCityReady } = useCity();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [items, setItems] = useState<(ActivityContent | EventContent)[]>([]);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const cityLabel = activeCity?.cityName ?? 'your city';

  const load = useCallback(async () => {
    if (!activeCity) return;
    setStatus('loading');
    setItems([]);
    try {
      const sections = await fetchDiscoverySections(activeCity.cityKey, SECTION_LIMIT);
      // Already time-ordered within each bucket (see fetchDiscoverySections);
      // concatenating in this order satisfies "happening now first, then
      // startsAt ascending" (Section 23) without a second sort pass.
      setItems([...sections.happeningNow, ...sections.today, ...sections.upcoming]);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [activeCity]);

  useFocusEffect(
    useCallback(() => {
      if (!isCityReady) return;
      load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeCity?.cityKey, isCityReady])
  );

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (typeFilter === 'events' && item.type !== 'event') return false;
      if (typeFilter === 'activities' && item.type !== 'activity') return false;
      if (categoryFilter && item.categoryId !== categoryFilter) return false;
      return true;
    });
  }, [items, typeFilter, categoryFilter]);

  const canCreateHere = !!homeCity && !isExploringAnotherCity;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          Events in {cityLabel}
        </Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.page}>
          <SegmentedControl options={TYPE_FILTER_OPTIONS} value={typeFilter} onChange={setTypeFilter} />

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.horizontalScroll}
            contentContainerStyle={styles.chipsRow}
          >
            <CategoryChip
              label="All categories"
              icon="apps-outline"
              selected={categoryFilter === null}
              onPress={() => setCategoryFilter(null)}
            />
            {KARLSTAD_LAUNCH_CATEGORIES.map((category) => (
              <CategoryChip
                key={category.interestId}
                label={category.label}
                icon="pricetag-outline"
                selected={categoryFilter === category.interestId}
                onPress={() => setCategoryFilter(category.interestId)}
              />
            ))}
          </ScrollView>

          {status === 'error' ? (
            <View style={styles.emptyPanel}>
              <Ionicons name="cloud-offline-outline" size={28} color={Colors.textSecondary} />
              <Text style={styles.emptyTitle}>Couldn&apos;t load events in {cityLabel}.</Text>
              <Button label="Try again" onPress={load} />
            </View>
          ) : status === 'loading' ? (
            <View style={styles.emptyPanel}>
              <Text style={styles.emptyBody}>Loading…</Text>
            </View>
          ) : filteredItems.length === 0 ? (
            <View style={styles.emptyPanel}>
              {items.length === 0 ? (
                isExploringAnotherCity ? (
                  <>
                    <Text style={styles.emptyTitle}>No upcoming events in {cityLabel} yet.</Text>
                    <Text style={styles.emptyBody}>Explore another city or check back later.</Text>
                    <Button label="Explore another city" variant="secondary" onPress={() => router.push('/cities')} />
                  </>
                ) : (
                  <>
                    <Text style={styles.emptyTitle}>No upcoming events in {cityLabel} yet.</Text>
                    <Text style={styles.emptyBody}>Know something happening? Create an event.</Text>
                    <Button label="Create event" onPress={() => router.push('/create/event')} />
                  </>
                )
              ) : (
                <Text style={styles.emptyBody}>Nothing matches this filter yet.</Text>
              )}
            </View>
          ) : (
            <View style={styles.grid}>
              {filteredItems.map((item) => (
                <EventCard key={item.contentId} item={item} />
              ))}
            </View>
          )}

          {status === 'loaded' && items.length > 0 ? (
            <View style={styles.createFooter}>
              <Button
                label={canCreateHere ? 'Create event' : `Create in ${homeCity?.cityName ?? 'your home city'}`}
                variant="secondary"
                onPress={() => router.push('/create/event')}
              />
              {!canCreateHere && homeCity ? (
                <Text style={styles.createFooterHint}>Your events publish to {homeCity.cityName}, your home city.</Text>
              ) : null}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  headerSpacer: {
    width: 40,
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    paddingHorizontal: Spacing.lg,
    gap: Spacing.md,
  },
  horizontalScroll: {
    flexGrow: 0,
    flexShrink: 0,
    marginHorizontal: -Spacing.lg,
  },
  chipsRow: {
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  grid: {
    gap: Spacing.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  emptyPanel: {
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
  emptyBody: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  createFooter: {
    marginTop: Spacing.md,
    alignItems: 'center',
    gap: 4,
  },
  createFooterHint: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
});
