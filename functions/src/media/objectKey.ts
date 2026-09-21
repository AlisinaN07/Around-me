/**
 * Pure, dependency-free object-key helpers — deliberately mirrors the
 * EXACT deterministic path convention the client already uses
 * (src/services/reels.ts's reelStoragePath/reelMusicStoragePath/
 * reelThumbnailStoragePath, src/services/stories.ts's storyStoragePath,
 * and the literal profilePhotos/{uid}/photo, profileCovers/{uid}/photo,
 * eventCovers/{uid}/{draftId}/photo, soundOrigins/{hash}/audio paths
 * used in userProfile.ts/content.ts/index.ts) so moving a given object
 * between Firebase Storage and R2 never means inventing a new logical
 * path shape — only the BACKEND holding that same key changes.
 *
 * Kept free of any AWS/Firebase SDK import (same "pure logic, own file"
 * split this codebase already uses everywhere else — see
 * src/services/recommendations/tierCollection.ts's own doc comment) so
 * it's directly unit-testable — see
 * functions/scripts/test-media-key-logic.cjs — without needing real R2
 * credentials or a network connection.
 */

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Rejects anything that isn't a plain, single path segment — no `/`, no
 * `..`, no leading dot, no empty string, no whitespace. This is what
 * stops a malformed or hostile uid/reelId/storyId/draftId from ever
 * being able to escape its own prefix (e.g. `../other-uid/x`) or inject
 * an extra path level into an object key. Every ID this app actually
 * generates (a Firebase Auth uid, a Firestore auto-ID, a SHA-256 hex
 * hash) is already exactly this shape — this only guards against a
 * caller passing something it shouldn't, the same defense-in-depth
 * reasoning firestore.rules already applies to these same values on the
 * Firebase Storage side (see storage.rules' own deterministic-path
 * checks).
 */
export function isSafePathSegment(segment: string): boolean {
  return typeof segment === 'string' && SAFE_SEGMENT.test(segment);
}

/** Throws with the exact offending segment named, rather than a generic "invalid key" — makes a bad caller easy to find in logs. */
function buildKey(...segments: string[]): string {
  for (const segment of segments) {
    if (!isSafePathSegment(segment)) {
      throw new Error(`Invalid object key segment: ${JSON.stringify(segment)}`);
    }
  }
  return segments.join('/');
}

export function reelSourceKey(uid: string, reelId: string): string {
  return buildKey('reels', uid, reelId, 'source');
}
export function reelThumbnailKey(uid: string, reelId: string): string {
  return buildKey('reels', uid, reelId, 'thumbnail');
}
export function reelMusicKey(uid: string, reelId: string): string {
  return buildKey('reels', uid, reelId, 'music');
}
export function storySourceKey(uid: string, storyId: string): string {
  return buildKey('stories', uid, storyId, 'source');
}
export function profilePhotoKey(uid: string): string {
  return buildKey('profilePhotos', uid, 'photo');
}
export function profileCoverKey(uid: string): string {
  return buildKey('profileCovers', uid, 'photo');
}
export function eventCoverKey(uid: string, draftId: string): string {
  return buildKey('eventCovers', uid, draftId, 'photo');
}
export function soundOriginKey(musicHash: string): string {
  return buildKey('soundOrigins', musicHash, 'audio');
}
