/**
 * Phase 3 perf pass — the one small shared "prefetch this image once per
 * app session" helper behind every media-prefetch call site added this
 * phase (Reel thumbnails, author/profile avatars, Event cover photos).
 * Backed by `expo-image`'s own `Image.prefetch` — that's the cache these
 * bytes actually need to land in now that every real render site
 * (Avatar.tsx, MediaCard.tsx, ContentCard.tsx, ProfileHeader.tsx,
 * ReelFeedItem.tsx) uses `expo-image`'s `<Image>` with
 * `cachePolicy="memory-disk"` rather than React Native's own `<Image>` —
 * warming RN's native HTTP cache instead (as this file did before the
 * `expo-image` migration) would prefetch into a cache none of those
 * components read from anymore, silently making every call site here a
 * no-op. `Image.prefetch` defaults to disk caching and accepts a second
 * `cachePolicy` argument for memory+disk — passed explicitly below to
 * match every render site's own policy exactly, so a prefetched image is
 * guaranteed already warm (memory, not just disk) by the time its real
 * `<Image>` mounts.
 *
 * Still backed by a plain in-memory `Set` of URLs already attempted THIS
 * session, so scrolling back and forth over the same few items, or
 * revisiting the same screen, never re-issues the same prefetch call.
 *
 * Deliberately fire-and-forget and silent on failure — a failed prefetch
 * just means the eventual real `<Image>`/`<Avatar>` render falls back to
 * its own normal fetch, exactly as it would have before this phase
 * existed. This is a pure perceived-speed optimization, never a
 * requirement for anything to actually display, and it never creates a
 * Firestore/Storage read on its own — every call site resolves its URL
 * first (reusing an existing fetch/cache), then only prefetches the
 * bytes for a URL it already has in hand.
 */
import { Image } from 'expo-image';

const prefetchedUrls = new Set<string>();

/**
 * No-ops for an empty/undefined URL or one already attempted this
 * session. Left in the Set even on failure — a URL that failed once this
 * session isn't worth retrying automatically, the same "attempt once per
 * session" policy already used by every other in-memory cache in this
 * codebase (e.g. ReelFeedItem's own authorPhotoURL fetch-once-per-mount
 * effect). `expo-image`'s own prefetch resolves to `false` on failure
 * rather than rejecting, but the `.catch()` is kept as a harmless
 * safety net for a genuinely thrown/rejected call (e.g. a malformed URL).
 */
export function prefetchImageOnce(url: string | null | undefined): void {
  if (!url || prefetchedUrls.has(url)) return;
  prefetchedUrls.add(url);
  Image.prefetch(url, 'memory-disk').catch(() => {
    // Best-effort only — see this function's own doc comment.
  });
}
