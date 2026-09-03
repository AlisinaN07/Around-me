import { INTERESTS } from '@/constants/interests';

/**
 * Karlstad launch-category shortlist (Step 22, Section 35) — product
 * documentation/config only, no new content ever tagged with these ids
 * directly. Each entry maps a launch-facing DISPLAY label onto an
 * EXISTING, already-stable `src/constants/interests.ts` id — the same
 * taxonomy content.categoryId and onboarding interests already share (see
 * Section 10). No new category ids are introduced here; a few launch
 * labels intentionally group under a broader existing id (e.g. "Sports &
 * Football" -> 'sports', since there's no separate 'football' id and
 * inventing one is exactly the "casual rename/new id" this step avoids).
 */
export type LaunchCategory = { label: string; interestId: string };

export const KARLSTAD_LAUNCH_CATEGORIES: LaunchCategory[] = [
  { label: 'Nightlife', interestId: 'nightlife' },
  { label: 'Sports & Football', interestId: 'sports' },
  { label: 'Music', interestId: 'music' },
  { label: 'Food & Drink', interestId: 'food' },
  { label: 'Culture', interestId: 'art' },
  { label: 'Student', interestId: 'student_life' },
  { label: 'Family', interestId: 'family' },
  { label: 'Outdoor', interestId: 'outdoors' },
  { label: 'Community', interestId: 'networking' },
];

// Fails loudly in dev if a future edit to this file typos an interestId —
// cheaper to catch here than to silently filter zero results on /events.
if (__DEV__) {
  const validIds = new Set(INTERESTS.map((interest) => interest.id));
  for (const category of KARLSTAD_LAUNCH_CATEGORIES) {
    if (!validIds.has(category.interestId)) {
      console.error(`[launchCategories] "${category.label}" maps to unknown interestId "${category.interestId}"`);
    }
  }
}
