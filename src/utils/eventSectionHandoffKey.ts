/**
 * Step 12A — the pure cache-key logic behind src/services/content.ts's
 * Events "Show more" handoff cache (forYouSectionsHandoff/
 * followingSectionsHandoff), pulled out into its own dependency-light
 * module so it's directly unit-testable under plain `tsx`.
 *
 * content.ts itself cannot be imported under plain `tsx` at all — it
 * internally uses this project's `@/` path alias (e.g. `@/constants/
 * interests`), which `tsx`'s module resolution does not support (probed
 * directly: even a top-level `@/` import from a test file fails with
 * MODULE_NOT_FOUND, not just a nested one). So this file deliberately
 * imports `browseScopeKey`/`BrowseScope` via a RELATIVE path, not the
 * `@/` alias — functionally identical at real app runtime (Metro
 * resolves both the same way), but the only form that lets this file
 * (and tests/eventsSectionHandoff.test.ts) run under plain `tsx` — same
 * convention already established this session for reelNetworkClass.ts/
 * reelPlaybackSessionState.ts.
 *
 * content.ts imports these two functions FROM here rather than defining
 * its own copies, so there is exactly one real implementation, never two
 * that could drift.
 */
import { browseScopeKey, type BrowseScope } from '../types/browseScope';

/**
 * Step 12A — `uid` is part of this key because the cache it keys into
 * now holds a RANKED (personalized) result, not a plain chronological
 * one (see content.ts's own setForYouSectionsHandoff doc comment for the
 * full "why" — before Step 12A this was scope+limit only, which leaked
 * one viewer's ranked order to a different viewer opening the same
 * scope's Events tab within the cache's short TTL). A signed-out viewer
 * (no ranking at all) passes `''`, which can never collide with a real
 * Firebase uid.
 *
 * This and followingHandoffKey deliberately share the same string
 * template — that is NOT a collision risk: each is only ever used as a
 * key into its OWN separate module-level Map in content.ts
 * (forYouSectionsHandoff vs. followingSectionsHandoff), never a shared
 * one. What distinguishes For-You data from Following data is which MAP
 * a key is looked up in, not the shape of the key string itself.
 */
export function forYouHandoffKey(uid: string, scope: BrowseScope, limitCount: number): string {
  return `${uid}:${browseScopeKey(scope)}:${limitCount}`;
}

/** Same shape as forYouHandoffKey — see that function's own doc comment for why an identical template across the two is safe. */
export function followingHandoffKey(uid: string, scope: BrowseScope, limitCount: number): string {
  return `${uid}:${browseScopeKey(scope)}:${limitCount}`;
}
