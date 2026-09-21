import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage';

import { storage } from '../storage';
import type { MediaStorageProvider, MediaUploadProgressCallback, MediaUploadResult } from './provider';

/**
 * The Firebase Storage implementation of MediaStorageProvider — a thin,
 * behavior-preserving wrapper around the exact same `firebase/storage`
 * calls reels.ts/stories.ts/userProfile.ts/content.ts already make
 * directly today (fetch the local URI into a Blob, `uploadBytesResumable`,
 * resolve via `getDownloadURL`, remove via `deleteObject`).
 *
 * NOT yet used by any of those files — Step 4's own "prefer foundation
 * over a large refactor" instruction means they keep their own, already-
 * shipped, already-tested upload code untouched. This exists so a FUTURE
 * step can migrate one call site at a time onto this shared abstraction
 * with zero behavior change, since the underlying calls are identical to
 * what each call site already does inline.
 */
export const firebaseMediaProvider: MediaStorageProvider = {
  provider: 'firebase',

  async upload(path: string, localUri: string, contentType: string, onProgress: MediaUploadProgressCallback): Promise<MediaUploadResult> {
    if (!storage) return { ok: false, message: 'Storage is not available.' };

    let blob: Blob;
    try {
      const response = await fetch(localUri);
      blob = await response.blob();
    } catch {
      return { ok: false, message: "Couldn't read this file." };
    }

    return new Promise<MediaUploadResult>((resolve) => {
      const task = uploadBytesResumable(ref(storage!, path), blob, { contentType });
      task.on(
        'state_changed',
        (snapshot) => {
          const percent = snapshot.totalBytes > 0 ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0;
          onProgress(percent);
        },
        () => resolve({ ok: false, message: "Couldn't upload this file." }),
        () => resolve({ ok: true })
      );
    });
  },

  async resolveUrl(path: string): Promise<string | null> {
    if (!storage) return null;
    try {
      return await getDownloadURL(ref(storage, path));
    } catch {
      return null;
    }
  },

  async delete(path: string): Promise<void> {
    if (!storage) return;
    await deleteObject(ref(storage, path)).catch(() => undefined);
  },
};
