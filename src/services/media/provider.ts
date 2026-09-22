import type { MediaKind, MediaProvider, MediaReference } from './types';

export type MediaUploadProgressCallback = (percent: number) => void;

export type MediaUploadRequest = {
  mediaKind: MediaKind;
  /** The Firebase Auth uid this upload belongs to — always the CALLER's own uid in every real call site (never chosen freely); each provider implementation is responsible for using this, not a client-supplied path, to derive where the object actually lives. */
  uid: string;
  localUri: string;
  /** A FALLBACK only — each provider reads the actually-fetched local file's own `blob.type` first (the real truth once the file is read) and only falls back to this when the picker/platform didn't report one, matching this codebase's own existing `blob.type || 'image/jpeg'` convention (see userProfile.ts's pre-existing uploadProfilePhoto). Never trust this field alone for what's actually about to be uploaded. */
  contentType: string;
  onProgress: MediaUploadProgressCallback;
};

export type MediaUploadResult = { ok: true; reference: MediaReference } | { ok: false; message: string };

/**
 * The shape every storage backend must implement — the abstraction that
 * eventually lets upload/playback/delete code stop caring which provider
 * a given object lives in, instead of an `if (provider === 'r2')` branch
 * copy-pasted into every call site. See firebaseProvider.ts for the only
 * fully-wired implementation today (profile photo — matching Step 5A's
 * own narrow scope), and r2Provider.ts for the real R2 implementation of
 * that same one media kind.
 *
 * `upload` takes a MEDIA KIND + uid, not a pre-decided path — this is a
 * deliberate change from Step 4's first draft of this interface (which
 * assumed the caller already knew the path upfront, matching how
 * Firebase Storage Rules let a client compute its own deterministic path
 * client-side). That assumption doesn't hold for R2's real presigned-URL
 * flow: the SERVER decides the object key (see
 * requestMediaUploadAuthorization.ts), and the client only finds out
 * what it is from the authorization response. Describing the upload by
 * intent ("a profile photo, for this uid") rather than by a path the
 * caller invented is what lets both providers implement the exact same
 * method honestly. Safe to change now — Step 4 shipped zero real callers
 * of this interface, so there was no working behavior to preserve.
 */
export interface MediaStorageProvider {
  readonly provider: MediaProvider;
  upload(request: MediaUploadRequest): Promise<MediaUploadResult>;
  /** Resolves a playable/renderable URL for an already-uploaded object at `path` — `null` when it can't be resolved (matches resolveReelPlaybackUrl's own "null on failure, never throws" contract in reels.ts). */
  resolveUrl(path: string): Promise<string | null>;
  /** Deletes the object at `path`. Never throws for an already-missing object. */
  delete(path: string): Promise<void>;
}
