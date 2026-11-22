/**
 * Step 12A — the pure "which slice of a DiscoverySections object does
 * this rail/screen show" logic behind src/app/(app)/events/section.tsx,
 * pulled out into its own dependency-light module so it's directly
 * unit-testable under plain `tsx`.
 *
 * section.tsx itself cannot be imported under plain `tsx` at all (it's
 * an Expo Router screen component — importing it transitively pulls in
 * `@expo/vector-icons`/`react-native`, which fail to parse outside
 * Metro — probed directly, same class of issue as expo-video/
 * expo-network found earlier this session). `../utils/dateWindows` and
 * `../types/content` are both safe, dependency-light modules — this file
 * imports them by RELATIVE path (not the `@/` alias, which `tsx` cannot
 * resolve at all in this project — probed directly), matching this
 * session's established convention.
 *
 * section.tsx imports these from here rather than defining its own
 * copies, so there is exactly one real implementation, never two that
 * could drift.
 */
import { getWeekendWindow } from './dateWindows';
import type { DiscoverySections } from '../services/content';
import type { ActivityContent, EventContent } from '../types/content';

export type SectionKind = 'happeningNow' | 'today' | 'comingUp';

export function isSectionKind(value: string | undefined): value is SectionKind {
  return value === 'happeningNow' || value === 'today' || value === 'comingUp';
}

/**
 * Excludes "This Weekend" items from `upcoming`, the exact same
 * client-side split (tabs)/events.tsx's own weekendSplit does — Coming Up
 * was never simply `sections.upcoming`, so this "show more" page has to
 * reapply the identical split rather than showing a wider set than the
 * teaser it was opened from.
 */
export function selectComingUp(upcoming: (ActivityContent | EventContent)[]): (ActivityContent | EventContent)[] {
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

/**
 * Reads the exact section a "Show more" screen opened for straight off
 * an already-fetched (and, for For You, already-RANKED — see Step 12A's
 * own report) DiscoverySections object. Never re-sorts/re-filters beyond
 * the `comingUp` weekend split above — whatever order `sections` already
 * holds for a given field is preserved exactly, which is what keeps this
 * consistent with whatever rail the viewer tapped "Show more" from.
 */
export function selectItems(sections: DiscoverySections, which: SectionKind): (ActivityContent | EventContent)[] {
  if (which === 'happeningNow') return sections.happeningNow;
  if (which === 'today') return sections.today;
  return selectComingUp(sections.upcoming);
}
