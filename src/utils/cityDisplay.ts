/**
 * Display-only city name formatting — never touches cityKey, which stays
 * derived from the raw input via src/utils/cityKey.ts.
 *
 * Only all-lowercase input gets title-cased (e.g. a manually-typed
 * "karlstad" -> "Karlstad"). Anything that already has a capital letter is
 * left completely alone, since we can't reliably "fix" mixed casing like
 * "McAllen" without breaking it.
 */
export function formatCityDisplayName(cityName: string): string {
  const trimmed = cityName.trim();
  if (!trimmed) {
    return trimmed;
  }

  const hasUpperCase = trimmed !== trimmed.toLowerCase();
  if (hasUpperCase) {
    return trimmed;
  }

  return trimmed
    .split(/(\s+|-)/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}
