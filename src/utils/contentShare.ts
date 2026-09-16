/**
 * Share foundation for any content/{contentId} document (Post/Activity/
 * Event) — same "stable route identity, never a feed position" shape as
 * reelShare.ts's own buildReelShareUrl, just pointed at the generic
 * `/content/{contentId}` route (see content/[contentId].tsx) instead of
 * `/reel/{reelId}`. Kept as its own small file rather than folded into
 * reelShare.ts since a Reel and a Post/Activity/Event are different route
 * trees with no shared code today — see reelShare.ts's own doc comment
 * for the same web-origin-vs-app-scheme reasoning that applies here too.
 */
import { Platform, Share } from 'react-native';

export function buildContentShareUrl(contentId: string): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/content/${contentId}`;
  }
  return `aroundme://content/${contentId}`;
}

export type ShareContentResult = { ok: true } | { ok: false; message: string };

/** Only ever call this with content the caller has already confirmed is loaded (same rule as shareReel). `title` is shown as the share sheet's own title, not embedded twice in the message. */
export async function shareContent(contentId: string, title: string): Promise<ShareContentResult> {
  const url = buildContentShareUrl(contentId);
  try {
    await Share.share({
      title,
      message: `${title} on Around Me: ${url}`,
      url,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Couldn't share this." };
  }
}
