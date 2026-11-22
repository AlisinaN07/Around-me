/**
 * Step 9A — a narrow, trusted callable that lets the CALLING user's own
 * client ask the server to delete whichever of their still-uploading
 * Reel's own R2 objects (video source and/or thumbnail) actually exist,
 * as part of discarding that draft. See src/services/reels.ts's own
 * discardReelDraft — the ONLY caller — for why this exists at all:
 * unlike a Firebase Storage object (which the CLIENT's own Firebase Auth
 * identity can delete directly, under storage.rules' own "still
 * uploading, own author" check), an R2 object has no equivalent
 * client-reachable delete path — R2 credentials never leave this backend
 * (see r2Config.ts's own doc comment) — so discarding an R2-backed draft
 * needs its own trusted, server-authorized delete, mirroring exactly the
 * same ownership/status verification requestMediaUploadAuthorization.ts
 * already performs before ever creating a presigned UPLOAD url.
 *
 * Deliberately narrower than a generic "delete this R2 key" primitive:
 * the client sends only `reelId`, never a path/key/bucket — every object
 * key this function might delete is derived here, server-side, from
 * `request.auth.uid` and the validated `reelId`, using the exact same
 * reelSourceKey/reelThumbnailKey builders requestMediaUploadAuthorization
 * uses to CREATE those same objects. A client can never use this to
 * delete an arbitrary R2 object, its own or anyone else's.
 *
 * Only ever permitted while `status === 'uploading'` — the same
 * constraint storage.rules' own Reel-source `allow delete` already
 * enforces for the Firebase side of discardReelDraft, and the same
 * reason: once a Reel is published, there is no client-triggered media
 * deletion at all (see deleteMyReel in functions/src/index.ts for the
 * one, separate, fully-server-driven path that removes a PUBLISHED
 * Reel's media, including its own R2-aware branch).
 *
 * Best-effort per object: a missing/already-deleted object, or one whose
 * provider was never actually 'r2', is simply skipped — this function
 * never throws just because there was nothing to clean up.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { isSafePathSegment } from './objectKey';
import { performReelSourceDiscardCleanup } from './reelDiscardCleanup';
import { checkReelDiscardEligibility, type RawReelData } from './reelEligibility';

const REGION = 'europe-north1';

const r2AccessKeyIdSecret = defineSecret('R2_ACCESS_KEY_ID');
const r2SecretAccessKeySecret = defineSecret('R2_SECRET_ACCESS_KEY');

type DiscardReelSourceResult = {
  reelId: string;
  /** Whether an R2 delete was actually attempted for the video source (i.e. the Reel's own storageProvider was 'r2' at the time this ran) — not a guarantee the object previously existed, only that a delete call was made. */
  videoAttempted: boolean;
  /** Same meaning as videoAttempted, for the Reel's own thumbnail. */
  thumbnailAttempted: boolean;
  /** Step 10B — same meaning as videoAttempted, for the Reel's own standalone music object. */
  musicAttempted: boolean;
};

export async function handleDiscardReelSourceRequest(request: CallableRequest<unknown>): Promise<DiscardReelSourceResult> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const data = request.data as Record<string, unknown> | null;
  const reelId = data && typeof data.reelId === 'string' ? data.reelId : undefined;
  if (!reelId || !isSafePathSegment(reelId)) {
    throw new HttpsError('invalid-argument', 'A valid reelId is required.');
  }

  const uid = request.auth.uid;
  const snapshot = await getFirestore().collection('reels').doc(reelId).get();
  const reel = snapshot.exists ? (snapshot.data() as RawReelData) : null;
  const eligibility = checkReelDiscardEligibility(reel, uid);
  if (!eligibility.ok) {
    throw new HttpsError(eligibility.code, eligibility.message);
  }

  // eligibility.ok guarantees `reel` is non-null (checkReelDiscardEligibility's
  // only ok:true path requires it).
  const { videoAttempted, thumbnailAttempted, musicAttempted } = await performReelSourceDiscardCleanup(reel as RawReelData, uid, reelId);

  return { reelId, videoAttempted, thumbnailAttempted, musicAttempted };
}

export const discardReelSource = onCall(
  { region: REGION, secrets: [r2AccessKeyIdSecret, r2SecretAccessKeySecret] },
  handleDiscardReelSourceRequest
);
