import type { MediaProvider } from './types';

export type MediaUploadProgressCallback = (percent: number) => void;
export type MediaUploadResult = { ok: true } | { ok: false; message: string };

/**
 * The shape every storage backend must implement — the abstraction that
 * eventually lets upload/playback/delete code stop caring which provider
 * a given object lives in, instead of an `if (provider === 'r2')`
 * branch copy-pasted into every call site. See firebaseProvider.ts for
 * the only real implementation today, and r2Provider.ts for the
 * not-yet-implemented stub.
 *
 * NOTHING in production constructs or calls through this interface yet
 * — see this directory's own index.ts doc comment. Method shapes
 * deliberately mirror this codebase's EXISTING upload/delete
 * conventions (a progress-callback upload rather than a bare Promise —
 * see reels.ts's uploadReelVideo; a delete that never throws for an
 * already-missing object — see reels.ts's discardReelDraft) so a future
 * migration is a like-for-like swap, not a new shape to learn.
 */
export interface MediaStorageProvider {
  readonly provider: MediaProvider;
  /** Uploads local file bytes at `localUri` to `path`. */
  upload(path: string, localUri: string, contentType: string, onProgress: MediaUploadProgressCallback): Promise<MediaUploadResult>;
  /** Resolves a playable/renderable URL for an already-uploaded object at `path` — `null` when it can't be resolved (matches resolveReelPlaybackUrl's own "null on failure, never throws" contract in reels.ts). */
  resolveUrl(path: string): Promise<string | null>;
  /** Deletes the object at `path`. Never throws for an already-missing object. */
  delete(path: string): Promise<void>;
}
