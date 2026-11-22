/**
 * Pure, dependency-free eligibility check for deleteOwnMedia.ts — same
 * reasoning as reelEligibility.ts/storyEligibility.ts: the real Firestore-
 * free DECISION logic ("is this path one the caller is allowed to
 * delete?") has no reason to be untestable just because its only real
 * caller (a Cloud Functions callable) transitively imports
 * firebase-functions/v2/https, which cannot be `require()`'d under this
 * project's plain-Node test runner (see test-media-upload-auth-logic.cjs's
 * own doc comment for the confirmed reason).
 *
 * Deliberately narrow: this is NOT a general "is this a safe path" check
 * (objectKey.ts's isSafePathSegment already covers path-shape safety
 * elsewhere) — it is the specific allowlist that makes deleteOwnMedia
 * safe to expose to any signed-in client at all. A path is eligible if
 * and only if it is EXACTLY the caller's own profilePhotoKey(uid) or
 * profileCoverKey(uid) — nothing else, ever.
 */
import { profileCoverKey, profilePhotoKey } from './objectKey';

/** Mirrors the subset of `firebase-functions/v2/https`'s HttpsError codes this check ever produces — kept as a plain string union so this file needs no import from that package. */
export type DeleteOwnMediaErrorCode = 'invalid-argument' | 'permission-denied';

export type DeleteOwnMediaEligibilityResult = { ok: true } | { ok: false; code: DeleteOwnMediaErrorCode; message: string };

/**
 * `requestedPath` is deliberately typed `unknown` — it comes straight from
 * an untrusted `request.data` in the real callable, with no shape
 * guarantee at all.
 */
export function checkDeleteOwnMediaEligibility(uid: string, requestedPath: unknown): DeleteOwnMediaEligibilityResult {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    return { ok: false, code: 'invalid-argument', message: 'A valid path is required.' };
  }

  const allowedKeys: readonly string[] = [profilePhotoKey(uid), profileCoverKey(uid)];
  if (!allowedKeys.includes(requestedPath)) {
    return { ok: false, code: 'permission-denied', message: 'You can only delete your own profile media.' };
  }

  return { ok: true };
}
