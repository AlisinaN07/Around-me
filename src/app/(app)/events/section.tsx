import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { ContentCard } from '@/components/ContentCard';
import { DateFilterSheet, dateFilterLabel, dateFilterWindow, type DateFilterSelection } from '@/components/DateFilterSheet';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { EventFilterSheet } from '@/components/EventFilterSheet';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { EventsMode } from '@/app/(app)/(tabs)/events';
import { useAuth } from '@/hooks/useAuth';
import { useCity } from '@/providers/CityProvider';
import {
  fetchDiscoverySections,
  fetchFollowingDiscoverySections,
  peekForYouSectionsHandoff,
  peekFollowingSectionsHandoff,
  setForYouSectionsHandoff,
  setFollowingSectionsHandoff,
  type DiscoverySections,
  type FollowingDiscoverySections,
} from '@/services/content';
import { fetchEventResponseCounts, type EventResponseCounts } from '@/services/engagement';
import { browseScopeKey } from '@/types/browseScope';
import type { ActivityContent, EventContent } from '@/types/content';
// Step 12A — isSectionKind/selectItems/selectComingUp moved to this pure,
// dependency-light module (unlike this screen file, directly
// unit-testable under plain `tsx` — see its own doc comment and
// tests/eventsSectionHandoff.test.ts) so there is exactly one real
// implementation, never a second copy that could drift.
import { isSectionKind, selectItems, type SectionKind } from '@/utils/eventSectionSelection';

type LoadStatus = 'loading' | 'loaded' | 'error';

type SortBy = 'date' | 'going' | 'interested';
const SORT_OPTIONS: { id: SortBy; label: string }[] = [
  { id: 'date', label: 'Date' },
  { id: 'going', label: 'Going' },
  { id: 'interested', label: 'Interested' },
];

// Same per-visit cap the Events tab itself already fetches under (see
// SECTION_LIMIT in (tabs)/events.tsx) — "show every event" means every
// event that screen already knows about, not a second, uncapped query.
const SECTION_LIMIT = 15;

function titleFor(which: SectionKind, todayLabel: 'Today' | 'Tonight'): string {
  if (which === 'happeningNow') return 'Happening Now';
  if (which === 'today') return todayLabel;
  return 'Coming Up';
}

/**
 * Events -> "Show more" for Happening Now / Today-or-Tonight / Coming Up
 * (Step 38/39) — one shared real second screen for all three rails,
 * rather than three near-identical files, since they differ only in
 * which slice of the same already-fetched DiscoverySections they show.
 * Every item gets the same bigger 'upcoming' card (date badge, category,
 * place, real actions) the This Weekend section already uses, rather than
 * the compact hero-rail cards the teasers use to fit several items in a
 * horizontal scroll. Re-fetches independently rather than receiving the
 * already-fetched list as a route param — content items carry Firestore
 * Timestamp fields that don't survive serialization through a URL, and
 * every other detail screen in this app (place, content, user) already
 * fetches its own data rather than relying on being reached a specific
 * way.
 *
 * `mode`/`category` are passed through from the Events tab's own current
 * mode and category filter (see its SectionHeaders' onActionPress) so
 * this page opens already showing the same slice the teaser was showing,
 * never a wider or narrower one — `category` only seeds this screen's OWN
 * `categoryFilter` state below, though; per explicit feedback this page
 * needed its own filter control (it used to just inherit whatever the
 * Events tab happened to be filtered to, with no way to change it here),
 * changing the filter here never reaches back to affect the Events tab's
 * own filter.
 */
export default function EventsSectionScreen() {
  const { which: whichParam, mode: modeParam, category } = useLocalSearchParams<{
    which?: string;
    mode?: string;
    category?: string;
  }>();
  const which: SectionKind = isSectionKind(whichParam) ? whichParam : 'today';
  const mode: EventsMode = modeParam === 'following' ? 'following' : 'forYou';

  const { user } = useAuth();
  const { activeScope, activeScopeLabel, isReady: isCityReady } = useCity();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [items, setItems] = useState<(ActivityContent | EventContent)[]>([]);
  const [todayLabel, setTodayLabel] = useState<'Today' | 'Tonight'>('Today');

  // Per-explicit request: a "Sort by" control (Date / Going / Interested)
  // for this list. Date is simply this screen's existing order (already
  // soonest-first off the Firestore query) — Going/Interested need each
  // Event's own response counts, which the list query never fetches (see
  // EventContent's own doc comment: no aggregate count field on the
  // content doc itself), so those two are fetched lazily, only once the
  // viewer actually picks one of those sorts, and cached here for the rest
  // of this screen's lifetime.
  const [sortBy, setSortBy] = useState<SortBy>('date');
  const [responseCounts, setResponseCounts] = useState<Record<string, EventResponseCounts>>({});

  // The "Sort by" control is a real dropdown (Modal + measured anchor
  // position), not three always-visible pills — per explicit feedback
  // that showing all three inline took up too much of the header. Same
  // Modal-based menu pattern as OptionsMenu/EventFilterSheet elsewhere in
  // this app, just anchored under its own trigger instead of docked to the
  // bottom of the screen, since this is a small 3-item choice rather than
  // a full-width action sheet.
  const sortTriggerRef = useRef<View>(null);
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const [sortMenuAnchor, setSortMenuAnchor] = useState<{ top: number; left: number } | null>(null);

  const openSortMenu = useCallback(() => {
    sortTriggerRef.current?.measureInWindow((x, y, _width, height) => {
      setSortMenuAnchor({ top: y + height + 4, left: x });
      setIsSortMenuOpen(true);
    });
  }, []);

  // Category filter for this list — same EventFilterSheet the Events tab
  // itself uses, seeded from whatever category (if any) the tab was
  // already filtered to when "Show more" was tapped, but freely
  // changeable from here afterward (see this component's own doc comment
  // above for why that's a one-way seed, not a two-way sync).
  const [categoryFilter, setCategoryFilter] = useState<string | null>(category ?? null);
  const [isFilterOpen, setIsFilterOpen] = useState(false);

  // Date filter (per explicit request) — a real calendar (day / week /
  // custom range), independent of and on top of the category filter
  // above. See DateFilterSheet's own doc comment for why it's a
  // from-scratch component rather than a library.
  const [dateFilter, setDateFilter] = useState<DateFilterSelection | null>(null);
  const [isDateFilterOpen, setIsDateFilterOpen] = useState(false);

  // Step 12B — `silent` mirrors (tabs)/events.tsx's own identical option:
  // a real load (first visit to this exact mode/which/scope) still blanks
  // to the loading skeleton; a silent revalidate (this screen regaining
  // focus with nothing structural changed — e.g. the viewer went to an
  // Event's detail, marked it Not Interested, and came back) must never
  // flash a loading state over a list that was already showing correctly
  // a moment ago. This is what actually makes Not Interested's effect
  // visible here: removeContentIdFromForYouSectionsHandoffForUser (see
  // content.ts) corrects the cached handoff IN PLACE the instant the
  // action is taken, so a silent re-read on refocus picks up the
  // corrected (still ranked) list via the same cache-hit path this
  // screen already had — no re-ranking, no new infrastructure.
  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!isCityReady) return;
    const silent = options?.silent ?? false;
    if (!silent) setStatus('loading');
    try {
      if (mode === 'following') {
        if (!user) {
          setItems([]);
          setStatus('loaded');
          return;
        }
        // Phase 4 perf pass — the Events tab almost always already fetched
        // this exact (scope, SECTION_LIMIT) result moments ago; reuse it
        // directly instead of re-running the same query. Only a miss/stale
        // entry (the tab hasn't been visited recently enough, or this
        // section was opened some other way) falls back to a real fetch —
        // which then also writes back into the same handoff so a second
        // "Show more" tap for a different rail in this same visit benefits
        // too. See setForYouSectionsHandoff's own doc comment in
        // content.ts for why this is a separate handoff, not a cache
        // inside fetchFollowingDiscoverySections itself.
        let result: FollowingDiscoverySections | undefined = peekFollowingSectionsHandoff(user.uid, activeScope, SECTION_LIMIT);
        if (!result) {
          result = await fetchFollowingDiscoverySections(user.uid, activeScope, SECTION_LIMIT);
          setFollowingSectionsHandoff(user.uid, activeScope, SECTION_LIMIT, result);
        }
        setTodayLabel(result.sections.todayLabel);
        setItems(selectItems(result.sections, which));
      } else {
        // Step 12A — same handoff/reuse as the Following branch above,
        // For-You-scoped, keyed by uid (see peekForYouSectionsHandoff's own
        // doc comment) so this only ever reads back a result the SAME
        // viewer actually saw. The common case is a cache HIT: the Events
        // tab almost always wrote its ranked result just moments before
        // "Show more" was tapped, well inside the 20s TTL — this is what
        // actually fixes the "Show more reverts to chronological order"
        // bug, since the hit path renders the EXACT ranked object the rail
        // itself rendered, nothing recomputed.
        //
        // On a miss (stale >20s, or this screen reached some other way —
        // e.g. a deep link) this intentionally falls back to a plain
        // chronological fetchDiscoverySections, NOT a second call into
        // rankEventSections: re-running the full ranking pipeline here
        // would mean duplicating its homeCity/profile.interests/
        // feedSessionId wiring into a second screen for what both the
        // Step 12A spec and this codebase's own existing precedent (a
        // ranking FAILURE in events.tsx's own loadForYou already falls
        // back to the plain chronological result, never a harder error)
        // treat as an acceptable, rare edge case — not the common path
        // this fix is actually about.
        let sections: DiscoverySections | undefined = peekForYouSectionsHandoff(user?.uid ?? '', activeScope, SECTION_LIMIT);
        if (!sections) {
          sections = await fetchDiscoverySections(activeScope, SECTION_LIMIT);
          setForYouSectionsHandoff(user?.uid ?? '', activeScope, SECTION_LIMIT, sections);
        }
        setTodayLabel(sections.todayLabel);
        setItems(selectItems(sections, which));
      }
      setStatus('loaded');
    } catch {
      // Silent revalidate failure: leave whatever's already rendered
      // untouched, same "a background refresh going wrong is never
      // grounds to blank working content" rule (tabs)/events.tsx's own
      // loadForYou already follows. A non-silent failure still shows the
      // real error state, unchanged from before this option existed.
      if (!silent) setStatus('error');
    }
  }, [mode, which, user, activeScope, isCityReady]);

  // Step 12B — same real-load-vs-silent-revalidate key-comparison pattern
  // as (tabs)/events.tsx's own useFocusEffect: the FIRST time this exact
  // (mode, which, uid, scope) combination is seen, do a real load (blanks
  // to the skeleton); every LATER refocus with that same key unchanged —
  // most commonly: the viewer opened one of this screen's own items,
  // acted on it, and came straight back — silently revalidates instead,
  // so a quick look at an Event's detail and back never causes a visible
  // loading flash for the common "nothing happened" case either.
  const loadedKeyRef = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!isCityReady) return;
      const key = `${mode}:${which}:${user?.uid ?? ''}:${browseScopeKey(activeScope)}`;
      if (loadedKeyRef.current === key) {
        load({ silent: true });
      } else {
        loadedKeyRef.current = key;
        load();
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, which, user, activeScope, isCityReady])
  );

  const filteredItems = useMemo(() => {
    const dateWindow = dateFilter ? dateFilterWindow(dateFilter) : null;
    return items.filter((item) => {
      if (categoryFilter && item.categoryId !== categoryFilter) return false;
      if (dateWindow) {
        const startMs = item.startsAt.toMillis();
        if (startMs < dateWindow.start.getTime() || startMs >= dateWindow.end.getTime()) return false;
      }
      return true;
    });
  }, [items, categoryFilter, dateFilter]);

  // Fetches response counts for whichever Events in the current
  // (already-filtered) list don't have a cached count yet, but only once
  // the viewer has actually chosen a count-based sort — "Date" never
  // triggers this, so simply opening this screen costs nothing extra.
  // Activity items (a legacy type this screen no longer surfaces in
  // practice, see selectItems' own doc comment) have no responses
  // subcollection to count, so they're skipped and just sort as 0.
  useEffect(() => {
    if (sortBy === 'date') return;
    const missing = filteredItems.filter((item) => item.type === 'event' && !(item.contentId in responseCounts));
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        missing.map(async (item) => [item.contentId, await fetchEventResponseCounts(item.contentId)] as const)
      );
      if (cancelled) return;
      setResponseCounts((prev) => {
        const next = { ...prev };
        for (const [contentId, counts] of entries) next[contentId] = counts;
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [sortBy, filteredItems, responseCounts]);

  // Most-first by the chosen count, falling back to this list's existing
  // (soonest-first) order both as the Date sort itself and as a stable
  // tiebreaker/placeholder for items whose count hasn't loaded in yet.
  const sortedItems = useMemo(() => {
    if (sortBy === 'date') return filteredItems;
    const countField = sortBy === 'going' ? 'goingCount' : 'interestedCount';
    return filteredItems
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const countA = responseCounts[a.item.contentId]?.[countField] ?? 0;
        const countB = responseCounts[b.item.contentId]?.[countField] ?? 0;
        if (countB !== countA) return countB - countA;
        return a.index - b.index;
      })
      .map((entry) => entry.item);
  }, [filteredItems, sortBy, responseCounts]);

  const title = titleFor(which, todayLabel);

  // Sort/Filter controls (+ their Modals) — pinned below the header (see
  // HeaderScreenLayout's `stickyBelowHeader`) rather than scrolling away
  // with the list, per explicit request. Only rendered once there's a
  // real list underneath them to control; `undefined` here means
  // HeaderScreenLayout renders no sticky slot at all during loading/error,
  // matching how the controls never showed during those states before
  // this change either.
  const controls =
    status === 'loaded' ? (
      <>
        {/* Sort + Filter always render once loaded, even with zero
            results for the current filter — otherwise picking a category
            with nothing in it would swap away the very control needed to
            change it back (the EmptyState below only replaces the list
            itself). */}
        <View style={styles.controlsRow}>
          <Pressable
            ref={sortTriggerRef}
            onPress={openSortMenu}
            style={styles.sortTrigger}
            accessibilityRole="button"
            accessibilityLabel="Sort by"
          >
            <Text style={styles.sortTriggerLabel}>Sort by</Text>
            <Text style={styles.sortTriggerValue}>{SORT_OPTIONS.find((option) => option.id === sortBy)?.label}</Text>
            <Ionicons name="chevron-down" size={14} color={Colors.accent} />
          </Pressable>

          <View style={styles.iconButtonRow}>
            <Pressable
              onPress={() => setIsDateFilterOpen(true)}
              style={styles.filterButton}
              accessibilityRole="button"
              accessibilityLabel={dateFilter ? `Filter by date, ${dateFilterLabel(dateFilter)}` : 'Filter by date'}
            >
              <Ionicons name="calendar-outline" size={20} color={Colors.text} />
              {dateFilter ? <View style={styles.filterDot} /> : null}
            </Pressable>

            <Pressable
              onPress={() => setIsFilterOpen(true)}
              style={styles.filterButton}
              accessibilityRole="button"
              accessibilityLabel="Filter by category"
            >
              <Ionicons name="options-outline" size={20} color={Colors.text} />
              {categoryFilter ? <View style={styles.filterDot} /> : null}
            </Pressable>
          </View>
        </View>

        {dateFilter ? (
          <View style={styles.activeDateFilterRow}>
            <Text style={styles.activeDateFilterText}>{dateFilterLabel(dateFilter)}</Text>
            <Pressable onPress={() => setDateFilter(null)} accessibilityRole="button" accessibilityLabel="Clear date filter" hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={Colors.textSecondary} />
            </Pressable>
          </View>
        ) : null}

        <Modal visible={isSortMenuOpen} transparent animationType="fade" onRequestClose={() => setIsSortMenuOpen(false)}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={() => setIsSortMenuOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close sort menu"
          />
          {sortMenuAnchor ? (
            <View style={[styles.sortMenu, { top: sortMenuAnchor.top, left: sortMenuAnchor.left }]}>
              {SORT_OPTIONS.map((option, index) => {
                const active = option.id === sortBy;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => {
                      setSortBy(option.id);
                      setIsSortMenuOpen(false);
                    }}
                    style={[styles.sortMenuRow, index > 0 && styles.sortMenuRowBorder]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Text style={[styles.sortMenuRowText, active && styles.sortMenuRowTextActive]}>{option.label}</Text>
                    {active ? <Ionicons name="checkmark" size={16} color={Colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </Modal>

        <EventFilterSheet
          visible={isFilterOpen}
          categoryFilter={categoryFilter}
          onChangeCategoryFilter={setCategoryFilter}
          onClose={() => setIsFilterOpen(false)}
        />

        <DateFilterSheet
          visible={isDateFilterOpen}
          value={dateFilter}
          onChange={setDateFilter}
          onClose={() => setIsDateFilterOpen(false)}
        />
      </>
    ) : undefined;

  return (
    <HeaderScreenLayout title={title} stickyBelowHeader={controls}>
      {status === 'error' ? (
        <ErrorState title="Couldn't load events." onRetry={load} />
      ) : status === 'loading' ? (
        <LoadingState size="large" />
      ) : filteredItems.length === 0 ? (
        <EmptyState
          icon="calendar-outline"
          title={
            categoryFilter || dateFilter
              ? `No ${title.toLowerCase()} events match these filters.`
              : `No ${title.toLowerCase()} events in ${activeScopeLabel} yet.`
          }
        />
      ) : (
        // Same compact list card Profile's own Live/Upcoming/Past Events
        // tabs use (ContentCard, showAuthor/showTypeBadge both off — every
        // item here is already known to be an Event, and this page has no
        // profile header above to anchor an author row to) — per explicit
        // feedback that this grid of big square cards should match that
        // list look instead.
        <View style={styles.list}>
          {sortedItems.map((item) => (
            <ContentCard key={item.contentId} item={item} currentUid={user?.uid ?? null} showAuthor={false} showTypeBadge={false} />
          ))}
        </View>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  sortTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.xs + 2,
  },
  sortTriggerLabel: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  sortTriggerValue: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  iconButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  // The active date filter's own removable summary chip — shown below the
  // controls row rather than crammed into the calendar icon itself, since
  // a range/week label ("Sep 22 – 28") doesn't fit a small icon button.
  activeDateFilterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    borderRadius: Radius.full,
    backgroundColor: Colors.accentMuted,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  activeDateFilterText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  // Same filterButton/filterDot pattern as the Events tab's own header
  // (see (tabs)/events.tsx) — a plain icon button with a small accent dot
  // once a category is actually selected, no dot for "All categories".
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
  // Positioned via sortMenuAnchor (measured from the trigger's real
  // on-screen location — see openSortMenu) rather than flowing in
  // document layout, since this Modal floats above the whole screen with
  // its own coordinate space, same as every other Modal-based menu here.
  sortMenu: {
    position: 'absolute',
    minWidth: 160,
    borderRadius: Radius.md,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  sortMenuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm + 2,
  },
  sortMenuRowBorder: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  sortMenuRowText: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  sortMenuRowTextActive: {
    color: Colors.accent,
  },
  // ContentCard carries its own marginHorizontal: Spacing.lg (it expects to
  // sit directly in a full-bleed scroll body, same as profile.tsx's own
  // contentList) — this screen's HeaderScreenLayout wraps children in a
  // paddingHorizontal: Spacing.xl `content` box instead, so this negative
  // margin cancels that out the same way profile.tsx's contentList does,
  // rather than doubling up into an over-indented list.
  list: {
    gap: Spacing.md,
    marginHorizontal: -Spacing.lg,
  },
});
