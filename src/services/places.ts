/**
 * Public Places data layer — the places/{placeId} collection. UI code
 * should only ever import from here, never talk to Firestore directly for
 * Place data. Places are read-only from the client (see firestore.rules —
 * ordinary users cannot create/update/delete them); this file has no
 * create/update functions on purpose.
 */

import { collection, doc, getDoc, getDocs, limit, orderBy, query, where } from 'firebase/firestore';

import type { Place } from '@/types/place';

import { firestore } from './firestore';

const PLACES_COLLECTION = 'places';
const DEFAULT_CITY_PLACES_LIMIT = 50;

export async function fetchPlace(placeId: string): Promise<Place | null> {
  if (!firestore) {
    return null;
  }
  const snapshot = await getDoc(doc(firestore, PLACES_COLLECTION, placeId));
  return snapshot.exists() ? (snapshot.data() as Place) : null;
}

export type FetchCityPlacesOptions = {
  limit?: number;
};

/**
 * Active Places in one city, ordered alphabetically (nameLower ASC) with an
 * explicit limit. Search and category filtering happen client-side over
 * this already-fetched list (see MapPlaceExplorer) — no per-keystroke or
 * per-chip-tap Firestore query.
 */
export async function fetchCityPlaces(cityKey: string, options: FetchCityPlacesOptions = {}): Promise<Place[]> {
  if (!firestore) {
    return [];
  }
  const placesQuery = query(
    collection(firestore, PLACES_COLLECTION),
    where('cityKey', '==', cityKey),
    where('status', '==', 'active'),
    orderBy('nameLower', 'asc'),
    limit(options.limit ?? DEFAULT_CITY_PLACES_LIMIT)
  );
  const snapshot = await getDocs(placesQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Place);
}
