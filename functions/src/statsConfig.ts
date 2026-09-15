/**
 * Recommendation Engine — Step 4 — the small set of thresholds the trusted
 * engagement-stats aggregation trigger (engagementStats.ts) needs to
 * independently re-validate client-reported watch data. This is a
 * DELIBERATE, DOCUMENTED DUPLICATE of the matching values in
 * src/services/recommendations/qualityConfig.ts (the Expo app's own copy)
 * — `functions/` is a completely separate, independently compiled Node
 * project (its own package.json/tsconfig/node_modules, targeting
 * commonjs/es2021 for the Cloud Functions runtime, never bundled with the
 * Expo app), so there is no safe/clean way to share one source file
 * between them without introducing a monorepo/workspace restructuring
 * this pass has no reason to do. If either MEANINGFUL_VIEW_* or
 * MAX_PLAUSIBLE_WATCH_MS ever changes, update BOTH copies — search for
 * "Step 4 mirrored config" to find this file's sibling.
 */

// Step 5 — same "meaningful view" definition as qualityConfig.ts.
export const MEANINGFUL_VIEW_MIN_MS = 2000;
export const MEANINGFUL_VIEW_MIN_PERCENT = 0.25;

// Step 11 — same watch-sample validation ceiling as qualityConfig.ts. A
// sample beyond this is REJECTED outright (not clamped-and-kept) — see
// validateWatchSample in engagementStats.ts.
export const MAX_PLAUSIBLE_WATCH_MS = 4 * 60 * 60 * 1000; // 4 hours
