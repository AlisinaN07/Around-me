/**
 * TEMPORARY UI PREVIEW DATA — not real content, not Firestore, not user data.
 *
 * Everything in this file exists only to give the Home screen something to
 * render while the real Posts/Activities/Events/Reels backend doesn't exist
 * yet (that's a later step). Nothing here is read from or written to
 * Firebase — keep it that way.
 */

import type { Ionicons } from '@expo/vector-icons';

export type HappeningNowItem = {
  id: string;
  category: string;
  title: string;
  place: string;
  time: string;
};

export const HAPPENING_NOW_FIXTURES: HappeningNowItem[] = [
  { id: 'hn-1', category: 'Live music', title: 'Live music', place: 'Nöjesfabriken', time: 'Now' },
  { id: 'hn-2', category: 'Nightlife', title: 'Quiz night', place: 'Local bar', time: '19:00' },
  { id: 'hn-3', category: 'Sports', title: 'Football', place: 'Karlstad', time: '19:30' },
  { id: 'hn-4', category: 'Food', title: 'Food truck market', place: 'Stora Torget', time: '17:00' },
];

export type ReelPreview = {
  id: string;
  username: string;
  place: string;
  views: string;
  timeAgo: string;
};

export const REEL_PREVIEW_FIXTURES: ReelPreview[] = [
  { id: 'reel-1', username: '@ali97', place: 'Nöjesfabriken', views: '1.2k', timeAgo: '2h' },
  { id: 'reel-2', username: '@sara.k', place: 'Stora Torget', views: '842', timeAgo: '4h' },
  { id: 'reel-3', username: '@leo_wm', place: 'Mariebergsskogen', views: '317', timeAgo: '6h' },
];

export type AroundYouActivity = {
  kind: 'activity';
  id: string;
  title: string;
  description: string;
  place: string;
  time: string;
  interestedCount: number;
};

export type AroundYouEvent = {
  kind: 'event';
  id: string;
  title: string;
  place: string;
  time: string;
  interestedCount: number;
};

export type AroundYouBusinessPost = {
  kind: 'business';
  id: string;
  businessName: string;
  message: string;
  place: string;
  time: string;
};

export type AroundYouItem = AroundYouActivity | AroundYouEvent | AroundYouBusinessPost;

export const AROUND_YOU_FIXTURES: AroundYouItem[] = [
  {
    kind: 'activity',
    id: 'ay-1',
    title: 'Football tonight ⚽',
    description: 'We need 3 more people for a game at 19:00.',
    place: 'Tingvallastadion',
    time: '19:00',
    interestedCount: 6,
  },
  {
    kind: 'event',
    id: 'ay-2',
    title: 'Live music tonight',
    place: 'Nöjesfabriken',
    time: '20:00',
    interestedCount: 24,
  },
  {
    kind: 'business',
    id: 'ay-3',
    businessName: 'Solstice Café',
    message: 'Fresh pastries just came out of the oven — first coffee is on us until 10am.',
    place: 'Solstice Café',
    time: 'Today',
  },
];

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
