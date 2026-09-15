/**
 * Recommendation Engine — Step 6, Steps 24/25 — the safest-possible
 * "should we trust this A/B result" check: a minimum-sample GATE plus a
 * simple relative-difference comparison. Deliberately NOT a real
 * statistical significance test (no p-value, no confidence interval) —
 * Step 24's own "do not build advanced statistical significance
 * infrastructure unless simple confidence intervals are easy" allows
 * this; simple, honest thresholds are enough for this project's current
 * (very small) data volume (Step 25).
 */

/** Below this many sessions in EITHER variant, no comparison is trustworthy at all — an arbitrary but explicit MVP floor (Step 24's own "minimum sessions per variant" example). */
export const MIN_SESSIONS_PER_VARIANT = 30;
/** A second, independent floor on the primary metric's own denominator — a variant could technically clear the session floor while still having almost no real views to measure a rate from. */
export const MIN_MEANINGFUL_VIEWS_PER_VARIANT = 200;
/** Below this relative difference, two variants are treated as indistinguishable — avoids reporting a "winner" from noise-level differences even once the sample floors are cleared. */
const MEANINGFUL_DIFFERENCE_PERCENT = 3;

export type VariantSampleSummary = {
  sessions: number;
  meaningfulViews: number;
  /** Whatever the experiment's own primary metric is (Step 14) — e.g. meaningful view rate — already computed by the caller. */
  primaryMetricValue: number;
};

export type ExperimentComparisonResult =
  | { status: 'INSUFFICIENT_DATA'; reason: string }
  | {
      status: 'CONTROL_BETTER' | 'TREATMENT_BETTER' | 'NO_CLEAR_DIFFERENCE';
      controlValue: number;
      treatmentValue: number;
      relativeDifferencePercent: number;
    };

/**
 * Step 25 — "current reality: very few users... do not fake conclusions.
 * If only 5 sessions exist, reports should say INSUFFICIENT_DATA rather
 * than claiming one variant is better." Both sample floors are checked
 * before any comparison is even attempted.
 */
export function compareExperimentVariants(control: VariantSampleSummary, treatment: VariantSampleSummary): ExperimentComparisonResult {
  if (control.sessions < MIN_SESSIONS_PER_VARIANT || treatment.sessions < MIN_SESSIONS_PER_VARIANT) {
    return {
      status: 'INSUFFICIENT_DATA',
      reason: `need at least ${MIN_SESSIONS_PER_VARIANT} sessions per variant (control=${control.sessions}, treatment=${treatment.sessions})`,
    };
  }
  if (control.meaningfulViews < MIN_MEANINGFUL_VIEWS_PER_VARIANT || treatment.meaningfulViews < MIN_MEANINGFUL_VIEWS_PER_VARIANT) {
    return {
      status: 'INSUFFICIENT_DATA',
      reason: `need at least ${MIN_MEANINGFUL_VIEWS_PER_VARIANT} meaningful views per variant (control=${control.meaningfulViews}, treatment=${treatment.meaningfulViews})`,
    };
  }

  const relativeDifferencePercent = control.primaryMetricValue !== 0 ? ((treatment.primaryMetricValue - control.primaryMetricValue) / control.primaryMetricValue) * 100 : 0;

  if (Math.abs(relativeDifferencePercent) < MEANINGFUL_DIFFERENCE_PERCENT) {
    return { status: 'NO_CLEAR_DIFFERENCE', controlValue: control.primaryMetricValue, treatmentValue: treatment.primaryMetricValue, relativeDifferencePercent };
  }
  return {
    status: relativeDifferencePercent > 0 ? 'TREATMENT_BETTER' : 'CONTROL_BETTER',
    controlValue: control.primaryMetricValue,
    treatmentValue: treatment.primaryMetricValue,
    relativeDifferencePercent,
  };
}
