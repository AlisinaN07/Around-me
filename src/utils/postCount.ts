/**
 * Compact post-count formatting ("12.4K posts") — pulled out of the
 * hashtag page screen (src/app/(app)/hashtag/[hashtag].tsx) into its own
 * pure utils module purely so it's importable from a plain-Node test file
 * (tests/hashtagPage.test.ts) the same way every other pure helper in this
 * codebase is — screen (.tsx) files are never imported by this project's
 * tests (they pull in react-native/expo-router, which the plain `tsx`
 * test runner can't resolve; see tests/recommendations.test.ts and
 * tests/cities.test.ts, which both only ever import from src/services,
 * src/utils, or src/constants). No existing formatter in this codebase did
 * compact-number display before the hashtag page needed one (grep
 * confirms), so this is new, not a duplicate of anything.
 */
export function formatPostCount(count: number): string {
  const noun = (n: number) => (n === 1 ? 'post' : 'posts');
  if (count < 1000) return `${count} ${noun(count)}`;
  const compact = count < 1_000_000 ? count / 1000 : count / 1_000_000;
  const suffix = count < 1_000_000 ? 'K' : 'M';
  const rounded = Math.round(compact * 10) / 10;
  const value = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  return `${value}${suffix} posts`;
}
