/**
 * Recommendation Engine — Step 6, Steps 11-13 — a lightweight, backend-
 * trusted-by-construction A/B experiment framework. "Backend-trusted"
 * here means: the client CANNOT assign itself a different/better variant,
 * not that assignment computation needs to happen on a server — a
 * deterministic hash of (userId, experimentId) is safe to compute
 * anywhere, since nothing about it depends on anything the client
 * controls or could forge (a user cannot change their own uid). This
 * mirrors this codebase's own established pattern of keeping every
 * ranking tunable in a plain, versioned TypeScript config file (see
 * recommendationConfig.ts's own doc comment) rather than inventing a
 * separate Firestore-editable config layer — Step 12's own "choose the
 * safest structure for the EXISTING architecture" instruction.
 *
 * Step 29 — NOTHING in this file is wired into real ranking yet. The one
 * experiment defined below (COLLABORATIVE_WEIGHT_V1) is `enabled: false`
 * and its `control` variant is defined to literally equal today's real
 * production constant, so even the ACT of computing an assignment (which
 * this pass does, for session-summary recording — see feedSessions.ts)
 * has zero effect on what any user actually sees. This is instrumentation
 * infrastructure, not a launched experiment.
 */
import { hashToUnitInterval } from './ranking';
import { COLLABORATIVE_WEIGHT } from './collaborativeConfig';

export type ExperimentVariantId = 'control' | 'treatment';

export type ExperimentDefinition<TConfig> = {
  /** Stable, never-reused identifier — part of the assignment hash input, so renaming an experiment silently re-randomizes every user's bucket (deliberate: a renamed experiment IS a new experiment). */
  id: string;
  /** Step 13 — every experiment ships disabled by default. An admin flips this in a future, deliberate code change (this is a plain TS constant, not a live-toggleable remote config — Step 26's own "no dashboard yet" scope). */
  enabled: boolean;
  /** 0-100 — what fraction of assigned users land in `treatment` when enabled. Defaults to 50. */
  treatmentPercentage?: number;
  variants: {
    control: TConfig;
    treatment: TConfig;
  };
};

export type ExperimentAssignment<TConfig> = {
  variantId: ExperimentVariantId;
  config: TConfig;
};

/** Step 11 — deterministic assignment: `hash(userId + experimentId)`, reusing ranking.ts's own FNV-1a hash (already unit-tested, already proven deterministic across JS environments) rather than a second hashing implementation. The SAME user always lands in the SAME bucket for the SAME experiment, every session, forever (until the experiment is retired) — never re-randomized per session. */
export function hashUserToExperimentUnit(userId: string, experimentId: string): number {
  return hashToUnitInterval(`${userId}:${experimentId}`);
}

/**
 * Step 13 — a disabled experiment ALWAYS returns `control`, unconditionally
 * — no hashing even happens in that case, so there is no code path by
 * which a disabled experiment could ever assign `treatment`.
 */
export function assignExperimentVariant<TConfig>(userId: string, experiment: ExperimentDefinition<TConfig>): ExperimentAssignment<TConfig> {
  if (!experiment.enabled) {
    return { variantId: 'control', config: experiment.variants.control };
  }
  const threshold = (experiment.treatmentPercentage ?? 50) / 100;
  const unit = hashUserToExperimentUnit(userId, experiment.id);
  const variantId: ExperimentVariantId = unit < threshold ? 'treatment' : 'control';
  return { variantId, config: experiment.variants[variantId] };
}

// ---------------------------------------------------------------------------
// Step 13 — the one, disabled, example experiment this pass ships.
// `control.collaborativeWeight` deliberately REUSES the real production
// constant (never a hand-copied literal that could silently drift from
// it) so "everyone is on control" (true today, since `enabled: false`)
// is provably identical to "no experiment exists at all".
// ---------------------------------------------------------------------------
export const COLLABORATIVE_WEIGHT_V1_EXPERIMENT: ExperimentDefinition<{ collaborativeWeight: number }> = {
  id: 'collaborative_weight_v1',
  enabled: false,
  treatmentPercentage: 50,
  variants: {
    control: { collaborativeWeight: COLLABORATIVE_WEIGHT },
    treatment: { collaborativeWeight: 0.12 },
  },
};

/** The full registry a session summary (or any future caller) checks — a single place to see every experiment that exists, matching recommendationConfig.ts's own "one place, no scattered magic values" convention. Add future experiments here, always `enabled: false` until deliberately launched. */
export const ALL_EXPERIMENTS: ExperimentDefinition<Record<string, number>>[] = [COLLABORATIVE_WEIGHT_V1_EXPERIMENT as ExperimentDefinition<Record<string, number>>];
