/**
 * Step 10A — a narrow, trusted callable that lets the CALLING user's own
 * client ask the server to delete their own Story's R2 media object, if
 * one exists. Mirrors discardReelSource.ts's own reasoning exactly: an R2
 * object has no client-reachable delete path (R2 credentials never leave
 * this backend — see r2Config.ts's own doc comment), so an R2-backed
 * Story's media needs its own trusted, server-authorized delete.
 *
 * Unlike discardReelSource (which only ever fires while a Reel is still
 * "uploading"), this has NO status constraint at all — see
 * checkStoryDeleteEligibility's own doc comment (storyEligibility.ts) for
 * why: a Story's own client-side deleteMyStory/discardStoryDraft already
 * work at ANY status, matching storage.rules' own Story `allow delete`
 * condition. The SAME callable backs both src/services/stories.ts's
 * discardStoryDraft (a cancelled/failed upload) and deleteMyStory (the
 * author's own early "delete my Story") — there is only ONE physical
 * object a Story ever owns (its own `source`, see storySourceKey), so
 * there is no thumbnail/music analog to also clean up here, unlike a
 * Reel.
 *
 * Deliberately narrower than a generic "delete this R2 key" primitive:
 * the client sends only `storyId`, never a path/key/bucket — the object
 * key is always derived here, server-side, from `request.auth.uid` and
 * the validated `storyId`, via the exact same storySourceKey builder
 * requestMediaUploadAuthorization.ts uses to CREATE that same object. A
 * client can never use this to delete an arbitrary R2 object, its own or
 * anyone else's.
 *
 * Best-effort: a missing/already-deleted object, or a Story whose
 * provider was never actually 'r2', is simply skipped — this function
 * never throws just because there was nothing to clean up.
 */
import { getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';

import { isSafePathSegment, storySourceKey } from './objectKey';
import { deleteReelSourceMedia } from './reelSourceStorage';
import { checkStoryDeleteEligibility, type RawStoryData } from './storyEligibility';

const REGION = 'europe-north1';

const r2AccessKeyIdSecret = defineSecret('R2_ACCESS_KEY_ID');
const r2SecretAccessKeySecret = defineSecret('R2_SECRET_ACCESS_KEY');

type DeleteStoryMediaResult = {
  storyId: string;
  /** Whether an R2 delete was actually attempted (i.e. the Story's own storageProvider was 'r2' at the time this ran) — not a guarantee the object previously existed, only that a delete call was made. */
  mediaAttempted: boolean;
};

export async function handleDeleteStoryMediaRequest(request: CallableRequest<unknown>): Promise<DeleteStoryMediaResult> {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const data = request.data as Record<string, unknown> | null;
  const storyId = data && typeof data.storyId === 'string' ? data.storyId : undefined;
  if (!storyId || !isSafePathSegment(storyId)) {
    throw new HttpsError('invalid-argument', 'A valid storyId is required.');
  }

  const uid = request.auth.uid;
  const snapshot = await getFirestore().collection('stories').doc(storyId).get();
  const story = snapshot.exists ? (snapshot.data() as RawStoryData) : null;
  const eligibility = checkStoryDeleteEligibility(story, uid);
  if (!eligibility.ok) {
    throw new HttpsError(eligibility.code, eligibility.message);
  }

  // eligibility.ok guarantees `story` is non-null.
  const storyData = story as RawStoryData;
  const mediaAttempted = storyData.storageProvider === 'r2';
  if (mediaAttempted) {
    // Reused directly from reelSourceStorage.ts — this function is fully
    // generic over bucket/path/provider, with no Reel-specific logic at
    // all (see its own doc comment). Deriving the key here from the
    // trusted `uid`/`storyId` via storySourceKey, rather than trusting
    // the document's own `storagePath` field — same defense-in-depth
    // convention Step 9D's own cleanupReelOwnedMedia established for a
    // Reel's thumbnail/music keys. The Firebase branch is unreachable
    // here (storageProvider is already confirmed 'r2' above), so the
    // real bucket is passed only to satisfy the shared function's own
    // signature, never actually touched.
    await deleteReelSourceMedia(getStorage().bucket(), storySourceKey(uid, storyId), 'r2');
  }

  return { storyId, mediaAttempted };
}

export const deleteStoryMedia = onCall(
  { region: REGION, secrets: [r2AccessKeyIdSecret, r2SecretAccessKeySecret] },
  handleDeleteStoryMediaRequest
);
