import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchCityPlaces } from '@/services/places';
import type { Place } from '@/types/place';

export type LoadPlacesStatus = 'loading' | 'loaded' | 'error';

/**
 * Owns fetching one city's Places plus search/category filtering — shared
 * by MapPlaceExplorer (web/Android list fallback) and the iOS native map
 * screen, so both ever run the same single Firestore query per city visit
 * and filter the same already-loaded list in-memory. Never queries
 * Firestore again for a search keystroke or category chip tap.
 */
export function useCityPlaces(cityKey: string) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [status, setStatus] = useState<LoadPlacesStatus>('loading');
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

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

  const filteredPlaces = useMemo(() => {
    let list = places;
    if (selectedCategory !== 'all') {
      list = list.filter((place) => place.categoryId === selectedCategory);
    }
    const trimmed = query.trim().toLowerCase();
    if (trimmed) {
      list = list.filter((place) => place.name.toLowerCase().includes(trimmed));
    }
    return list;
  }, [places, selectedCategory, query]);

  return { places, filteredPlaces, status, query, setQuery, selectedCategory, setSelectedCategory, reload: load };
}
