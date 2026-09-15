/**
 * The controlled catalog of cities the City Explorer can switch Active
 * City to (Step 21). This is the ONE shared source of truth — the city
 * switcher, tests, and any future discovery filter all read from here
 * rather than keeping independent city lists.
 *
 * Deliberately NOT a dynamic/third-party city database (no Google Places,
 * GeoNames, Mapbox, or autocomplete API) — a small static list is
 * sufficient for a city-by-city launch and avoids a new cost/API
 * dependency. Sweden-focused for the initial Karlstad launch; the shape
 * (`cityKey`/`cityName`/`countryCode`/`countryName`) already generalizes to
 * future countries without any architecture change.
 *
 * `cityKey` is built via the exact same `buildCityKey` onboarding uses
 * (src/utils/cityKey.ts), so a catalog entry and a real user profile for
 * the same city always produce an identical key — e.g. a Karlstad user's
 * `profile.cityKey` and `CITIES.find(c => c.cityName === 'Karlstad').cityKey`
 * are both `se:karlstad`, with no separate mapping to keep in sync.
 */
import { buildCityKey } from '@/utils/cityKey';

export type City = {
  cityKey: string;
  cityName: string;
  countryCode: string;
  countryName: string;
};

const SWEDISH_CITY_NAMES = [
  'Karlstad',
  'Stockholm',
  'Göteborg',
  'Malmö',
  'Uppsala',
  'Västerås',
  'Örebro',
  'Linköping',
  'Helsingborg',
  'Jönköping',
] as const;

export const CITIES: City[] = SWEDISH_CITY_NAMES.map((cityName) => ({
  cityKey: buildCityKey('SE', cityName),
  cityName,
  countryCode: 'SE',
  countryName: 'Sweden',
}));

/** The first practical launch market — used as the default Home City suggestion, never a fallback for an existing user's real profile city. */
export const DEFAULT_LAUNCH_CITY = CITIES[0];

export function findCityByKey(cityKey: string): City | null {
  return CITIES.find((city) => city.cityKey === cityKey) ?? null;
}

/** Every catalog city in one country — the drill-down list shown after tapping a Country in the City Explorer (src/app/(app)/cities/[countryCode].tsx). Empty for a country with no catalog cities yet (most of them, today) — that screen still offers "Explore all of {country}" either way. */
export function citiesForCountry(countryCode: string): City[] {
  return CITIES.filter((city) => city.countryCode === countryCode);
}

// Same construction as src/utils/cityKey.ts — built from numeric code
// points rather than an inline escape, to avoid ambiguity.
const COMBINING_MARKS_RANGE_START = 0x0300;
const COMBINING_MARKS_RANGE_END = 0x036f;
const COMBINING_DIACRITICAL_MARKS = new RegExp(
  `[${String.fromCharCode(COMBINING_MARKS_RANGE_START)}-${String.fromCharCode(COMBINING_MARKS_RANGE_END)}]`,
  'g'
);

/** Same diacritic-stripping approach as buildCityKey, so "Goteborg" matches "Göteborg" without a separate fuzzy-search library. */
function normalizeForSearch(value: string): string {
  return value
    .normalize('NFD')
    .replace(COMBINING_DIACRITICAL_MARKS, '')
    .trim()
    .toLowerCase();
}

/** Case-insensitive, diacritic-normalized substring search — never fuzzy/ranked matching. */
export function searchCities(query: string): City[] {
  const normalizedQuery = normalizeForSearch(query);
  if (!normalizedQuery) return CITIES;
  return CITIES.filter((city) => normalizeForSearch(city.cityName).includes(normalizedQuery));
}
