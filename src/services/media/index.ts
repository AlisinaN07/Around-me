/**
 * Storage-provider abstraction — Step 4's foundation for eventually
 * supporting Cloudflare R2 alongside Firebase Storage. See the Step 4
 * report for the full architectural picture (public vs. protected media,
 * the proposed presigned-URL upload flow, the Cloudflare setup plan).
 *
 * NOTHING here is wired into production media flow yet:
 * reels.ts/stories.ts/userProfile.ts/content.ts keep uploading,
 * resolving, and deleting Firebase Storage objects exactly as they did
 * before this directory existed. `getMediaStorageProvider()` always
 * resolves to `'firebase'` today (its only possible other value, `'r2'`,
 * requires an explicit, currently-unset build config value — see
 * config.ts), and nothing in the app reads it.
 */
export type { MediaProvider, MediaReference, MediaUploadAuthorization } from './types';
export { interpretMediaProvider } from './types';
export type { MediaStorageProvider, MediaUploadProgressCallback, MediaUploadResult } from './provider';
export { getMediaStorageProvider } from './config';
export { firebaseMediaProvider } from './firebaseProvider';
export { r2MediaProvider } from './r2Provider';

import { getMediaStorageProvider } from './config';
import { firebaseMediaProvider } from './firebaseProvider';
import type { MediaStorageProvider } from './provider';
import { r2MediaProvider } from './r2Provider';

/**
 * Picks the provider implementation matching getMediaStorageProvider()'s
 * current value. Not called anywhere in production yet — a future
 * migration step would use this instead of importing firebaseProvider/
 * r2Provider directly, so a single config value governs every call site
 * at once.
 */
export function getDefaultMediaProvider(): MediaStorageProvider {
  return getMediaStorageProvider() === 'r2' ? r2MediaProvider : firebaseMediaProvider;
}
