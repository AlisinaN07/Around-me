import type { MediaStorageProvider } from './provider';

const NOT_IMPLEMENTED_MESSAGE =
  'The R2 media provider is not implemented yet — Step 4 built only the storage-provider foundation/abstraction (see the Step 4 report). Nothing in this app should ever construct or call through this provider today.';

/**
 * Placeholder R2 implementation — every method throws immediately rather
 * than silently doing nothing, or (far worse) trying to reach a real R2
 * bucket with credentials the mobile client must never hold in the first
 * place (see functions/src/media/r2Config.ts's own doc comment on why
 * R2 access keys are server-side-only). Safe to import — this file never
 * touches the network or reads any credential at import time. Unsafe to
 * actually CALL, which is exactly right, since nothing in production
 * does; getMediaStorageProvider() (./config.ts) defaults to 'firebase'
 * and only a future, explicit step would ever route real calls here.
 *
 * When Step 5 begins the real migration, these method bodies get
 * replaced with calls to a trusted backend (a Cloud Functions callable
 * requesting a short-lived presigned upload URL from
 * functions/src/media/r2Storage.ts) — never with direct R2 credentials
 * embedded in this file or anywhere else in the mobile client.
 */
export const r2MediaProvider: MediaStorageProvider = {
  provider: 'r2',

  async upload(): Promise<never> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  },

  async resolveUrl(): Promise<never> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  },

  async delete(): Promise<never> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  },
};
