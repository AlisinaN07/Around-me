/**
 * Share foundation for a published Reel (Step 20). The shareable identity
 * is always `reelId` via the app's own `/reel/{reelId}` route — never a
 * Storage path, a download URL, or a feed position (see the Step 20
 * spec's explicit "stable route identity" requirement; also see
 * src/app/(app)/reel/[reelId].tsx, which already fetches by ID for
 * exactly this reason).
 */
import { Platform, Share } from 'react-native';

/**
 * On web, this is the real, currently-serving origin — confirmed by the
 * `npx expo export --platform web` output actually emitting `/reel/[reelId]`
 * as a route (see README). We do not own a production domain yet, so this
 * is deliberately never a hardcoded `aroundme.com`-style guess: it's
 * whatever origin is actually running the app right now (localhost during
 * development, or a real deployed origin once one exists).
 *
 * On native, there is no web origin at all — the shareable identity falls
 * back to the app's own registered scheme (`aroundme://`, see app.json),
 * which only resolves for someone who already has this exact app
 * installed. That is a real, documented limitation of not yet having a
 * web domain to back Universal Links/App Links — not something this
 * function can paper over, so it's called out here and in the README
 * rather than silently pretended away.
 */
export function buildReelShareUrl(reelId: string): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/reel/${reelId}`;
  }
  return `aroundme://reel/${reelId}`;
}

export type ShareReelResult = { ok: true } | { ok: false; message: string };

/**
 * Only ever call this with a Reel the caller has already confirmed is
 * loaded and published (see the Step 20 spec — never generate a Share
 * action for a Reel that isn't). Uses React Native's own `Share` API
 * (react-native-web forwards to `navigator.share` on web, rejecting
 * cleanly with a catchable error when the browser doesn't support it —
 * no separate sharing package needed).
 */
export async function shareReel(reelId: string): Promise<ShareReelResult> {
  const url = buildReelShareUrl(reelId);
  try {
    await Share.share({
      title: 'Around Me Reel',
      message: `Check out this Reel on Around Me: ${url}`,
      url,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Couldn't share this Reel." };
  }
}
