import type { Ionicons } from '@expo/vector-icons';

/**
 * Place category catalog — stable IDs are what get stored in
 * places/{placeId}.categoryId; label/icon are display-only. Deliberately
 * separate from src/constants/interests.ts (content categories): a café is
 * a place, not an interest, and the two lists drift independently.
 */
export type PlaceCategory = { id: string; label: string; icon: keyof typeof Ionicons.glyphMap };

export const PLACE_CATEGORIES: PlaceCategory[] = [
  { id: 'cafe', label: 'Café', icon: 'cafe-outline' },
  { id: 'restaurant', label: 'Restaurant', icon: 'restaurant-outline' },
  { id: 'bar', label: 'Bar', icon: 'wine-outline' },
  { id: 'nightclub', label: 'Nightclub', icon: 'moon-outline' },
  { id: 'park', label: 'Park', icon: 'leaf-outline' },
  { id: 'sports_venue', label: 'Sports venue', icon: 'football-outline' },
  { id: 'gym', label: 'Gym', icon: 'barbell-outline' },
  { id: 'shopping', label: 'Shopping', icon: 'bag-outline' },
  { id: 'culture', label: 'Culture', icon: 'color-palette-outline' },
  { id: 'entertainment', label: 'Entertainment', icon: 'film-outline' },
  { id: 'venue', label: 'Venue', icon: 'business-outline' },
  { id: 'other', label: 'Other', icon: 'location-outline' },
];

const PLACE_CATEGORY_BY_ID = new Map(PLACE_CATEGORIES.map((category) => [category.id, category]));

export function getPlaceCategory(categoryId: string): PlaceCategory | undefined {
  return PLACE_CATEGORY_BY_ID.get(categoryId);
}
