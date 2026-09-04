import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { EventCard } from '@/components/EventCard';
import { EventFilterSheet, type EventTypeFilter } from '@/components/EventFilterSheet';
import { LoadingState } from '@/components/LoadingState';
import { Pill } from '@/components/Pill';
import { SectionHeader } from '@/components/SectionHeader';
import { Colors, Layout, Radius, Spacing, Typography } from '@/constants/theme';
import { useProfile } from '@/hooks/useProfile';
import { useCity } from '@/providers/CityProvider';
import { fetchDiscoverySections, type DiscoverySections } from '@/services/content';
import type { ActivityContent, EventContent } from '@/types/content';
import { canCreateEvent } from '@/utils/accountCapabilities';
import { getWeekendWindow } from '@/utils/dateWindows';

type LoadStatus = 'loading' | 'loaded' | 'error';

// Bounded per section (happening/today/upcoming), matching the "30
// initial, no infinite scroll" recommendation for this screen — see
// Section 43 of the Step 22 spec. Three sections at 15 each caps the
// total at 45 real Firestore reads per visit. Step 26 only changes how
// this same bounded result set is laid out and split (This Weekend vs.
// Coming Up is a client-side split of `upcoming`, not a new query).
const SECTION_LIMIT = 15;

/**
 * Events — official/local Event & Activity discovery (Step 26 visual
 * reconstruction). Deliberately the ONLY place in the app that shows
 * event-style discovery content; Home is the separate user-generated Reel
 * feed (see src/app/(app)/(tabs)/index.tsx and the Step 25 product-
 * separation rule). Still backed entirely by the unchanged
 * fetchDiscoverySections/dateWindows architecture from Step 22 — this step
 * only redesigns layout, adds a real "This Weekend" split of the existing
 * Upcoming window, and moves Interested/Going/Join actions onto the
 * discovery cards themselves.
 */
export default function EventsScreen() {
  const { activeCity, homeCity, isExploringAnotherCity, isReady: isCityReady } = useCity();
  const { profile } = useProfile();
  const canCreateEventHere = canCreateEvent(profile);
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [sections, setSections] = useState<DiscoverySections | null>(null);
  const [typeFilter, setTypeFilter] = useState<EventTypeFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const cityLabel = activeCity?.cityName ?? 'your city';

  const load = useCallback(async () => {
    if (!activeCity) return;
    setStatus('loading');
    // Clears the previous city's sections immediately so a city switch
    // never leaves a stale city's cards on screen during the fetch (same
    // rule every other discovery surface in this app follows).
    setSections(null);
    try {
      const result = await fetchDiscoverySections(activeCity.cityKey, SECTION_LIMIT);
      setSections(result);
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

  const matchesFilters = useCallback(
    (item: ActivityContent | EventContent) => {
      if (typeFilter === 'events' && item.type !== 'event') return false;
      if (typeFilter === 'activities' && item.type !== 'activity') return false;
      if (categoryFilter && item.categoryId !== categoryFilter) return false;
      return true;
    },
    [typeFilter, categoryFilter]
  );

  const happeningNow = useMemo(() => (sections ? sections.happeningNow.filter(matchesFilters) : []), [sections, matchesFilters]);
  const today = useMemo(() => (sections ? sections.today.filter(matchesFilters) : []), [sections, matchesFilters]);
  const upcomingAll = useMemo(() => (sections ? sections.upcoming.filter(matchesFilters) : []), [sections, matchesFilters]);

  // "This Weekend" is a real (Sat+Sun, Europe/Stockholm) client-side split
  // of the already-fetched Upcoming window — see getWeekendWindow. If
  // nothing in the current Upcoming page happens to fall on a real
  // weekend right now, the section is simply omitted (never mislabeled) and
  // everything renders under "Coming Up" instead (Step 26 Section 17).
  const weekendSplit = useMemo(() => {
    const weekend = getWeekendWindow();
    const weekendIds = new Set(
      upcomingAll
        .filter((item) => {
          const startMs = item.startsAt.toMillis();
          return startMs >= weekend.start.getTime() && startMs < weekend.end.getTime();
        })
        .map((item) => item.contentId)
    );
    const thisWeekend = upcomingAll.filter((item) => weekendIds.has(item.contentId));
    const comingUp = weekendIds.size > 0 ? upcomingAll.filter((item) => !weekendIds.has(item.contentId)) : upcomingAll;
    return { thisWeekend, comingUp };
  }, [upcomingAll]);
  const thisWeekend = weekendSplit.thisWeekend;
  const comingUp = weekendSplit.comingUp;

  const totalRealItems = sections ? sections.happeningNow.length + sections.today.length + sections.upcoming.length : 0;
  const totalFilteredItems = happeningNow.length + today.length + upcomingAll.length;
  const canCreateHere = !!homeCity && !isExploringAnotherCity;
  const isFilterActive = typeFilter !== 'all' || categoryFilter !== null;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.push('/cities')} style={styles.cityButton} accessibilityRole="button" accessibilityLabel="Change city">
          <Text style={styles.cityButtonText} numberOfLines={1}>
            {cityLabel}
          </Text>
          <Ionicons name="chevron-down" size={16} color={Colors.text} />
        </Pressable>

        <Text style={styles.headerTitle} numberOfLines={1}>
          Events
        </Text>

        <Pressable onPress={() => setIsFilterOpen(true)} style={styles.filterButton} accessibilityRole="button" accessibilityLabel="Filter events">
          <Ionicons name="options-outline" size={20} color={Colors.text} />
          {isFilterActive ? <View style={styles.filterDot} /> : null}
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.page}>
          {status === 'error' ? (
            <View style={styles.statusPad}>
              <ErrorState title={`Couldn't load events in ${cityLabel}.`} onRetry={load} />
            </View>
          ) : status === 'loading' ? (
            <LoadingState size="large" />
          ) : totalRealItems === 0 ? (
            <View style={styles.statusPad}>
              {isExploringAnotherCity ? (
                <EmptyState
                  icon="calendar-outline"
                  title={`No upcoming events in ${cityLabel} yet.`}
                  body="Explore another city or check back later."
                  action={<Button label="Explore another city" variant="secondary" onPress={() => router.push('/cities')} />}
                />
              ) : canCreateEventHere ? (
                <EmptyState
                  icon="calendar-outline"
                  title={`No upcoming events in ${cityLabel} yet.`}
                  body="Know something happening? Create an event."
                  action={<Button label="Create event" onPress={() => router.push('/create/event')} />}
                />
              ) : (
                // Event creation is Business-only (Step 30) — Personal
                // accounts get an honest empty state with no CTA into a
                // creation form they can't use, rather than a disabled
                // button or an "Upgrade to Business" prompt that implies a
                // conversion flow that doesn't exist yet.
                <EmptyState icon="calendar-outline" title={`No upcoming events in ${cityLabel} yet.`} body="Check back later." />
              )}
            </View>
          ) : totalFilteredItems === 0 ? (
            <View style={styles.statusPad}>
              <EmptyState icon="options-outline" title="Nothing matches this filter yet." />
            </View>
          ) : (
            <>
              {happeningNow.length > 0 ? (
                <View style={styles.section}>
                  <SectionHeader title="Happening Now" badge={<Pill label="LIVE" tone="live" />} />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.heroRail} style={styles.heroRailScroll}>
                    {happeningNow.map((item) => (
                      <EventCard key={item.contentId} item={item} variant="hero" />
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              {today.length > 0 ? (
                <View style={styles.section}>
                  <SectionHeader title={sections?.todayLabel ?? 'Today'} />
                  <View style={styles.rowList}>
                    {today.map((item) => (
                      <EventCard key={item.contentId} item={item} variant="row" />
                    ))}
                  </View>
                </View>
              ) : null}

              {thisWeekend.length > 0 ? (
                <View style={styles.section}>
                  <SectionHeader title="This Weekend" />
                  <View style={styles.grid}>
                    {thisWeekend.map((item) => (
                      <EventCard key={item.contentId} item={item} variant="upcoming" />
                    ))}
                  </View>
                </View>
              ) : null}

              {comingUp.length > 0 ? (
                <View style={styles.section}>
                  <SectionHeader title="Coming Up" />
                  <View style={styles.grid}>
                    {comingUp.map((item) => (
                      <EventCard key={item.contentId} item={item} variant="upcoming" />
                    ))}
                  </View>
                </View>
              ) : null}
            </>
          )}

          {status === 'loaded' && totalRealItems > 0 && canCreateEventHere ? (
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

      <EventFilterSheet
        visible={isFilterOpen}
        typeFilter={typeFilter}
        onChangeTypeFilter={setTypeFilter}
        categoryFilter={categoryFilter}
        onChangeCategoryFilter={setCategoryFilter}
        onClose={() => setIsFilterOpen(false)}
      />
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
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  cityButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    flexShrink: 1,
  },
  cityButtonText: {
    color: Colors.text,
    ...Typography.cardTitle,
  },
  headerTitle: {
    color: Colors.text,
    ...Typography.sectionTitle,
  },
  filterButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filterDot: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 7,
    height: 7,
    borderRadius: Radius.full,
    backgroundColor: Colors.accent,
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    gap: Spacing.lg,
  },
  section: {
    gap: Spacing.sm,
  },
  statusPad: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  // SectionHeader carries its own paddingHorizontal: Spacing.lg (see
  // SectionHeader.tsx) and this screen's `page` has none of its own — so
  // every direct content wrapper below repeats that same Spacing.lg inset
  // itself, keeping card rows/grids flush with their section title above
  // them rather than double- or under-indented.
  heroRailScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  heroRail: {
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
  rowList: {
    paddingHorizontal: Spacing.lg,
  },
  grid: {
    gap: Spacing.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: Spacing.lg,
  },
  createFooter: {
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.lg,
  },
  createFooterHint: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
});
