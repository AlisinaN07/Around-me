/**
 * Recommendation Engine — Step 6, Steps 18/19 — DEVELOPMENT/analytics-only
 * metadata describing WHY an item was surfaced. Pure, no Firestore, fully
 * unit-testable — derived entirely from values recommendationEngine.ts
 * already computed for real ranking (this file changes NOTHING about
 * scoring or ordering; see this feature's own Step 29 constraint). Never
 * rendered in production UI — see interactions.ts's own use of this for
 * where it actually reaches Firestore (as small, bounded fields on the
 * existing recommendationEvents log, not a new payload).
 */
import { LOCATION_SCORE } from './recommendationConfig';
import type { ExplorationBucket } from '@/types/recommendation';
import type { ScoreResult } from './ranking';

/** Step 5's own source-classification list, as far as this pass actually implements it — 'local_trending' is deliberately NOT included: there is no dedicated trending-candidate source in this engine (the shared local pool is recency-ordered, not popularity-ordered) — never fabricate a tag for a source that doesn't exist. */
export type SourceTag =
  | 'known_interest'
  | 'related_interest'
  | 'discovery'
  | 'collaborative_discovery'
  | 'followed_creator'
  | 'same_city'
  | 'secondary_city_exploration'
  | 'quality';

const BUCKET_TAG: Record<ExplorationBucket, SourceTag> = {
  known: 'known_interest',
  related: 'related_interest',
  discovery: 'discovery',
};

/** A location score above the plain worldwide baseline but below a true same-city match means the secondary-city-affinity bonus (see scoreLocation) actually moved it — i.e., this candidate is here BECAUSE of learned secondary-city affinity, not merely because world/country scope includes everything. */
function isSecondaryCityBoosted(locationScore: number): boolean {
  return locationScore > LOCATION_SCORE.worldwide + 0.001 && locationScore < LOCATION_SCORE.sameCity - 0.01;
}

function isSameCity(locationScore: number): boolean {
  return locationScore >= LOCATION_SCORE.sameCity - 0.01;
}

/** A meaningfully positive quality/popularity contribution — see QUALITY_COMPONENT threshold reasoning in qualityConfig.ts; 0.6 is comfortably above scorePopularity/scoreContentQuality's own neutral-prior range, so this only fires for content that's genuinely read as good, not merely "not bad yet". */
const QUALITY_TAG_THRESHOLD = 0.6;

/**
 * Derives the bounded, ordered set of tags for ONE ranked item from
 * values already computed during real scoring — see
 * recommendationEngine.ts's own call site. Order is deterministic
 * (bucket tag first) so two equal inputs always produce an identical
 * array, useful for tests and for downstream aggregation grouping.
 */
export function deriveSourceTags(breakdown: ScoreResult['breakdown'], bucket: ExplorationBucket, isFollowingCreator: boolean): SourceTag[] {
  const tags: SourceTag[] = [BUCKET_TAG[bucket]];
  if (breakdown.collaborativeAffinity > 0) tags.push('collaborative_discovery');
  if (isFollowingCreator) tags.push('followed_creator');
  if (isSameCity(breakdown.location)) tags.push('same_city');
  else if (isSecondaryCityBoosted(breakdown.location)) tags.push('secondary_city_exploration');
  if (breakdown.popularity > QUALITY_TAG_THRESHOLD) tags.push('quality');
  return tags;
}
