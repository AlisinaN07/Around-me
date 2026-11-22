/**
 * Step 12C — the pure "which SavedPostItem kind does this resolved
 * content/{contentId} doc become" decision behind
 * src/services/saved.ts's own fetchSavedPosts, pulled out so it's
 * directly unit-testable (fetchSavedPosts itself needs a live Firestore
 * read to resolve the target, and saved.ts cannot be imported under
 * plain `tsx` at all — see eventSectionHandoffCorrection.ts's own doc
 * comment for why). Only a type-only import — zero runtime dependency.
 *
 * Deliberately returns `null` for a missing/unpublished/retired-type
 * (`'activity'`) document — the exact same "skip silently, never render
 * a broken card" rule every other saved-target branch in fetchSavedPosts
 * already follows for a deleted Reel/Post, reused here rather than
 * inventing Event-specific cleanup. Deliberately does NOT check the
 * Event's own `endsAt` — an expired Event stays in Saved exactly like a
 * past Reel would (Saved has never been time-filtered for any type;
 * "keep for later" doesn't stop meaning something once "later" arrives).
 */
import type { Content } from '../types/content';

export type SavedContentKind = 'text' | 'event';

export function classifySavedContent(content: Content | null | undefined): SavedContentKind | null {
  if (!content || content.status !== 'published') return null;
  if (content.type === 'event') return 'event';
  if (content.type === 'post') return 'text';
  return null; // 'activity' — a retired content type (Step 41.2B), never shown in Saved.
}
