/**
 * Pure helper deciding exactly which cover-related fields `createEvent`
 * (src/services/content.ts) should persist onto a new Event document.
 * Extracted into its own, dependency-free file — same reasoning as
 * eventHashtagsForScoring.ts/eventSectionHandoffKey.ts — so this decision
 * is directly unit-testable under plain tsx (content.ts itself can't be:
 * it transitively imports firebase.ts, which references the Expo-only
 * `__DEV__` global).
 *
 * Step 2B — `coverStoragePath` is deliberately NOT an input to this
 * function at all. It is always DERIVED, here, from `uid` + `contentId`
 * — the exact same `eventCovers/{uid}/{contentId}/photo` template both
 * the Firebase and R2 upload branches already use (see
 * uploadEventCoverPhoto/uploadEventCoverToR2) — never trusted as a
 * free-form string reported back by an upload step. This closes a real,
 * confirmed gap from the first version of this fix: accepting a
 * caller-reported `coverStoragePath` meant a client could claim ANY path
 * under its own `eventCovers/{uid}/` namespace, including one belonging
 * to a DIFFERENT, already-published Event of the same author's (same
 * user, so the old namespace-only check passed, but the object itself
 * belonged to another Event entirely). Deriving the path from `contentId`
 * — the Event's own real, final id, generated once and reused for both
 * the upload and the document itself (see generateEventId's own doc
 * comment in content.ts) — makes that confusion structurally impossible:
 * the derived path can only ever name THIS Event's own cover object.
 *
 * Firestore's own "absent key, not a blank value" convention
 * (EventContent.coverPhotoURL's own doc comment) is preserved exactly:
 * no cover at all -> no cover fields whatsoever; a cover with a known
 * provider -> all three fields together; a cover whose provider is for
 * some reason unknown (e.g. an older client build mid-rollout, before
 * this field existed) -> `coverPhotoURL` alone, NEVER a half-written
 * `coverStoragePath` without its matching `coverStorageProvider` or vice
 * versa — firestore.rules' own isValidEventShape independently enforces
 * this same pairing, so this is belt-and-suspenders, not the only guard.
 */
export type EventCoverStorageInput = {
  /** The authenticated author's own uid — never anyone else's; this is what the derived path is scoped under. */
  uid: string;
  /** This Event's own real, final contentId (see generateEventId's own doc comment) — the SAME id createEvent is about to create the document under. */
  contentId: string;
  coverPhotoURL?: string;
  coverStorageProvider?: 'firebase' | 'r2';
};

export type EventCoverStorageFields =
  | { coverPhotoURL: string; coverStoragePath: string; coverStorageProvider: 'firebase' | 'r2' }
  | { coverPhotoURL: string }
  | Record<string, never>;

export function resolveEventCoverStorageFields(input: EventCoverStorageInput): EventCoverStorageFields {
  if (!input.coverPhotoURL) return {};
  if (input.coverStorageProvider) {
    return {
      coverPhotoURL: input.coverPhotoURL,
      coverStoragePath: `eventCovers/${input.uid}/${input.contentId}/photo`,
      coverStorageProvider: input.coverStorageProvider,
    };
  }
  return { coverPhotoURL: input.coverPhotoURL };
}
