/**
 * Step 9A/9B/9C — the pure, client-side mirror of the SAME eligibility
 * decision functions/src/media/reelEligibility.ts's
 * checkReelVideoEligibility makes server-side: given a Reel's
 * mediaType/musicSourceType/needsPhotoVideoRender, is its source allowed
 * to move to R2?
 *
 * Deliberately its own tiny, dependency-free file (no import from
 * reels.ts, no Firebase import) so reels.ts's own uploadReelVideo
 * dispatch guard can share this exact predicate with a direct unit test,
 * instead of the boolean expression only ever existing inline where it's
 * hard to exercise every branch of in isolation.
 *
 * This does NOT replace the server-side check — the server's own
 * verifyReelVideoOwnership (requestMediaUploadAuthorization.ts) is the
 * real security boundary and re-checks the exact same conditions (plus
 * ownership/status, which this client-side predicate has no way to know)
 * against the authoritative Firestore document before ever issuing a
 * presigned URL. This function only decides which LOCAL code path
 * uploadReelVideo takes for a Reel object the client already has in
 * hand — never used for any authorization decision itself.
 */

/** The only fields this decision ever reads — a structural subset of Reel, so a caller doesn't need a fully-populated Reel object just to check eligibility. */
export type ReelEligibilityShape = {
  mediaType: 'video' | 'photo' | string;
  musicSourceType: 'none' | 'device' | string;
  needsPhotoVideoRender: boolean;
};

/**
 * True for:
 *  - a plain `'photo'` Reel — always eligible; a photo Reel never has a
 *    pending render (see ReelMediaType's own doc comment in
 *    src/types/reel.ts) and this predicate doesn't otherwise care about
 *    music state for a photo (checkReelVideoEligibility's own
 *    server-side twin doesn't gate `musicSourceType` for photos either —
 *    see that function's doc comment).
 *  - a `'video'` Reel with a music state this codebase actually knows
 *    how to bring to R2 — Step 9A's original `'none'` (nothing to mux,
 *    immutable after upload), or Step 9B's `'device'` (device-picked
 *    music — muxReelMusic runs provider-aware, on either backend, before
 *    publish). `needsPhotoVideoRender` no longer excludes a video Reel
 *    as of Step 9C — renderPhotoToVideo is now provider-aware too (see
 *    checkReelVideoEligibility's own doc comment in
 *    functions/src/media/reelEligibility.ts for the full reasoning both
 *    sides of this predicate share).
 *
 * Deliberately an ALLOWLIST on `musicSourceType` for the video case, not
 * a blocklist — a hypothetical future music source type this app doesn't
 * support yet is rejected by default here too, matching the server's own
 * same defensive posture, rather than silently accepted just because it
 * isn't `'device'`.
 */
export function isReelEligibleForR2VideoUpload(reel: ReelEligibilityShape): boolean {
  if (reel.mediaType === 'photo') return true;
  return reel.mediaType === 'video' && (reel.musicSourceType === 'none' || reel.musicSourceType === 'device');
}
