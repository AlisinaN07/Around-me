import type { Timestamp } from 'firebase/firestore';

/** Only "active" exists in this MVP — no pending/removed/claimed states yet. */
export type PlaceStatus = 'active';

/**
 * places/{placeId} — a real public physical location (café, restaurant,
 * park, venue, ...). Ordinary users cannot create, update, or delete these
 * (see firestore.rules) — Step 13 only introduces the data model and a
 * read-only, trusted-tooling-seeded set of Places. Business accounts,
 * claiming, and user-submitted Places are future steps.
 *
 * latitude/longitude/geohash belong to the PLACE (a public location), never
 * to a user — this is unrelated to and does not change the existing rule
 * that no user's live/home GPS position is ever stored.
 */
export type Place = {
  placeId: string;
  name: string;
  /** Lowercased `name`, used for deterministic alphabetical ordering (nameLower ASC). */
  nameLower: string;
  categoryId: string;
  cityName: string;
  countryCode: string;
  cityKey: string;
  address: string;
  latitude: number;
  longitude: number;
  /** Standard geohash string for the (latitude, longitude) pair — see src/services/places.ts. Not yet used for radius queries (Step 14+). */
  geohash: string;
  status: PlaceStatus;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

export const PLACE_NAME_MAX_LENGTH = 200;
export const PLACE_ADDRESS_MAX_LENGTH = 300;

export function isValidLatitude(value: number): boolean {
  return Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidLongitude(value: number): boolean {
  return Number.isFinite(value) && value >= -180 && value <= 180;
}
