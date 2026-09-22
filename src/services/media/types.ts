/**
 * Storage-provider-neutral media types — Step 4's foundation for
 * eventually supporting both Firebase Storage and Cloudflare R2 without
 * duplicating `if (provider === 'r2') ... else ...` branches across
 * every upload/playback/delete call site. See this directory's own
 * index.ts doc comment for the full picture.
 *
 * NOTHING in this module is wired into production yet — existing Reel/
 * Story/profile/event upload and playback code in reels.ts/stories.ts/
 * userProfile.ts/content.ts is completely untouched and keeps talking to
 * Firebase Storage directly, exactly as before this directory existed.
 */

/** Every storage backend Around Me can eventually keep media in. 'firebase' is — and must remain, until a real migration step says otherwise — the only provider anything actually uses today. */
export type MediaProvider = 'firebase' | 'r2';

/**
 * Every kind of media Around Me's storage-provider abstraction knows how
 * to upload. 'profilePhoto' (Step 5A) and 'profileCover' (Step 5C) are
 * the only kinds wired up end-to-end (see
 * functions/src/media/requestMediaUploadAuthorization.ts and provider.ts's
 * own MediaStorageProvider) — Reel, Story, and Event media all still
 * upload through their own existing, untouched Firebase-direct code in
 * reels.ts/stories.ts/content.ts, not through this abstraction at all
 * yet.
 */
export type MediaKind = 'profilePhoto' | 'profileCover';

/**
 * A storage-neutral pointer to one media object — the shape a Firestore
 * document could eventually store instead of (or alongside) a bare
 * `storagePath` string, so a client reading it back can tell whether to
 * resolve the URL via Firebase's `getDownloadURL` or via R2/a CDN,
 * without ever guessing from the URL's own shape.
 *
 * Deliberately NOT added to Reel/Story/UserProfile/Content's own
 * Firestore TypeScript types (or to firestore.rules) in this step —
 * doing that for real would mean touching firestore.rules'
 * reelBaseKeys()/isValidReelCreate (even just to permissively allow an
 * unused optional field) for zero present benefit, since nothing writes
 * this field yet. This type exists purely so the SHAPE is decided and
 * ready the moment a future step actually starts writing it — see
 * interpretMediaProvider below for the exact backward-compatible
 * defaulting rule that step would rely on.
 */
export type MediaReference = {
  /** Which backend this object lives in. */
  provider: MediaProvider;
  /** The existing, already-proven `storagePath` convention (e.g. `reels/{uid}/{reelId}/source`) — unchanged regardless of provider, so moving a NEW upload to R2 never means inventing a new logical path shape. See functions/src/media/objectKey.ts for the server-side mirror of this exact same convention. */
  path: string;
};

/**
 * Interprets an OPTIONAL, not-yet-existing `mediaProvider`-shaped field a
 * Firestore document might carry once a future step actually starts
 * writing one — defaults to 'firebase' for every document that doesn't
 * have it, which is every real document today. Accepts a loosely-typed
 * record rather than a real Reel/Story type specifically so it imposes
 * zero schema requirement on any existing type right now, while still
 * giving a future migration a single, tested place to decide "old
 * Firebase media needs no backfill, it just reads as 'firebase'".
 */
export function interpretMediaProvider(doc: { mediaProvider?: unknown }): MediaProvider {
  return doc.mediaProvider === 'r2' ? 'r2' : 'firebase';
}

/**
 * What a trusted backend would hand the client to perform ONE upload,
 * regardless of provider — the shape a future `requestMediaUploadAuthorization`-
 * style Cloud Functions callable would return. Not implemented or called
 * anywhere yet: Firebase uploads today still go straight from the client
 * to Firebase Storage under its own declarative Storage Rules, with no
 * such round-trip. Documented here so the eventual presigned-URL flow
 * (Cloudflare's own recommended R2 upload pattern — see the Step 4
 * report's own "H. Proposed direct-upload flow") has a concrete target
 * shape to implement against later.
 */
export type MediaUploadAuthorization = {
  provider: MediaProvider;
  /** The exact object key/path this authorization is scoped to — never a wildcard, never chosen by the client (see functions/src/media/objectKey.ts). */
  path: string;
  /** For 'r2': a short-lived presigned PUT URL. Absent for 'firebase' — the client already has everything it needs via Storage Rules, no backend round-trip required. */
  uploadUrl?: string;
  /** The exact Content-Type the upload must use — enforced server-side when the authorization is generated; a presigned URL binds to one specific header value. */
  contentType: string;
  /** Unix ms — when this authorization stops being valid. Absent for 'firebase'. */
  expiresAt?: number;
};
