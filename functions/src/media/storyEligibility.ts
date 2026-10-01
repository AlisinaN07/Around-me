/**
 * Step 10A — pure, dependency-free eligibility checks for the two
 * Story-media operations that need a real Firestore ownership/status
 * read before they can proceed: authorizing an R2 Story-media upload,
 * and deleting a Story's own media (covers BOTH the client's "discard
 * this failed/cancelled draft" and "delete my published Story" flows —
 * see checkStoryDeleteEligibility's own doc comment for why those two
 * share one, looser check, unlike Reel's two-tier discard/publish
 * model). Deliberately its own file with ZERO firebase-functions/
 * firebase-admin import — same reasoning as reelEligibility.ts/
 * mediaUploadValidation.ts: the real Firestore READ can only happen in a
 * real callable (requestMediaUploadAuthorization.ts, deleteStoryMedia),
 * but the DECISION logic is pure, synchronous, and directly testable.
 *
 * Each function returns a plain `EligibilityResult` rather than throwing
 * — the caller is responsible for translating a `{ok:false}` result into
 * a real HttpsError with the matching `code`. Mirrors reelEligibility.ts's
 * own EligibilityResult shape exactly (not imported from there — this
 * file stays self-contained, same "no cross-file coupling between two
 * genuinely separate media families" reasoning Story/Reel already keep
 * at the Firestore-rules and Storage-rules level).
 */
import { ALLOWED_REEL_PHOTO_CONTENT_TYPES, ALLOWED_VIDEO_CONTENT_TYPES } from './mediaUploadValidation';

export type StoryEligibilityErrorCode = 'not-found' | 'permission-denied' | 'failed-precondition';

export type EligibilityResult = { ok: true } | { ok: false; code: StoryEligibilityErrorCode; message: string };

/** The untyped Firestore document shape every check here reads from — deliberately loose (`Record<string, unknown>`), matching how `snapshot.data()` actually comes back from the Admin SDK. */
export type RawStoryData = Record<string, unknown>;

function notFound(message = 'This Story could not be found.'): EligibilityResult {
  return { ok: false, code: 'not-found', message };
}
function permissionDenied(message: string): EligibilityResult {
  return { ok: false, code: 'permission-denied', message };
}
function failedPrecondition(message: string): EligibilityResult {
  return { ok: false, code: 'failed-precondition', message };
}
const OK: EligibilityResult = { ok: true };

/**
 * requestMediaUploadAuthorization.ts's own gate for `mediaKind:
 * 'storyMedia'`:
 *  1. The Story document exists at all (a made-up/foreign storyId is
 *     rejected, not silently authorized against a path that happens to
 *     parse).
 *  2. `authorUid === uid` — never authorize a media upload into another
 *     user's Story, no matter what storyId is passed.
 *  3. `status === 'uploading'` — mirrors firestore.rules' own
 *     isValidStoryProviderUpdate (the follow-up confirm-write this
 *     authorizes): a published Story can never have its media
 *     re-authorized/replaced.
 *  4. `contentType` must match what THIS Story is actually expecting —
 *     an image type (ALLOWED_REEL_PHOTO_CONTENT_TYPES — reused directly,
 *     not duplicated: see mediaUploadValidation.ts's own 'storyMedia'
 *     doc comment for why a Story's real MIME universe is provably
 *     identical to a Reel's) when `mediaType === 'photo'`, or a video
 *     type (ALLOWED_VIDEO_CONTENT_TYPES) when `mediaType === 'video'`.
 *     This is the one check in this file that reads BOTH the Story's own
 *     state AND the request's own declared content type together —
 *     mediaUploadValidation.ts's own pure shape check (run earlier, with
 *     no Firestore access) can only confirm SOME allowed shape was sent,
 *     never that it's the RIGHT one for this exact Story.
 */
export function checkStoryMediaEligibility(story: RawStoryData | null, uid: string, contentType: string): EligibilityResult {
  if (!story) return notFound();
  if (story.authorUid !== uid) return permissionDenied('You do not own this Story.');
  if (story.status !== 'uploading') return failedPrecondition('This Story is not awaiting a media upload.');
  const contentTypeMatches = story.mediaType === 'photo' ? ALLOWED_REEL_PHOTO_CONTENT_TYPES.has(contentType) : ALLOWED_VIDEO_CONTENT_TYPES.has(contentType);
  if (!contentTypeMatches) {
    return failedPrecondition('This file type does not match what this Story is expecting.');
  }
  return OK;
}

/**
 * deleteStoryMedia.ts's own eligibility check — deliberately LOOSER than
 * checkStoryMediaEligibility above: no status constraint at all. Unlike a
 * Reel (whose discard-a-draft and delete-a-published-post are two
 * genuinely different operations with different allowed-field sets), a
 * Story's own client-side deleteMyStory already works at ANY status —
 * "uploading" (an abandoned/cancelled upload) or "published" (the
 * author's own early "delete my Story") — see storage.rules' own Story
 * `allow delete` condition and deleteMyStory's own doc comment in
 * src/services/stories.ts, neither of which gates on status either. This
 * one function backs BOTH discardStoryDraft's and deleteMyStory's own R2
 * cleanup call, matching that existing, simpler Story lifecycle exactly
 * rather than inventing a two-tier model Stories never actually had.
 */
export function checkStoryDeleteEligibility(story: RawStoryData | null, uid: string): EligibilityResult {
  if (!story) return notFound();
  if (story.authorUid !== uid) return permissionDenied('You do not own this Story.');
  return OK;
}
