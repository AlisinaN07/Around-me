/**
 * Step 9A — the shared, pure decision behind BOTH resolveReelVideoPlaybackUrl
 * and resolveReelThumbnailUrl (reels.ts): given a Reel-media object's own
 * persisted provider field and its persisted URL, which of the three
 * possible outcomes applies? Extracted into its own dependency-free file
 * specifically so this exact branching (including the "r2 but somehow
 * empty" edge case) is directly unit-testable, and so both the video and
 * thumbnail resolvers are provably using the IDENTICAL decision rule
 * rather than two hand-written, potentially-diverging copies of the same
 * three-way branch.
 *
 * Deliberately narrow: this file has NO knowledge of Firebase, Reel
 * shapes, or storagePath resolution — it only ever answers "given a
 * provider string and a persisted URL, what should the caller do?". The
 * caller (reels.ts) is responsible for the 'firebase' branch's own
 * lazy-resolution behavior (resolveReelPlaybackUrl), which this file
 * neither performs nor needs to know about.
 */

export type ProviderUrlResolution =
  | { mode: 'r2'; url: string }
  /** provider is 'r2' but the persisted URL is empty/missing — a genuinely malformed document. Deliberately its own distinct outcome, never silently folded into 'firebase': a Reel explicitly marked 'r2' must never quietly play/display Firebase-resolved content it was never confirmed to have — see this file's own doc comment on why a document explicitly marked R2 never silently falls back. */
  | { mode: 'r2-malformed' }
  /** provider is 'firebase' (or missing/any other value — see pickProviderUrl's own doc comment on defaulting) — the caller should fall back to its own existing lazy Firebase resolution. */
  | { mode: 'firebase' };

/**
 * `provider` defaults to the 'firebase' outcome for ANY value other than
 * the exact string `'r2'` — this covers a legacy document missing the
 * field entirely (`undefined`), an explicit `'firebase'`, and (as a safe
 * default, never a silent failure) any unrecognized future value, mirroring
 * this codebase's own established "unknown means the safe default"
 * convention (see e.g. src/services/media/config.ts's getMediaStorageProvider).
 *
 * For `provider === 'r2'` specifically, an empty/missing `persistedUrl` is
 * NEVER treated as "fall back to Firebase" — that would mean a Reel/
 * thumbnail explicitly confirmed as R2-backed silently trying to resolve
 * itself from a Firebase Storage object that was never actually written
 * (the object simply isn't there), which would either return a broken
 * URL or a confusing unrelated one. `r2-malformed` is a distinct, honest
 * "this document is broken" outcome instead.
 */
export function pickProviderUrl(provider: unknown, persistedUrl: unknown): ProviderUrlResolution {
  if (provider !== 'r2') return { mode: 'firebase' };
  if (typeof persistedUrl === 'string' && persistedUrl.length > 0) {
    return { mode: 'r2', url: persistedUrl };
  }
  return { mode: 'r2-malformed' };
}
