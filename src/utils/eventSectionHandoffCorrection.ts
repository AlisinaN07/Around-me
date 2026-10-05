/**
 * Step 12B — the pure "remove one item from a DiscoverySections-shaped
 * object" logic behind src/services/content.ts's
 * removeContentIdFromForYouSectionsHandoffForUser, pulled out into its
 * own dependency-light module so it's directly unit-testable.
 *
 * content.ts itself cannot be imported under plain `tsx`/node AT ALL,
 * under any Node version — probed directly: it transitively imports
 * src/services/firebase.ts, which references `__DEV__` (an Expo/React
 * Native global that simply doesn't exist outside that runtime), so this
 * is a harder blocker than the `@/` path-alias issue found earlier this
 * session (that one turned out to be Node-18-specific; this one is not).
 * This file imports only plain types (erased at compile time) — zero
 * runtime dependency on content.ts, firebase.ts, or anything else that
 * could jeopardize its plain-`tsx` runnability.
 *
 * content.ts's own function keeps the trivial per-key uid-prefix Map
 * iteration un-extracted (3 lines, directly readable, matches Step 12A's
 * own precedent of leaving genuinely-trivial Map glue in place while
 * extracting only the real data transformation) — see that function's
 * own doc comment.
 */
import type { ActivityContent, EventContent } from '../types/content';

/** The exact shape every DiscoverySections/FollowingDiscoverySections.sections object carries — kept minimal and structural (not imported from content.ts, which isn't importable here) rather than duplicating that whole type. */
export type HandoffSections = {
  happeningNow: (ActivityContent | EventContent)[];
  today: (ActivityContent | EventContent)[];
  upcoming: (ActivityContent | EventContent)[];
};

/**
 * Returns a new sections object with every occurrence of `contentId`
 * removed from all three time-window arrays, preserving every other
 * field (e.g. `todayLabel`) and the relative order of every remaining
 * item untouched. A safe no-op (returns a shallow-equal-shaped copy,
 * never throws) when `contentId` isn't present in any of the three
 * arrays at all.
 */
export function removeContentIdFromSections<T extends HandoffSections>(sections: T, contentId: string): T {
  return {
    ...sections,
    happeningNow: sections.happeningNow.filter((item) => item.contentId !== contentId),
    today: sections.today.filter((item) => item.contentId !== contentId),
    upcoming: sections.upcoming.filter((item) => item.contentId !== contentId),
  };
}
