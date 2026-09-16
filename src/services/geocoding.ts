/**
 * Live address search via OpenStreetMap's Nominatim geocoder — the one
 * external, third-party geo API this app calls. src/constants/cities.ts's
 * own doc comment deliberately avoids a third-party API for the CITY
 * catalog (a small static list is enough for a city-by-city launch); this
 * is a separate, later, explicitly-requested decision scoped only to
 * finding real-world addresses/venues for PlaceSelector's custom-place
 * flow — it never touches which cities exist in the app.
 *
 * Deliberately UNRESTRICTED — no country/city filter and no bias text
 * appended to the query — so this behaves like a general-purpose "type an
 * address, find it" search (the way Google Maps' own search box does),
 * not one narrowed to the account's current city. An earlier version
 * appended ", {cityLabel}" to every query to bias results toward the
 * active city; that made addresses outside that one city hard or
 * impossible to find, which is exactly the behavior this was changed to
 * remove. A live result is just a display string (placeName) on the
 * content document, never validated against the content's own city by
 * Firestore rules — see PlaceSelector's own doc comment — so there is no
 * correctness reason to restrict it.
 *
 * Chosen specifically because it needs no API key and no billing account
 * (unlike Google Places/Mapbox) — see PlaceSelector's own doc comment for
 * why a live result never becomes a real places/{placeId} document.
 *
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * this file follows:
 *   - No more than ~1 request/second — enforced by the CALLER's debounce
 *     (see PlaceSelector), not here; this function itself never retries
 *     or polls.
 *   - A real identifying request header where the platform allows one.
 *   - Mandatory "© OpenStreetMap contributors" attribution wherever a
 *     result is shown to a user — see PlaceSelector's own attribution
 *     line, not this file (this is a pure data-fetching function).
 */

export type AddressSearchResult = {
  id: string;
  /**
   * 'place' when Nominatim has a real venue/POI name for this result (e.g.
   * "Nöjesfabriken") — a named place at a real address, distinct from
   * 'address', a bare street result with no name of its own (e.g.
   * "Frödingshöjd 3", where the street IS the primaryLine already). Lets
   * the picker show a different icon for the two, and is why a 'place'
   * result's secondaryLine below carries its street too — unlike an
   * 'address' result, its primaryLine alone doesn't say where it is.
   */
  kind: 'place' | 'address';
  /**
   * The venue/POI name for a 'place' result (e.g. "Nöjesfabriken"),
   * otherwise the street + house number (e.g. "Frödingshöjd 3"). Never
   * invented: derived straight from Nominatim's own
   * `name`/`address.road`/`address.house_number` fields, falling back to
   * the first segment of its `display_name` only when neither exists.
   */
  primaryLine: string;
  /**
   * For a 'place' result: its real street address, then city, then
   * country if outside Sweden (e.g. "Kungsgatan 1, Karlstad") — a venue
   * name alone doesn't say where it is. For an 'address' result, just
   * city/country (e.g. "Karlstad", "Paris, France") since the street is
   * already the primaryLine. Deliberately never a postcode: OpenStreetMap's
   * Swedish postal-code data is community-maintained and can be genuinely
   * wrong (verified during development: Nominatim returned an incorrect
   * postcode for a real Karlstad address, confirmed wrong against
   * independent Swedish address sources — a known, documented weak spot of
   * OSM data in Sweden specifically, not a fluke). Street, city, and
   * country are reliable; postcode is the one field that isn't. Country is
   * only shown for non-Swedish results since this app's own cities are all
   * Swedish (see src/constants/cities.ts) — adding "Sweden" to every local
   * result would be pure noise.
   */
  secondaryLine: string;
  /** primaryLine + secondaryLine joined — what actually gets stored as `placeName` on selection: real and precise, without the full raw hierarchy's clutter. */
  fullLine: string;
};

type NominatimAddress = {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  city?: string;
  town?: string;
  village?: string;
  municipality?: string;
  country?: string;
  country_code?: string;
};

type NominatimResult = {
  place_id: number | string;
  name?: string;
  display_name: string;
  address?: NominatimAddress;
};

const NOMINATIM_SEARCH_URL = 'https://nominatim.openstreetmap.org/search';
const RESULT_LIMIT = 8;

/** Builds the kind/primary/secondary lines from Nominatim's own structured `address` breakdown — see AddressSearchResult's own doc comment on each field for exactly which source wins and why. */
function toAddressSearchResult(result: NominatimResult): AddressSearchResult {
  const address = result.address;
  const street = address?.road ?? address?.pedestrian;
  const houseNumber = address?.house_number;
  const streetLine = street ? `${street}${houseNumber ? ` ${houseNumber}` : ''}` : undefined;

  // A real venue name from Nominatim makes this a 'place' — its street
  // address (streetLine) is real info that would otherwise be lost, since
  // primaryLine becomes the name instead of the street. A bare 'address'
  // result has no name at all: the street IS primaryLine already.
  const kind: AddressSearchResult['kind'] = result.name ? 'place' : 'address';
  const primaryLine = result.name || streetLine || result.display_name.split(',')[0].trim();

  const locality = address?.city ?? address?.town ?? address?.village ?? address?.municipality;
  // "se" covers this app's own cities (see src/constants/cities.ts) — only
  // append the country for a result outside Sweden, so a local result
  // still reads as the short "Karlstad" it always has.
  const isSweden = address?.country_code?.toLowerCase() === 'se';
  const country = !isSweden ? address?.country : undefined;
  const secondaryParts = (kind === 'place' ? [streetLine, locality, country] : [locality, country]).filter((part): part is string => !!part);
  const secondaryLine = secondaryParts.length > 0 ? secondaryParts.join(', ') : result.display_name.split(',').slice(1, 2).join(',').trim();

  const fullLine = secondaryLine ? `${primaryLine}, ${secondaryLine}` : primaryLine;
  return { id: String(result.place_id), kind, primaryLine, secondaryLine, fullLine };
}

/**
 * Plain free-text search, no country/city filter and nothing appended to
 * `query` — see this file's own top doc comment for why: any restriction
 * here is exactly the "only finds Karlstad" behavior this was written to
 * remove.
 */
export async function searchAddresses(query: string): Promise<AddressSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const params = new URLSearchParams({
    format: 'jsonv2',
    q: trimmed,
    limit: String(RESULT_LIMIT),
    addressdetails: '1',
  });

  const response = await fetch(`${NOMINATIM_SEARCH_URL}?${params.toString()}`, {
    headers: {
      // Browsers block a script-set User-Agent; Accept-Language is the
      // one real signal every platform this app runs on (native + web)
      // can actually send.
      'Accept-Language': 'en',
    },
  });
  if (!response.ok) {
    throw new Error(`Nominatim search failed: ${response.status}`);
  }

  const results = (await response.json()) as NominatimResult[];
  return results.map(toAddressSearchResult);
}
