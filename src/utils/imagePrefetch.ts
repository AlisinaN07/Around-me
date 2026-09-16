/**
 * Phase 3 perf pass — the one small shared "prefetch this image once per
 * app session" helper behind every media-prefetch call site added this
 * phase (Reel thumbnails, author/profile avatars, Event cover photos).
 * Backed entirely by React Native's own `Image.prefetch` (already ships
 * with react-native — no new dependency) plus a plain in-memory `Set` of
 * URLs already attempted THIS session, so scrolling back and forth over
 * the same few items, or revisiting the same screen, never re-issues the
 * same network request.
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
import { Image } from 'react-native';

const prefetchedUrls = new Set<string>();

/**
 * No-ops for an empty/undefined URL or one already attempted this
 * session. Left in the Set even on failure — a URL that failed once this
 * session isn't worth retrying automatically, the same "attempt once per
 * session" policy already used by every other in-memory cache in this
 * codebase (e.g. ReelFeedItem's own authorPhotoURL fetch-once-per-mount
 * effect).
 */
export function prefetchImageOnce(url: string | null | undefined): void {
  if (!url || prefetchedUrls.has(url)) return;
  prefetchedUrls.add(url);
  Image.prefetch(url).catch(() => {
    // Best-effort only — see this function's own doc comment.
  });
}
