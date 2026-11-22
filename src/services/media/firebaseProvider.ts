import { deleteObject, getDownloadURL, ref, uploadBytesResumable } from 'firebase/storage';

import { storage } from '../storage';
import type { MediaStorageProvider, MediaUploadRequest, MediaUploadResult } from './provider';
import type { MediaKind } from './types';

/**
 * Mirrors the deterministic path conventions already used inline in
 * userProfile.ts (`profilePhotos/${uid}/photo`, `profileCovers/${uid}/photo`)
 * — the only media kinds this provider actually implements today (see
 * provider.ts's own doc comment). Extending this to other media kinds is
 * future work, not something to speculatively stub out now.
 */
function pathForMediaKind(mediaKind: MediaKind, uid: string): string {
  if (mediaKind === 'profileCover') return `profileCovers/${uid}/photo`;
  if (mediaKind === 'profilePhoto') return `profilePhotos/${uid}/photo`;
  // Exhaustive — MediaKind only has these two members today (see types.ts).
  throw new Error(`Unsupported media kind: ${mediaKind}`);
}

/**
 * The Firebase Storage implementation of MediaStorageProvider — a thin,
 * behavior-preserving wrapper around the exact same `firebase/storage`
 * calls reels.ts/stories.ts/userProfile.ts/content.ts already make
 * directly today (fetch the local URI into a Blob, `uploadBytesResumable`,
 * resolve via `getDownloadURL`, remove via `deleteObject`).
 *
 * NOT yet used by userProfile.ts's own real uploadProfilePhoto — Step
 * 5A's own "if provider = firebase, current behavior remains EXACTLY
 * unchanged" requirement is met more simply by leaving that function's
 * own already-shipped code untouched, rather than routing it through
 * this wrapper only to reproduce the identical calls. This exists so a
 * FUTURE step can migrate that call site onto this shared abstraction
 * with zero behavior change, since the underlying calls here are
 * identical to what it already does inline.
 */
export const firebaseMediaProvider: MediaStorageProvider = {
  provider: 'firebase',

  async upload({ mediaKind, uid, localUri, contentType, onProgress }: MediaUploadRequest): Promise<MediaUploadResult> {
    if (!storage) return { ok: false, message: 'Storage is not available.' };

    const path = pathForMediaKind(mediaKind, uid);

    let blob: Blob;
    try {
      const response = await fetch(localUri);
      blob = await response.blob();
    } catch {
      return { ok: false, message: "Couldn't read this file." };
    }

    return new Promise<MediaUploadResult>((resolve) => {
      const task = uploadBytesResumable(ref(storage!, path), blob, { contentType: blob.type || contentType });
      task.on(
        'state_changed',
        (snapshot) => {
          const percent = snapshot.totalBytes > 0 ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100) : 0;
          onProgress(percent);
        },
        () => resolve({ ok: false, message: "Couldn't upload this file." }),
        () => resolve({ ok: true, reference: { provider: 'firebase', path } })
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
