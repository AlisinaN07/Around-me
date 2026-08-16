/**
 * Normalized "{countryCode}:{cityName}" key used for city-based filtering.
 * Never derived from precise coordinates — city + country only.
 */

// Unicode combining diacritical marks block (0x0300-0x036F), built from
// numeric code points rather than an inline escape to avoid ambiguity.
const COMBINING_MARKS_RANGE_START = 0x0300;
const COMBINING_MARKS_RANGE_END = 0x036f;
const COMBINING_DIACRITICAL_MARKS = new RegExp(
  `[${String.fromCharCode(COMBINING_MARKS_RANGE_START)}-${String.fromCharCode(COMBINING_MARKS_RANGE_END)}]`,
  'g'
);

function normalizeCityNamePart(cityName: string): string {
  return cityName
    .normalize('NFD')
    .replace(COMBINING_DIACRITICAL_MARKS, '') // strip diacritics: ö -> o, é -> e, etc.
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function buildCityKey(countryCode: string, cityName: string): string {
  const normalizedCountry = countryCode.trim().toLowerCase();
  const normalizedCity = normalizeCityNamePart(cityName);

  if (!normalizedCountry || !normalizedCity) {
    throw new Error('countryCode and cityName must both be non-empty.');
  }

  return `${normalizedCountry}:${normalizedCity}`;
}
