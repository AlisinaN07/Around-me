/**
 * Step 9A — the pure, client-side mirror of the SAME eligibility decision
 * functions/src/media/reelEligibility.ts's checkReelVideoEligibility makes
 * server-side: given a Reel's mediaType/musicSourceType/
 * needsPhotoVideoRender, is its video source allowed to move to R2?
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
 * True ONLY for a plain video Reel with no music and no pending
 * photo-to-video render — the ONE variant Step 9A allows onto R2 (see
 * requestMediaUploadAuthorization.ts's own verifyReelVideoOwnership for
 * the full reasoning: a music-attached or render-pending Reel still
 * needs a trusted server-side rewrite of its own source, via
 * muxReelMusic/renderPhotoToVideo, both Firebase-Storage-only).
 */
export function isReelEligibleForR2VideoUpload(reel: ReelEligibilityShape): boolean {
  return reel.mediaType === 'video' && reel.musicSourceType === 'none' && !reel.needsPhotoVideoRender;
}
