import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { EventCard } from '@/components/EventCard';
import { EventFilterSheet } from '@/components/EventFilterSheet';
import { LoadingState } from '@/components/LoadingState';
import { Pill } from '@/components/Pill';
import { SectionHeader } from '@/components/SectionHeader';
import { Colors, Layout, Radius, Spacing, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useCity } from '@/providers/CityProvider';
import { fetchDiscoverySections, fetchFollowingDiscoverySections, type DiscoverySections } from '@/services/content';
import { rankEventSections } from '@/services/recommendations/recommendationEngine';
import { browseScopeKey } from '@/types/browseScope';
import type { ActivityContent, EventContent } from '@/types/content';
import { canCreateEvent } from '@/utils/accountCapabilities';
import { getWeekendWindow } from '@/utils/dateWindows';

type LoadStatus = 'loading' | 'loaded' | 'error';
export type EventsMode = 'forYou' | 'following';

// Bounded per section (happening/today/upcoming), matching the "30
// initial, no infinite scroll" recommendation for this screen — see
// Section 43 of the Step 22 spec. Three sections at 15 each caps the
// total at 45 real Firestore reads per visit. Step 26 only changes how
// this same bounded result set is laid out and split (This Weekend vs.
// Coming Up is a client-side split of `upcoming`, not a new query).
const SECTION_LIMIT = 15;

// Happening Now / Today-or-Tonight / Coming Up each show only this many
// cards in their own horizontal rail here, with a "Show more" action in
// their SectionHeader (only rendered at all once there's something more
// to reveal) navigating to /events/section for the full list — see that
// screen for why this is a real navigation rather than an in-place
// expand.
const SECTION_COLLAPSED_LIMIT = 5;

/**
 * Events — Business Event discovery (Step 26 visual reconstruction; Step
 * 41.2B retired the legacy user-created Activity content type from this
 * screen — fetchDiscoverySections now filters Activity out at the source,
 * see src/services/content.ts). Deliberately the ONLY place in the app
 * that shows event-style discovery content; Home is the separate
 * user-generated Post feed (see src/app/(app)/(tabs)/index.tsx and the
 * Step 25 product-separation rule). Still backed by the same
 * fetchDiscoverySections/dateWindows architecture from Step 22.
 *
 * Following/For You (mirrors Home's own mode split): "For You" is the
 * original all-Events-in-this-city view; "Following" restricts the exact
 * same three rails to Events authored by companies (Business accounts)
 * the caller follows, via fetchFollowingDiscoverySections. Non-persisted,
 * resets to "For You" on fresh mount — same as Home's own mode.
 */
export default function EventsScreen() {
  const { user } = useAuth();
  const { activeScope, activeScopeLabel, homeCity, isExploringElsewhere, isReady: isCityReady } = useCity();
  const { profile } = useProfile();
  const canCreateEventHere = canCreateEvent(profile);

  // See index.tsx's own doc comment on this same pattern (Step 5, second
  // pass) — one value per app-open/screen session, reused for every
  // rankEventSections call this mount makes.
  const [feedSessionId] = useState(() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);

  const [mode, setMode] = useState<EventsMode>('forYou');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  const [forYouSections, setForYouSections] = useState<DiscoverySections | null>(null);
  const [forYouStatus, setForYouStatus] = useState<LoadStatus>('loading');

  const [followingSections, setFollowingSections] = useState<DiscoverySections | null>(null);
  const [followsAnyone, setFollowsAnyone] = useState(true);
  const [followingStatus, setFollowingStatus] = useState<LoadStatus>('loading');

  const cityLabel = activeScopeLabel;

  const loadForYou = useCallback(async () => {
    setForYouStatus('loading');
    // Clears the previous scope's sections immediately so a scope switch
    // never leaves stale cards on screen during the fetch (same rule
    // every other discovery surface in this app follows).
    setForYouSections(null);
    try {
      const result = await fetchDiscoverySections(activeScope, SECTION_LIMIT);
      // Reorders each existing time-based section by relevance (interest/
      // location/event-time/creator-affinity/freshness) — see
      // rankEventSections' own doc comment for why this keeps Events'
      // existing sectioned UX rather than replacing it with one flat feed.
      // Falls back to the plain chronological sections if ranking itself
      // fails for any reason (never a harder error over an otherwise
      // successful fetch) — only meaningful when signed in.
      const ranked = user
        ? await rankEventSections(
            user.uid,
            result,
            activeScope,
            homeCity?.cityKey ?? '',
            homeCity?.countryCode ?? '',
            profile?.interests,
            feedSessionId
          ).catch(() => result)
        : result;
      setForYouSections(ranked);
      setForYouStatus('loaded');
    } catch {
      setForYouStatus('error');
    }
  }, [activeScope, user, homeCity, profile, feedSessionId]);

  const loadFollowing = useCallback(async () => {
    if (!user) return;
    setFollowingStatus('loading');
    setFollowingSections(null);
    try {
      const result = await fetchFollowingDiscoverySections(user.uid, activeScope, SECTION_LIMIT);
      setFollowingSections(result.sections);
      setFollowsAnyone(result.followsAnyone);
      setFollowingStatus('loaded');
    } catch {
      setFollowingStatus('error');
    }
  }, [activeScope, user]);

  const activeScopeKey = useMemo(() => browseScopeKey(activeScope), [activeScope]);

  useFocusEffect(
    useCallback(() => {
      if (!isCityReady) return;
      if (mode === 'forYou') {
        loadForYou();
      } else {
        loadFollowing();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeScopeKey, isCityReady, mode])
  );

  const status = mode === 'forYou' ? forYouStatus : followingStatus;
  const sections = mode === 'forYou' ? forYouSections : followingSections;
  const load = mode === 'forYou' ? loadForYou : loadFollowing;

  const matchesFilters = useCallback(
    (item: ActivityContent | EventContent) => {
      if (categoryFilter && item.categoryId !== categoryFilter) return false;
      return true;
    },
    [categoryFilter]
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
  const canCreateHere = !!homeCity && !isExploringElsewhere;
  const isFilterActive = categoryFilter !== null;

  // Shared by all three rails' "Show more" — see /events/section for what
  // `which` selects and why mode/category are passed through.
  const openSection = (which: 'happeningNow' | 'today' | 'comingUp') => {
    router.push(`/events/section?which=${which}&mode=${mode}${categoryFilter ? `&category=${categoryFilter}` : ''}`);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.push('/cities')} style={styles.cityButton} accessibilityRole="button" accessibilityLabel="Change city">
          <Text style={styles.cityButtonText} numberOfLines={1}>
            {cityLabel}
          </Text>
          <Ionicons name="chevron-down" size={16} color={Colors.text} />
        </Pressable>

        <View style={styles.modeTabs}>
          <ModeTab label="Following" active={mode === 'following'} onPress={() => setMode('following')} />
          <ModeTab label="For You" active={mode === 'forYou'} onPress={() => setMode('forYou')} />
        </View>

        <Pressable onPress={() => setIsFilterOpen(true)} style={styles.filterButton} accessibilityRole="button" accessibilityLabel="Filter events">
          <Ionicons name="options-outline" size={20} color={Colors.text} />
          {isFilterActive ? <View style={styles.filterDot} /> : null}
        </Pressable>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.page}>
          {status === 'error' ? (
            <View style={styles.statusPad}>
              <ErrorState
                title={mode === 'forYou' ? `Couldn't load events in ${cityLabel}.` : "Couldn't load your Following events."}
                onRetry={load}
              />
            </View>
          ) : status === 'loading' ? (
            <LoadingState size="large" />
          ) : totalRealItems === 0 ? (
            <View style={styles.statusPad}>
              {mode === 'following' ? (
                !followsAnyone ? (
                  <EmptyState
                    icon="people-outline"
                    title="Your Following feed is empty"
                    body={`Follow businesses in ${cityLabel} to see their events here.`}
                  />
                ) : (
                  <EmptyState icon="calendar-outline" title="No upcoming events from businesses you follow." />
                )
              ) : isExploringElsewhere ? (
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
                  <SectionHeader
                    title="Happening Now"
                    badge={<Pill label="LIVE" tone="live" />}
                    actionLabel={happeningNow.length > SECTION_COLLAPSED_LIMIT ? 'Show more' : undefined}
                    onActionPress={() => openSection('happeningNow')}
                  />
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.heroRail} style={styles.heroRailScroll}>
                    {happeningNow.slice(0, SECTION_COLLAPSED_LIMIT).map((item) => (
                      <EventCard key={item.contentId} item={item} variant="hero" />
                    ))}
                  </ScrollView>
                </View>
              ) : null}

              {today.length > 0 ? (
                <View style={styles.section}>
                  <SectionHeader
                    title={sections?.todayLabel ?? 'Today'}
                    actionLabel={today.length > SECTION_COLLAPSED_LIMIT ? 'Show more' : undefined}
                    onActionPress={() => openSection('today')}
                  />
                  {/* Same horizontal hero rail as Happening Now above — every
                      one of these three rails teases SECTION_COLLAPSED_LIMIT
                      cards, then "Show more" opens /events/section for the
                      rest, same variant, full-size. */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.heroRail} style={styles.heroRailScroll}>
                    {today.slice(0, SECTION_COLLAPSED_LIMIT).map((item) => (
                      <EventCard key={item.contentId} item={item} variant="hero" />
                    ))}
                  </ScrollView>
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
                  <SectionHeader
                    title="Coming Up"
                    actionLabel={comingUp.length > SECTION_COLLAPSED_LIMIT ? 'Show more' : undefined}
                    onActionPress={() => openSection('comingUp')}
                  />
                  {/* Same horizontal hero rail as Happening Now/Tonight above. */}
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.heroRail} style={styles.heroRailScroll}>
                    {comingUp.slice(0, SECTION_COLLAPSED_LIMIT).map((item) => (
                      <EventCard key={item.contentId} item={item} variant="hero" />
                    ))}
                  </ScrollView>
                </View>
              ) : null}
            </>
          )}

          {mode === 'forYou' && status === 'loaded' && totalRealItems > 0 && canCreateEventHere ? (
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
        categoryFilter={categoryFilter}
        onChangeCategoryFilter={setCategoryFilter}
        onClose={() => setIsFilterOpen(false)}
      />
    </SafeAreaView>
  );
}

/** Same visual pattern as Home's own inline ModeTab — deliberately duplicated in this small a form rather than shared, so restyling one never risks the other (see ProfileTabBar's own doc comment for the same reasoning). */
function ModeTab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.modeTab} accessibilityRole="tab" accessibilityState={{ selected: active }}>
      <Text style={[styles.modeTabText, active && styles.modeTabTextActive]}>{label}</Text>
      {active ? <View style={styles.modeTabIndicator} /> : null}
    </Pressable>
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
  modeTabs: {
    flexDirection: 'row',
    gap: 18,
  },
  modeTab: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: 2,
  },
  modeTabText: {
    color: Colors.textMuted,
    fontSize: 15,
    fontWeight: '700',
  },
  modeTabTextActive: {
    color: Colors.text,
  },
  modeTabIndicator: {
    width: 18,
    height: 2,
    borderRadius: 1,
    backgroundColor: Colors.text,
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
