/**
 * Recommendation Engine — Step 6, Step 23 — configurable feed-health
 * guardrail thresholds + a pure evaluator comparing a CURRENT metrics
 * snapshot against a BASELINE one (e.g. yesterday vs. a week ago, or
 * treatment vs. control — this file doesn't care which). Reporting/
 * logging only (Step 23's own "do not send production alerts unless
 * notification infrastructure already exists" — this project has none)
 * — the admin evaluation script (scripts/evaluate-recommendations.cjs)
 * is the one place this actually runs today.
 */

export const GUARDRAIL_THRESHOLDS = {
  /** notInterestedRate doubling (or more) vs. baseline is a real regression signal (Step 23's own literal example). */
  notInterestedRateFactor: 2,
  /** quickSkipRate rising to 1.5x baseline or more. */
  quickSkipRateFactor: 1.5,
  /** eventOpenRate falling to 70% of baseline or below. */
  eventOpenRateDropFactor: 0.7,
  /** An absolute ceiling on repeat-exposure rate, independent of baseline — a feed showing the same content too often is unhealthy regardless of history. */
  repeatExposureRateCeiling: 0.3,
} as const;

export type GuardrailSnapshot = {
  notInterestedRate: number;
  quickSkipRate: number;
  eventOpenRate: number;
  repeatExposureRate: number;
};

export type GuardrailViolation = {
  metric: keyof GuardrailSnapshot;
  message: string;
  baseline: number;
  current: number;
};

/**
 * Step 23 — returns every guardrail that fired, or an empty array when
 * the feed is healthy. A baseline value of exactly 0 never triggers the
 * relative-change guardrails (dividing by zero would be meaningless —
 * a genuinely new metric with no history yet isn't a "regression").
 */
export function evaluateGuardrails(baseline: GuardrailSnapshot, current: GuardrailSnapshot): GuardrailViolation[] {
  const violations: GuardrailViolation[] = [];

  if (baseline.notInterestedRate > 0 && current.notInterestedRate >= baseline.notInterestedRate * GUARDRAIL_THRESHOLDS.notInterestedRateFactor) {
    violations.push({
      metric: 'notInterestedRate',
      message: `not-interested rate rose to ${GUARDRAIL_THRESHOLDS.notInterestedRateFactor}x baseline or more`,
      baseline: baseline.notInterestedRate,
      current: current.notInterestedRate,
    });
  }
  if (baseline.quickSkipRate > 0 && current.quickSkipRate >= baseline.quickSkipRate * GUARDRAIL_THRESHOLDS.quickSkipRateFactor) {
    violations.push({
      metric: 'quickSkipRate',
      message: `quick-skip rate rose to ${GUARDRAIL_THRESHOLDS.quickSkipRateFactor}x baseline or more`,
      baseline: baseline.quickSkipRate,
      current: current.quickSkipRate,
    });
  }
  if (baseline.eventOpenRate > 0 && current.eventOpenRate <= baseline.eventOpenRate * GUARDRAIL_THRESHOLDS.eventOpenRateDropFactor) {
    violations.push({
      metric: 'eventOpenRate',
      message: `event open rate dropped to ${GUARDRAIL_THRESHOLDS.eventOpenRateDropFactor}x baseline or below`,
      baseline: baseline.eventOpenRate,
      current: current.eventOpenRate,
    });
  }
  if (current.repeatExposureRate >= GUARDRAIL_THRESHOLDS.repeatExposureRateCeiling) {
    violations.push({
      metric: 'repeatExposureRate',
      message: `repeat exposure rate is at or above the absolute ceiling (${GUARDRAIL_THRESHOLDS.repeatExposureRateCeiling})`,
      baseline: GUARDRAIL_THRESHOLDS.repeatExposureRateCeiling,
      current: current.repeatExposureRate,
    });
  }

  return violations;
}
