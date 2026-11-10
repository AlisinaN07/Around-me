/**
 * A narrow, trusted callable that lets the CALLING user's own client ask
 * the server to delete one of their own R2-backed profile-photo/
 * profile-cover objects. Mirrors discardReelSource.ts/deleteStoryMedia.ts's
 * own reasoning exactly: an R2 object has no client-reachable delete path
 * (R2 credentials never leave this backend — see r2Config.ts's own doc
 * comment), so an R2-backed object needs its own trusted,
 * server-authorized delete. This is the real implementation behind
 * src/services/media/r2Provider.ts's own `r2MediaProvider.delete` — which,
 * before this callable existed, unconditionally threw "not implemented."
 *
 * The client sends a `path` (matching the generic
 * `MediaStorageProvider.delete(path)` shape this callable backs), but that
 * path is NEVER trusted at face value: it is only ever honored when it
 * exactly matches one of the CALLER's own two deterministic keys —
 * `profilePhotoKey(uid)` / `profileCoverKey(uid)`, computed here from
 * `request.auth.uid` alone, never from anything in `request.data`. Any
 * other value — another user's path, a Reel/Story/Event object, a
 * made-up string — is rejected with `permission-denied` before any R2
 * call is ever made. A client can never use this to delete an arbitrary
 * R2 object, its own or anyone else's. (This is deliberately narrower
 * than the generic `MediaStorageProvider.upload` interface might suggest
 * is needed — `r2MediaProvider.upload` already only ever authorizes
 * these same two media kinds, see r2Provider.ts's own doc comment, so
 * this delete-side allowlist is not a new restriction, just the matching
 * one.)
 *
 * Best-effort: an already-missing object is a successful, idempotent
 * no-op (see r2Storage.ts's own deleteR2Object doc comment) — never an
 * error. A genuine R2 failure (not "already gone") IS reported to the
 * caller as a real error, rather than silently swallowed — unlike the
 * internal cleanup helpers this codebase uses during a larger deletion
 * flow (e.g. cleanupProfileOwnedMedia during account deletion), this
 * callable's entire purpose IS the delete, so its caller needs to know if
 * it didn't actually happen.
 */
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { checkDeleteOwnMediaEligibility } from './deleteOwnMediaEligibility';
import { deleteR2Object } from './r2Storage';

const REGION = 'europe-north1';

const r2AccessKeyIdSecret = defineSecret('R2_ACCESS_KEY_ID');
const r2SecretAccessKeySecret = defineSecret('R2_SECRET_ACCESS_KEY');

type DeleteOwnMediaResult = {
  path: string;
  attempted: boolean;
};

export async function handleDeleteOwnMediaRequest(request: CallableRequest<unknown>): Promise<DeleteOwnMediaResult> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const data = request.data as Record<string, unknown> | null;
  const path = data?.path;
  const uid = request.auth.uid;

  // The real decision — is this path one of the CALLER's own two
  // deterministic keys? — lives in the pure, directly-tested
  // checkDeleteOwnMediaEligibility (deleteOwnMediaEligibility.ts). This
  // function's own job is just the impure part: translating a
  // `{ok:false}` result into a real HttpsError.
  const eligibility = checkDeleteOwnMediaEligibility(uid, path);
  if (!eligibility.ok) {
    throw new HttpsError(eligibility.code, eligibility.message);
  }
  // eligibility.ok guarantees `path` is a string matching one of the
  // caller's own keys.
  const verifiedPath = path as string;

  try {
    await deleteR2Object(verifiedPath);
  } catch (error) {
    console.warn(`[deleteOwnMedia] Could not delete R2 object at "${verifiedPath}":`, error);
    throw new HttpsError('internal', "Couldn't delete this right now.");
  }

  return { path: verifiedPath, attempted: true };
}

export const deleteOwnMedia = onCall({ region: REGION, secrets: [r2AccessKeyIdSecret, r2SecretAccessKeySecret] }, handleDeleteOwnMediaRequest);
