/**
 * Step 12D — the one new decision rankEventSections' own scoring context
 * needs: which hashtags (if any) a candidate's own `reelHashtags` score
 * context field should carry. Pulled out of
 * src/services/recommendations/recommendationEngine.ts so it's directly
 * unit-testable (that file has real Firestore calls, unlike this one —
 * only a type-only import here, zero runtime dependency).
 *
 * `ActivityContent` never has a `hashtags` field (Activities are retired
 * from creation — Step 41.2B.1 — and never had hashtag support even
 * before that), so it always resolves to `[]`. A legacy Event predating
 * Step 12D has `hashtags: undefined` (the field is OPTIONAL — see
 * EventContent.hashtags' own doc comment in src/types/content.ts) and
 * also resolves to `[]` — the exact same neutral result
 * scoreHashtagRelevance's own empty-array guard always produced before
 * this step existed, so a legacy Event's ranking is byte-identical to
 * before.
 */
import type { ActivityContent, EventContent } from '../types/content';

export function resolveEventHashtagsForScoring(event: ActivityContent | EventContent): readonly string[] {
  return event.type === 'event' ? (event.hashtags ?? []) : [];
}
