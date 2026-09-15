/**
 * How broadly a discovery surface (Home feed, /events, the Reels screen)
 * is currently scoped — one City, several hand-picked Cities (within one
 * Country — see the drill-down screen at
 * src/app/(app)/cities/[countryCode].tsx), a whole Country (every
 * published item whose author's home country matches, regardless of
 * which city), or World (no city/country filter at all).
 *
 * Every content/{contentId} and reels/{reelId} document already carries
 * both `cityKey` and `countryCode` (public-safe snapshots of the author's
 * own profile at creation time — see ContentBase's and Reel's own doc
 * comments) — this type only controls which of those two fields (or
 * neither) a query filters on. It never changes what gets written at
 * creation time: a new Post/Reel always publishes to its author's own
 * Home City/country regardless of what scope they were browsing (see
 * CityProvider's own doc comment).
 */
export type BrowseScope =
  | { kind: 'city'; cityKey: string }
  | { kind: 'cities'; cityKeys: string[] }
  | { kind: 'country'; countryCode: string }
  | { kind: 'world' };

export function isSameBrowseScope(a: BrowseScope, b: BrowseScope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'city' && b.kind === 'city') return a.cityKey === b.cityKey;
  if (a.kind === 'cities' && b.kind === 'cities') {
    if (a.cityKeys.length !== b.cityKeys.length) return false;
    const sortedA = [...a.cityKeys].sort();
    const sortedB = [...b.cityKeys].sort();
    return sortedA.every((key, index) => key === sortedB[index]);
  }
  if (a.kind === 'country' && b.kind === 'country') return a.countryCode === b.countryCode;
  return true; // both 'world'
}

/** A stable primitive key for a scope — for effect/callback dependency arrays, the same role `activeCity?.cityKey` played before Country/World existed (a plain object identity isn't a safe dep). */
export function browseScopeKey(scope: BrowseScope): string {
  if (scope.kind === 'city') return `city:${scope.cityKey}`;
  if (scope.kind === 'cities') return `cities:${[...scope.cityKeys].sort().join(',')}`;
  if (scope.kind === 'country') return `country:${scope.countryCode}`;
  return 'world';
}
