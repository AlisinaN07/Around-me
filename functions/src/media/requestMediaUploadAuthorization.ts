/**
 * Step 5A — the first real, production-reachable R2 entry point. A
 * trusted callable that hands the mobile client a short-lived, narrowly
 * scoped presigned R2 upload URL — never R2 credentials themselves (see
 * r2Config.ts's own doc comment on why those never leave this backend).
 *
 * Deliberately narrow: supports ONLY `mediaKind: 'profilePhoto'` (Step
 * 5A), `'profileCover'` (Step 5C), `'eventCover'` (Step 5D), and
 * `'reelThumbnail'` (Step 5E) for the CALLING user's own uid — no
 * client-supplied uid, no other media kind. In particular this never
 * authorizes a Reel's own video/audio, or any Story — extending this
 * further is explicit future work, not something this file's own shape
 * should be stretched to cover prematurely.
 *
 * `eventCover` is the one media kind that accepts a client-supplied,
 * NOT independently ownership-checked identifier (`draftId`) — see
 * RequestMediaUploadAuthorizationInput's own doc comment on that field
 * for exactly why, and mediaUploadValidation.ts for how it's validated
 * as a safe path segment before ever reaching objectKey.ts's
 * eventCoverKey. `reelThumbnail`'s `reelId` looks similar on the
 * surface but is different in kind: it identifies a REAL, pre-existing
 * Firestore document, so this file additionally verifies real ownership
 * of it server-side — see verifyReelThumbnailOwnership below.
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
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { MediaUploadValidationError, validateMediaUploadInput, type AllowedMediaKind } from './mediaUploadValidation';
import { buildMediaUrl } from './mediaUrl';
import { eventCoverKey, profileCoverKey, profilePhotoKey, reelThumbnailKey } from './objectKey';
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
  /**
   * Required for, and used ONLY by, `mediaKind: 'eventCover'`. Unlike
   * profile photo/cover — always exactly one deterministic object per
   * uid, needing no client input at all to identify — an Event's cover
   * is uploaded to a client-generated `draftId` slot (content.ts's
   * existing `generateEventDraftId()`) BEFORE the real Event document
   * exists, so there is nothing in Firestore yet to derive an identifier
   * from. This exactly preserves the current Firebase behavior: the
   * client already picks this identifier today (see
   * storage.rules' own `eventCovers/{authorUid}/{draftId}/photo` — the
   * SAME "any string, as long as it's under your own uid" trust model),
   * so accepting it here is not a NEW or weaker trust boundary, just the
   * same one carried over to R2. Validated as one safe path SEGMENT
   * (never a full path) in mediaUploadValidation.ts before ever reaching
   * objectKey.ts's eventCoverKey — a malformed value is rejected, not
   * silently accepted.
   */
  draftId?: string;
  /**
   * Required for, and used ONLY by, `mediaKind: 'reelThumbnail'`. Unlike
   * `draftId` above, this identifies a REAL, already-existing Firestore
   * `reels/{reelId}` document (src/services/reels.ts's createReelDraft
   * always runs before a thumbnail upload is ever attempted) — so unlike
   * eventCover, this callable does NOT just trust a client-supplied
   * segment at face value. See verifyReelThumbnailOwnership below: this
   * value is used to load that exact Reel server-side and confirm the
   * caller actually owns it and it's still awaiting its thumbnail,
   * BEFORE any presigned URL is ever created.
   */
  reelId?: string;
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
   * deterministic (profilePhotoKey(uid) or profileCoverKey(uid),
   * depending on mediaKind) and the version token below is generated
   * fresh for this exact request, so the URL this response predicts is
   * exactly the URL the object will be reachable at the moment the
   * client's own PUT succeeds.
   */
  mediaUrl: string | null;
};

/**
 * Reel thumbnails are the first media kind this callable authorizes for
 * an object that already has a REAL Firestore document behind it — so
 * unlike eventCover's bare "any string under your own uid" trust model,
 * this does an actual Firestore Admin SDK read to verify:
 *  1. The Reel document exists at all (a made-up/foreign reelId is
 *     rejected, not silently authorized against a path that happens to
 *     parse).
 *  2. `authorUid === request.auth.uid` — never authorize a thumbnail
 *     upload into another user's Reel, no matter what reelId is passed.
 *  3. `status === 'uploading'` — mirrors the one narrow window
 *     firestore.rules' own isValidReelThumbnailProviderUpdate will also
 *     require for the follow-up confirm-write (see reels.ts's
 *     confirmReelThumbnailProvider): a published or already-discarded
 *     Reel can never have its thumbnail re-authorized for upload.
 *  4. `mediaType === 'video'` — a photo Reel has no separate thumbnail
 *     object at all (its thumbnailStoragePath IS its own storagePath —
 *     see reels.ts's createReelDraft), so authorizing an R2 thumbnail
 *     upload for one would silently create an orphaned object nothing
 *     ever references, not migrate anything real.
 *
 * Throws a distinct HttpsError code per failure so legitimate client
 * bugs are debuggable, while still never leaking WHY a given reelId was
 * rejected beyond that top-level code (no Reel content/other fields are
 * ever included in an error message).
 */
async function verifyReelThumbnailOwnership(reelId: string, uid: string): Promise<void> {
  const snapshot = await getFirestore().collection('reels').doc(reelId).get();
  if (!snapshot.exists) {
    throw new HttpsError('not-found', 'This Reel could not be found.');
  }
  const reel = snapshot.data() as Record<string, unknown>;
  if (reel.authorUid !== uid) {
    throw new HttpsError('permission-denied', 'You do not own this Reel.');
  }
  if (reel.status !== 'uploading') {
    throw new HttpsError('failed-precondition', 'This Reel is not awaiting a thumbnail upload.');
  }
  if (reel.mediaType !== 'video') {
    throw new HttpsError('failed-precondition', 'This Reel does not use a separate thumbnail.');
  }
}

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

  // Server-derived and always bound to the CALLER's own uid — exactly
  // the existing Firebase Storage conventions in userProfile.ts/
  // content.ts (see objectKey.ts's own doc comment), so a future read/
  // delivery step can map straight back to the same logical object
  // identity regardless of which backend actually holds it. `eventCover`
  // is the one case that also incorporates a (separately validated)
  // client-supplied draftId — see this file's own doc comment on that
  // input field for why; the uid segment itself is still never anything
  // but `request.auth.uid`, so a caller can never write into another
  // user's eventCovers/ namespace no matter what draftId they pass.
  let path: string;
  if (input.mediaKind === 'eventCover') {
    // validateMediaUploadInput already guarantees `draftId` is present
    // and a safe path segment whenever mediaKind is 'eventCover' — this
    // non-null assertion reflects that already-checked invariant, not an
    // unchecked assumption.
    path = eventCoverKey(request.auth.uid, input.draftId!);
  } else if (input.mediaKind === 'reelThumbnail') {
    // validateMediaUploadInput already guarantees `reelId` is present and
    // a safe path segment — but that's only shape validation. The real
    // security property (this Reel belongs to the caller and is still
    // awaiting its thumbnail) is verified here, against Firestore, before
    // any presigned URL is ever created — see verifyReelThumbnailOwnership's
    // own doc comment above.
    await verifyReelThumbnailOwnership(input.reelId!, request.auth.uid);
    path = reelThumbnailKey(request.auth.uid, input.reelId!);
  } else if (input.mediaKind === 'profileCover') {
    path = profileCoverKey(request.auth.uid);
  } else {
    path = profilePhotoKey(request.auth.uid);
  }

  try {
    const { uploadUrl, expiresAt } = await createPresignedUploadUrl(path, input.contentType, input.fileSizeBytes);

    // Cache-busting: a fresh version token per authorization request,
    // folded into the delivery URL's own query string (see mediaUrl.ts's
    // own doc comment for the full reasoning). The underlying R2 object
    // key is untouched — still the exact same deterministic path every
    // time, overwritten in place.
    const publicMediaBaseUrl = getR2Config()?.publicMediaBaseUrl ?? null;
    const mediaUrl = publicMediaBaseUrl ? buildMediaUrl(publicMediaBaseUrl, path, Date.now()) : null;

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
