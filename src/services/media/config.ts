import type { MediaProvider } from './types';

const VALID_PROVIDERS: readonly MediaProvider[] = ['firebase', 'r2'];

/**
 * Which provider NEW media should eventually be created under — read
 * from a plain, non-secret Expo public build config value (a mode
 * string, never a credential — R2's actual access keys must NEVER use an
 * EXPO_PUBLIC_* name; see functions/src/media/r2Config.ts's own doc
 * comment for why those live server-side only).
 *
 * Defaults to 'firebase', and falls back to 'firebase' for ANY unset or
 * unrecognized value — this must never throw or crash app startup just
 * because R2 isn't configured yet (Step 4's own explicit requirement).
 * Not read by any production upload path yet: reels.ts/stories.ts/
 * userProfile.ts/content.ts are unchanged and always upload to Firebase
 * directly, regardless of this value.
 */
export function getMediaStorageProvider(): MediaProvider {
  const raw = process.env.EXPO_PUBLIC_MEDIA_STORAGE_PROVIDER;
  return (VALID_PROVIDERS as readonly string[]).includes(raw ?? '') ? (raw as MediaProvider) : 'firebase';
}
