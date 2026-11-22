/**
 * Step 12C — the one new decision Event Save actually introduces: which
 * existing RecommendationAction a save/unsave tap should track. Pulled
 * out of src/services/saved.ts's own trackSaveSignal so it's directly
 * unit-testable (saved.ts itself cannot be imported under plain `tsx` —
 * it transitively hits `__DEV__` via firebase.ts, same class of blocker
 * as content.ts — see eventSectionHandoffCorrection.ts's own doc comment
 * for the full explanation). Zero runtime imports (only a type-only one,
 * fully erased) — safe under any Node version, any environment.
 *
 * Reuses the two EXISTING actions `event_save`/`event_unsave` (already
 * weighted in recommendationConfig.ts — SIGNAL_WEIGHTS.event_save = 7,
 * event_unsave = -7, both already classified ACTIVE_SIGNAL_ACTIONS) for
 * an Event target, and the generic `save`/`unsave` (weight 6/-6) for
 * everything else (Post, Reel) — no new action, no new weight, purely a
 * selection between four that already existed.
 */
import type { RecommendationAction } from '../types/recommendation';

export type SaveIntent = 'save' | 'unsave';

export function resolveSaveTrackingAction(isEvent: boolean, intent: SaveIntent): RecommendationAction {
  if (!isEvent) return intent;
  return intent === 'save' ? 'event_save' : 'event_unsave';
}
