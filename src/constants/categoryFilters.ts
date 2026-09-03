import type { Ionicons } from '@expo/vector-icons';

/**
 * Home's category filter chips. 'all' / 'happening-now' / 'events' /
 * 'activities' are meta-filters handled specially by the feed screen; the
 * rest match a real content categoryId (see src/constants/interests.ts).
 */
export type CategoryFilter = {
  id: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
};

export const CATEGORY_FILTERS: CategoryFilter[] = [
  { id: 'all', label: 'All', icon: 'apps-outline' },
  { id: 'happening-now', label: 'Happening Now', icon: 'flame' },
  { id: 'events', label: 'Events', icon: 'calendar-outline' },
  { id: 'activities', label: 'Activities', icon: 'people-outline' },
  { id: 'food', label: 'Food', icon: 'restaurant-outline' },
  { id: 'nightlife', label: 'Nightlife', icon: 'moon-outline' },
  { id: 'sports', label: 'Sports', icon: 'football-outline' },
];

const META_CATEGORY_FILTER_IDS = new Set(['all', 'happening-now', 'events', 'activities']);

/**
 * True for the feed-view-mode chips ('all'/'happening-now'/'events'/
 * 'activities') that only affect the Around feed's own display mode; false
 * for a real content categoryId (e.g. 'food', 'sports') that should also
 * filter the time-based discovery rails (Happening Now/Today/Upcoming) —
 * see Home's `isRealCategory`.
 */
export function isMetaCategoryFilter(filterId: string): boolean {
  return META_CATEGORY_FILTER_IDS.has(filterId);
}
