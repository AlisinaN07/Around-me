import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { EventCard } from '@/components/EventCard';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Spacing } from '@/constants/theme';
import type { EventsMode } from '@/app/(app)/(tabs)/events';
import { useAuth } from '@/hooks/useAuth';
import { useCity } from '@/providers/CityProvider';
import { fetchDiscoverySections, fetchFollowingDiscoverySections, type DiscoverySections } from '@/services/content';
import type { ActivityContent, EventContent } from '@/types/content';
import { getWeekendWindow } from '@/utils/dateWindows';

type LoadStatus = 'loading' | 'loaded' | 'error';
type SectionKind = 'happeningNow' | 'today' | 'comingUp';

// Same per-visit cap the Events tab itself already fetches under (see
// SECTION_LIMIT in (tabs)/events.tsx) — "show every event" means every
// event that screen already knows about, not a second, uncapped query.
const SECTION_LIMIT = 15;

function isSectionKind(value: string | undefined): value is SectionKind {
  return value === 'happeningNow' || value === 'today' || value === 'comingUp';
}

/**
 * Excludes "This Weekend" items from `upcoming`, the exact same
 * client-side split (tabs)/events.tsx's own weekendSplit does — Coming Up
 * was never simply `sections.upcoming`, so this "show more" page has to
 * reapply the identical split rather than showing a wider set than the
 * teaser it was opened from.
 */
function selectComingUp(upcoming: (ActivityContent | EventContent)[]): (ActivityContent | EventContent)[] {
  const weekend = getWeekendWindow();
  const weekendIds = new Set(
    upcoming
      .filter((item) => {
        const startMs = item.startsAt.toMillis();
        return startMs >= weekend.start.getTime() && startMs < weekend.end.getTime();
      })
      .map((item) => item.contentId)
  );
  return weekendIds.size > 0 ? upcoming.filter((item) => !weekendIds.has(item.contentId)) : upcoming;
}

function selectItems(sections: DiscoverySections, which: SectionKind): (ActivityContent | EventContent)[] {
  if (which === 'happeningNow') return sections.happeningNow;
  if (which === 'today') return sections.today;
  return selectComingUp(sections.upcoming);
}

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
 * this page shows the same slice the teaser was already showing, never a
 * wider or narrower one.
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

  const load = useCallback(async () => {
    if (!isCityReady) return;
    setStatus('loading');
    try {
      if (mode === 'following') {
        if (!user) {
          setItems([]);
          setStatus('loaded');
          return;
        }
        const result = await fetchFollowingDiscoverySections(user.uid, activeScope, SECTION_LIMIT);
        setTodayLabel(result.sections.todayLabel);
        setItems(selectItems(result.sections, which));
      } else {
        const result = await fetchDiscoverySections(activeScope, SECTION_LIMIT);
        setTodayLabel(result.todayLabel);
        setItems(selectItems(result, which));
      }
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [mode, which, user, activeScope, isCityReady]);

  useEffect(() => {
    // load() awaits before its first setState call, same reasoning as
    // every other one-shot-load screen in this app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const filteredItems = useMemo(
    () => (category ? items.filter((item) => item.categoryId === category) : items),
    [items, category]
  );

  const title = titleFor(which, todayLabel);

  return (
    <HeaderScreenLayout title={title}>
      {status === 'error' ? (
        <ErrorState title="Couldn't load events." onRetry={load} />
      ) : status === 'loading' ? (
        <LoadingState size="large" />
      ) : filteredItems.length === 0 ? (
        <EmptyState icon="calendar-outline" title={`No ${title.toLowerCase()} events in ${activeScopeLabel} yet.`} />
      ) : (
        <View style={styles.grid}>
          {filteredItems.map((item) => (
            <EventCard key={item.contentId} item={item} variant="upcoming" />
          ))}
        </View>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  grid: {
    gap: Spacing.md,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
});
