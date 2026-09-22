/**
 * Step 5A — the first real, production-reachable R2 entry point. A
 * trusted callable that hands the mobile client a short-lived, narrowly
 * scoped presigned R2 upload URL — never R2 credentials themselves (see
 * r2Config.ts's own doc comment on why those never leave this backend).
 *
 * Deliberately narrow: Step 5A supports ONLY `mediaKind: 'profilePhoto'`
 * for the CALLING user's own uid — no client-supplied uid, no
 * client-supplied path, no other media kind. Extending this to Reels/
 * Stories/Events/profile covers is explicit future work (see the Step 5A
 * report's own "Exact recommendation for Step 5B"), not something this
 * file's own shape should be stretched to cover prematurely.
 *
 * Unlike r2Storage.ts/r2Config.ts (deliberately NOT exported from
 * functions/src/index.ts — see r2Storage.ts's own doc comment), THIS
 * file's export IS added to index.ts, on purpose: it's the one, narrow,
 * validated, secret-bound production entry point Step 5A exists to
 * build. Nothing about this weakens Step 4's "R2 client code has zero
 * deployment footprint" property for the parts that still don't need
 * one (bulk delete, existence checks, arbitrary keys) — those remain
 * unreachable from any deployed function.
 *
 * Input validation itself lives in the separate, dependency-free
 * mediaUploadValidation.ts (see that file's own doc comment for why —
 * this file's own firebase-functions import chain isn't safely
 * `require()`-able under this project's plain-Node test runner).
 */
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { MediaUploadValidationError, validateMediaUploadInput, type AllowedMediaKind } from './mediaUploadValidation';
import { buildProfilePhotoMediaUrl } from './mediaUrl';
import { profilePhotoKey } from './objectKey';
import { getR2Config } from './r2Config';
import { createPresignedUploadUrl } from './r2Storage';

const REGION = 'europe-north1';

// Step: Firebase Secret Manager binding — listing these in `secrets:
// [...]` below is what actually makes `process.env.R2_ACCESS_KEY_ID`/
// `process.env.R2_SECRET_ACCESS_KEY` populated for THIS function's
// execution environment. A secret existing in Secret Manager (as these
// two already do, per Step 5A's own setup) does NOT automatically reach
// every function — each callable/trigger that needs one must list it
// here explicitly. r2Config.ts itself still just reads plain
// `process.env.R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY` — Cloud
// Functions v2 exposes a bound secret to the running function as a
// normal environment variable regardless of this binding step, so
// nothing in r2Config.ts/r2Storage.ts needed to change for this to work.
const r2AccessKeyIdSecret = defineSecret('R2_ACCESS_KEY_ID');
const r2SecretAccessKeySecret = defineSecret('R2_SECRET_ACCESS_KEY');

type RequestMediaUploadAuthorizationInput = {
  mediaKind: AllowedMediaKind;
  contentType: string;
  /** The exact byte length the client intends to upload — bound into the presigned URL's own signature (see r2Storage.ts's createPresignedUploadUrl), so the actual PUT must match this exactly or R2 itself rejects it. Required, not optional, precisely so that binding is always applied. */
  fileSizeBytes: number;
};

/** Safe, minimal client-facing result — see src/services/media/types.ts's MediaUploadAuthorization, which this shape matches. Never includes an access key, secret key, or any other R2 credential. */
type RequestMediaUploadAuthorizationResult = {
  provider: 'r2';
  path: string;
  uploadUrl: string;
  contentType: string;
  /** Unix ms. */
  expiresAt: number;
  /**
   * Step 5B — the stable, cache-busted, PUBLIC delivery URL this object
   * will be reachable at once the upload succeeds — `null` when
   * `R2_PUBLIC_MEDIA_BASE_URL` isn't configured yet (see r2Config.ts).
   * Computed HERE, server-side, from the server's own config — this is
   * the ONE source of truth for R2 URL construction; the client never
   * needs its own copy of the media base URL (no
   * EXPO_PUBLIC_R2_MEDIA_BASE_URL exists anywhere in this app — see the
   * Step 5B report's own "Configuration" section for why). The client
   * must never fabricate this URL itself or mark an upload as
   * display-ready when this is `null` — see
   * src/services/media/r2Provider.ts's own uploadProfilePhotoToR2.
   *
   * Deliberately returned at AUTHORIZATION time, before the upload has
   * actually happened — safe because the object's path is already fully
   * deterministic (profilePhotoKey(uid)) and the version token below is
   * generated fresh for this exact request, so the URL this response
   * predicts is exactly the URL the object will be reachable at the
   * moment the client's own PUT succeeds.
   */
  mediaUrl: string | null;
};

/**
 * The actual handler, exported separately from the `onCall(...)`-wrapped
 * value below specifically so it's directly callable with a fabricated
 * `CallableRequest`-shaped object in a test — without needing a live
 * Firebase emulator (though see this file's own top doc comment: even
 * this exported handler still can't be `require()`'d standalone under
 * this project's plain-Node test runner, since importing it pulls in
 * `firebase-functions/v2/https` regardless — that's exactly why
 * validateMediaUploadInput/mediaUploadValidation.ts is the piece that IS
 * unit-tested directly, and this handler's own auth/secrets/expiry
 * behavior is verified by direct code review instead — see the Step 5A
 * report's own "Tests/checks performed").
 *
 * `request.auth.uid` is the ONLY thing this function ever reads to
 * decide WHOSE object it's authorizing — `request.data` is never
 * consulted for identity, only for mediaKind/contentType/fileSizeBytes,
 * so a malicious extra `uid`/`path` field in the payload has no code
 * path that could ever read it.
 */
export async function handleRequest(request: CallableRequest<unknown>): Promise<RequestMediaUploadAuthorizationResult> {
  // Require authenticated Firebase user.
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  let input;
  try {
    input = validateMediaUploadInput(request.data);
  } catch (error) {
    if (error instanceof MediaUploadValidationError) {
      throw new HttpsError('invalid-argument', error.message);
    }
    throw error;
  }

  // Server-derived, deterministic, and bound to the CALLER's own uid —
  // exactly src/services/userProfile.ts's existing
  // `profilePhotos/{uid}/photo` Firebase Storage convention (see
  // objectKey.ts's own doc comment), so a future read/delivery step can
  // map straight back to the same logical object identity regardless of
  // which backend actually holds it.
  const path = profilePhotoKey(request.auth.uid);

  try {
    const { uploadUrl, expiresAt } = await createPresignedUploadUrl(path, input.contentType, input.fileSizeBytes);

    // Step 5B — cache-busting: a fresh version token per authorization
    // request, folded into the delivery URL's own query string (see
    // mediaUrl.ts's own doc comment for the full reasoning). The
    // underlying R2 object key is untouched — still the exact same
    // `profilePhotos/{uid}/photo` every time, overwritten in place.
    const publicMediaBaseUrl = getR2Config()?.publicMediaBaseUrl ?? null;
    const mediaUrl = publicMediaBaseUrl ? buildProfilePhotoMediaUrl(publicMediaBaseUrl, path, Date.now()) : null;

    return { provider: 'r2', path, uploadUrl, contentType: input.contentType, expiresAt, mediaUrl };
  } catch {
    // Covers "R2 isn't configured yet" (see r2Config.ts) and any real
    // R2/network failure alike — the client only ever needs to know the
    // upload couldn't be authorized right now, never the internal
    // reason, matching this codebase's own error-handling convention
    // elsewhere (e.g. muxReelMusic's own try/catch in index.ts).
    throw new HttpsError('internal', "Couldn't prepare this upload right now.");
  }
}

export const requestMediaUploadAuthorization = onCall({ region: REGION, secrets: [r2AccessKeyIdSecret, r2SecretAccessKeySecret] }, handleRequest);

export type { RequestMediaUploadAuthorizationInput, RequestMediaUploadAuthorizationResult };
