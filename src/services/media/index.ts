/**
 * Storage-provider abstraction — Step 4's foundation, now given its
 * first real production wiring in Step 5A: `userProfile.ts`'s profile-
 * photo upload calls `getDefaultMediaProvider()` and branches on the
 * result (see that file's own `uploadProfilePhoto` for exactly how).
 * Every other upload — profile cover, Reel, Story, Event — is untouched
 * and keeps talking to Firebase Storage directly, not through this
 * abstraction at all.
 *
 * `getMediaStorageProvider()` defaults to `'firebase'` and stays there
 * unless `EXPO_PUBLIC_MEDIA_STORAGE_PROVIDER=r2` is explicitly set (see
 * config.ts) — so by default, in every real build today, profile-photo
 * upload behaves EXACTLY as it did before this abstraction existed.
 */
export type { MediaKind, MediaProvider, MediaReference, MediaUploadAuthorization } from './types';
export { interpretMediaProvider } from './types';
export type { MediaStorageProvider, MediaUploadProgressCallback, MediaUploadRequest, MediaUploadResult } from './provider';
export { getMediaStorageProvider } from './config';
export { firebaseMediaProvider } from './firebaseProvider';
export { r2MediaProvider } from './r2Provider';

import { getMediaStorageProvider } from './config';
import { firebaseMediaProvider } from './firebaseProvider';
import type { MediaStorageProvider } from './provider';
import { r2MediaProvider } from './r2Provider';

/** Picks the provider implementation matching getMediaStorageProvider()'s current value. */
export function getDefaultMediaProvider(): MediaStorageProvider {
  return getMediaStorageProvider() === 'r2' ? r2MediaProvider : firebaseMediaProvider;
}
