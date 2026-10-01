/**
 * Step 5A/5C/5D — plain-Node tests for the pure request-validation logic
 * behind requestMediaUploadAuthorization: functions/src/media/
 * mediaUploadValidation.ts's validateMediaUploadInput. Runs against the
 * COMPILED lib/ output — `npm run build` first (see the `test` script in
 * package.json).
 *
 * Deliberately does NOT import requestMediaUploadAuthorization.ts itself
 * (the real callable) or r2Storage.ts — both transitively pull in
 * firebase-functions/v2/https -> firebase-admin's auth module ->
 * jwks-rsa -> jose (a pure-ESM package), which fails to `require()`
 * under this project's plain-Node test runner (the SAME pre-existing
 * limitation test-collaborative-logic.cjs already documents for
 * collaborative.ts — confirmed empirically, not assumed). This is
 * exactly why the validation logic was extracted into its own,
 * dependency-free file in the first place — see that file's own doc
 * comment.
 *
 * The callable's own auth-required/secret-shape/expiry behavior (see the
 * Step 5A report's own "Tests/checks performed" for the full breakdown)
 * is verified by direct code review instead: handleRequest's very first
 * statement throws HttpsError('unauthenticated', ...) when
 * `!request.auth`; RequestMediaUploadAuthorizationResult's own type has
 * no field that could ever hold a credential (confirmed by `tsc
 * --noEmit` passing); PRESIGNED_UPLOAD_TTL_SECONDS (r2Storage.ts) is a
 * plain, directly-inspectable `5 * 60` literal.
 */
const assert = require('node:assert/strict');
const {
  validateMediaUploadInput,
  MediaUploadValidationError,
  ALLOWED_CONTENT_TYPES,
  ALLOWED_VIDEO_CONTENT_TYPES,
  ALLOWED_REEL_PHOTO_CONTENT_TYPES,
  PROFILE_PHOTO_MAX_SIZE_BYTES,
  PROFILE_COVER_PHOTO_MAX_SIZE_BYTES,
  EVENT_COVER_PHOTO_MAX_SIZE_BYTES,
  REEL_THUMBNAIL_MAX_SIZE_BYTES,
  REEL_VIDEO_MAX_SIZE_BYTES,
  REEL_PHOTO_SOURCE_MAX_SIZE_BYTES,
  REEL_MUSIC_MAX_SIZE_BYTES,
} = require('../lib/media/mediaUploadValidation.js');
const {
  eventCoverKey,
  profileCoverKey,
  profilePhotoKey,
  reelSourceKey,
  reelThumbnailKey,
  reelMusicKey,
  storySourceKey,
} = require('../lib/media/objectKey.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

// ---------------------------------------------------------------------------
// Arbitrary/malformed requests rejected.
// ---------------------------------------------------------------------------

check('rejects null', () => {
  assert.throws(() => validateMediaUploadInput(null), MediaUploadValidationError);
});

check('rejects a non-object', () => {
  assert.throws(() => validateMediaUploadInput('profilePhoto'), MediaUploadValidationError);
});

check('rejects an empty object', () => {
  assert.throws(() => validateMediaUploadInput({}), MediaUploadValidationError);
});

// ---------------------------------------------------------------------------
// mediaKind — only 'profilePhoto' is allowed in Step 5A. Arbitrary paths
// / other media kinds must be rejected outright (no arbitrary object key
// can ever be requested through this input).
// ---------------------------------------------------------------------------

check('rejects an unsupported/arbitrary mediaKind ("reel")', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reel', contentType: 'image/jpeg', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects an attempted arbitrary object path passed as mediaKind', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhotos/other-uid/photo', contentType: 'image/jpeg', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects a request with no mediaKind at all', () => {
  assert.throws(() => validateMediaUploadInput({ contentType: 'image/jpeg', fileSizeBytes: 1000 }), MediaUploadValidationError);
});

// ---------------------------------------------------------------------------
// Content type — only the app's actual supported image formats.
// ---------------------------------------------------------------------------

check('accepts image/jpeg (a supported profile-photo type)', () => {
  const result = validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: 1000 });
  assert.equal(result.contentType, 'image/jpeg');
});

check('accepts image/png', () => {
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/png', fileSizeBytes: 1000 }));
});

check('accepts image/webp', () => {
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/webp', fileSizeBytes: 1000 }));
});

check('rejects an unsupported image type (image/gif)', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/gif', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects a video/* content type', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'video/mp4', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects an application/* content type', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'application/octet-stream', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects a non-string content type', () => {
  assert.throws(() => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 123, fileSizeBytes: 1000 }), MediaUploadValidationError);
});

check('ALLOWED_CONTENT_TYPES contains exactly the three documented formats', () => {
  assert.deepEqual([...ALLOWED_CONTENT_TYPES].sort(), ['image/jpeg', 'image/png', 'image/webp']);
});

// ---------------------------------------------------------------------------
// File size — a reasonable, documented maximum for profile photos.
// ---------------------------------------------------------------------------

check('PROFILE_PHOTO_MAX_SIZE_BYTES is 5 MB — mirrors src/types/user.ts exactly', () => {
  assert.equal(PROFILE_PHOTO_MAX_SIZE_BYTES, 5 * 1024 * 1024);
});

check('accepts a file exactly at the maximum size', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: PROFILE_PHOTO_MAX_SIZE_BYTES })
  );
});

check('rejects a file one byte over the maximum size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: PROFILE_PHOTO_MAX_SIZE_BYTES + 1 }),
    MediaUploadValidationError
  );
});

check('rejects a wildly oversized declared file size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: 500 * 1024 * 1024 }),
    MediaUploadValidationError
  );
});

check('rejects a zero file size', () => {
  assert.throws(() => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: 0 }), MediaUploadValidationError);
});

check('rejects a negative file size', () => {
  assert.throws(() => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: -100 }), MediaUploadValidationError);
});

check('rejects a non-finite file size (Infinity)', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: Infinity }),
    MediaUploadValidationError
  );
});

check('rejects a NaN file size', () => {
  assert.throws(() => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: NaN }), MediaUploadValidationError);
});

check('rejects a non-number file size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: '1000' }),
    MediaUploadValidationError
  );
});

// ---------------------------------------------------------------------------
// The validator never reads an identity-shaped field, even when one is
// present in the payload — see this file's own top doc comment and
// mediaUploadValidation.ts's own doc comment for the full reasoning
// (uid always comes from request.auth.uid in the real callable, never
// from request.data).
// ---------------------------------------------------------------------------

check('ignores an extra uid field in the payload — the returned value has no such field', () => {
  const result = validateMediaUploadInput({
    mediaKind: 'profilePhoto',
    contentType: 'image/jpeg',
    fileSizeBytes: 1000,
    uid: 'some-other-uid',
    path: 'profilePhotos/some-other-uid/photo',
  });
  assert.equal('uid' in result, false);
  assert.equal('path' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['contentType', 'fileSizeBytes', 'mediaKind']);
});

// ---------------------------------------------------------------------------
// Object key is deterministic and bound to auth.uid only — profilePhotoKey
// (see objectKey.ts, already covered in Step 4's own test-media-key-logic.cjs)
// takes ONLY a uid, structurally proving a request's own data payload can
// never influence which object gets authorized.
// ---------------------------------------------------------------------------

check('profilePhotoKey is deterministic for the same uid', () => {
  assert.equal(profilePhotoKey('uid-a'), profilePhotoKey('uid-a'));
});

check('profilePhotoKey differs for a different uid — one user can never target another\'s object', () => {
  assert.notEqual(profilePhotoKey('uid-a'), profilePhotoKey('uid-b'));
});

check('profilePhotoKey matches the exact existing Firebase convention', () => {
  assert.equal(profilePhotoKey('uid-a'), 'profilePhotos/uid-a/photo');
});

// ---------------------------------------------------------------------------
// Step 5C — 'profileCover' media kind. Same validation shape as
// 'profilePhoto', with its own larger size cap (mirrors the existing
// Firebase-upload PROFILE_COVER_PHOTO_MAX_SIZE_BYTES exactly).
// ---------------------------------------------------------------------------

check('accepts mediaKind "profileCover" with a supported image type', () => {
  const result = validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/jpeg', fileSizeBytes: 1000 });
  assert.equal(result.mediaKind, 'profileCover');
});

check('accepts image/png and image/webp for profileCover too', () => {
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/png', fileSizeBytes: 1000 }));
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/webp', fileSizeBytes: 1000 }));
});

check('rejects an unsupported image type for profileCover (image/gif)', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/gif', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects a video/* content type for profileCover', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'video/mp4', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('PROFILE_COVER_PHOTO_MAX_SIZE_BYTES is 8 MB — mirrors src/types/user.ts exactly', () => {
  assert.equal(PROFILE_COVER_PHOTO_MAX_SIZE_BYTES, 8 * 1024 * 1024);
});

check('profileCover accepts a file exactly at its own (larger) maximum size', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/jpeg', fileSizeBytes: PROFILE_COVER_PHOTO_MAX_SIZE_BYTES })
  );
});

check('profileCover rejects a file one byte over its own maximum size', () => {
  assert.throws(
    () =>
      validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/jpeg', fileSizeBytes: PROFILE_COVER_PHOTO_MAX_SIZE_BYTES + 1 }),
    MediaUploadValidationError
  );
});

check('profileCover rejects a file within profilePhoto\'s smaller cap\'s excess but over its own — proves the two limits are genuinely independent', () => {
  // A size between the photo cap (5 MB) and the cover cap (8 MB) is
  // valid for profileCover but would have been rejected for
  // profilePhoto — this is the actual proof the two mediaKinds don't
  // silently share one limit.
  const midSize = PROFILE_PHOTO_MAX_SIZE_BYTES + 1024;
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/jpeg', fileSizeBytes: midSize }));
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profilePhoto', contentType: 'image/jpeg', fileSizeBytes: midSize }),
    MediaUploadValidationError
  );
});

check('profileCover rejects a zero or negative file size', () => {
  assert.throws(() => validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/jpeg', fileSizeBytes: 0 }), MediaUploadValidationError);
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'profileCover', contentType: 'image/jpeg', fileSizeBytes: -1 }),
    MediaUploadValidationError
  );
});

check('ignores an extra uid/path field in a profileCover payload too', () => {
  const result = validateMediaUploadInput({
    mediaKind: 'profileCover',
    contentType: 'image/jpeg',
    fileSizeBytes: 1000,
    uid: 'some-other-uid',
    path: 'profileCovers/some-other-uid/photo',
  });
  assert.deepEqual(Object.keys(result).sort(), ['contentType', 'fileSizeBytes', 'mediaKind']);
});

check('profileCoverKey is deterministic for the same uid', () => {
  assert.equal(profileCoverKey('uid-a'), profileCoverKey('uid-a'));
});

check('profileCoverKey differs for a different uid — one user can never target another\'s cover object', () => {
  assert.notEqual(profileCoverKey('uid-a'), profileCoverKey('uid-b'));
});

check('profileCoverKey matches the exact existing Firebase convention', () => {
  assert.equal(profileCoverKey('uid-a'), 'profileCovers/uid-a/photo');
});

check('profilePhotoKey and profileCoverKey never collide for the same uid', () => {
  assert.notEqual(profilePhotoKey('uid-a'), profileCoverKey('uid-a'));
});

// ---------------------------------------------------------------------------
// Step 5D — 'eventCover' media kind. Same validation shape as
// 'profileCover' (identical 8 MB cap, identical MIME allowlist), PLUS a
// required `draftId` — the one media kind that needs a client-supplied
// identifier at all (see mediaUploadValidation.ts's own doc comment on
// ValidatedMediaUploadInput.draftId for exactly why: an Event cover is
// uploaded before the real Event document exists, so there is nothing
// server-side yet to derive an identifier from).
// ---------------------------------------------------------------------------

check('accepts mediaKind "eventCover" with a valid draftId and supported image type', () => {
  const result = validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 1000, draftId: 'draft-abc123' });
  assert.equal(result.mediaKind, 'eventCover');
  assert.equal(result.draftId, 'draft-abc123');
});

check('rejects mediaKind "eventCover" with no draftId at all', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "eventCover" with an empty-string draftId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 1000, draftId: '' }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "eventCover" with a non-string draftId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 1000, draftId: 12345 }),
    MediaUploadValidationError
  );
});

check('rejects a malformed draftId containing a slash (path-fragment injection)', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 1000, draftId: 'a/b' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed draftId attempting parent-directory traversal', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 1000, draftId: '../other-uid' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed draftId containing whitespace', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 1000, draftId: 'draft with spaces' }),
    MediaUploadValidationError
  );
});

check('rejects an unsupported image type for eventCover (image/gif)', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/gif', fileSizeBytes: 1000, draftId: 'draft1' }),
    MediaUploadValidationError
  );
});

check('rejects a video/* content type for eventCover', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'video/mp4', fileSizeBytes: 1000, draftId: 'draft1' }),
    MediaUploadValidationError
  );
});

check('EVENT_COVER_PHOTO_MAX_SIZE_BYTES is 8 MB — mirrors src/types/content.ts exactly', () => {
  assert.equal(EVENT_COVER_PHOTO_MAX_SIZE_BYTES, 8 * 1024 * 1024);
});

check('eventCover accepts a file exactly at its own maximum size', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({
      mediaKind: 'eventCover',
      contentType: 'image/jpeg',
      fileSizeBytes: EVENT_COVER_PHOTO_MAX_SIZE_BYTES,
      draftId: 'draft1',
    })
  );
});

check('eventCover rejects a file one byte over its own maximum size', () => {
  assert.throws(
    () =>
      validateMediaUploadInput({
        mediaKind: 'eventCover',
        contentType: 'image/jpeg',
        fileSizeBytes: EVENT_COVER_PHOTO_MAX_SIZE_BYTES + 1,
        draftId: 'draft1',
      }),
    MediaUploadValidationError
  );
});

check('eventCover rejects a zero or negative file size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: 0, draftId: 'draft1' }),
    MediaUploadValidationError
  );
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'eventCover', contentType: 'image/jpeg', fileSizeBytes: -1, draftId: 'draft1' }),
    MediaUploadValidationError
  );
});

check('ignores an extra uid field in an eventCover payload — the caller\'s own uid is never read from request data', () => {
  const result = validateMediaUploadInput({
    mediaKind: 'eventCover',
    contentType: 'image/jpeg',
    fileSizeBytes: 1000,
    draftId: 'draft1',
    uid: 'some-other-uid',
  });
  assert.equal('uid' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['contentType', 'draftId', 'fileSizeBytes', 'mediaKind']);
});

check('eventCoverKey is deterministic for the same uid+draftId', () => {
  assert.equal(eventCoverKey('uid-a', 'draft1'), eventCoverKey('uid-a', 'draft1'));
});

check('eventCoverKey differs for a different uid at the same draftId — one user\'s draft can never target another user\'s namespace', () => {
  assert.notEqual(eventCoverKey('uid-a', 'draft1'), eventCoverKey('uid-b', 'draft1'));
});

check('eventCoverKey matches the exact existing Firebase convention', () => {
  assert.equal(eventCoverKey('uid-a', 'draft1'), 'eventCovers/uid-a/draft1/photo');
});

// ---------------------------------------------------------------------------
// Step 5E — 'reelThumbnail' media kind. Same shape-validation reasoning as
// 'eventCover' above (a required, isSafePathSegment-checked identifier —
// here `reelId` instead of `draftId`), same 5 MB cap as profilePhoto. This
// file only covers the PURE shape validation this module can check —
// verifyReelThumbnailOwnership's own real Firestore ownership/status/
// mediaType checks (in requestMediaUploadAuthorization.ts, which
// transitively imports firebase-admin and so can't run under this plain-
// Node test runner — see this file's own top doc comment) are verified by
// direct code review instead, same convention as this callable's
// auth-required/secret-shape/expiry behavior already is.
// ---------------------------------------------------------------------------

check('accepts mediaKind "reelThumbnail" with a valid reelId and supported image type', () => {
  const result = validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 1000, reelId: 'reel-abc123' });
  assert.equal(result.mediaKind, 'reelThumbnail');
  assert.equal(result.reelId, 'reel-abc123');
});

check('rejects mediaKind "reelThumbnail" with no reelId at all', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "reelThumbnail" with an empty-string reelId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 1000, reelId: '' }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "reelThumbnail" with a non-string reelId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 1000, reelId: 12345 }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId containing a slash (path-fragment injection)', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 1000, reelId: 'a/b' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId attempting parent-directory traversal', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 1000, reelId: '../other-uid' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId containing whitespace', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 1000, reelId: 'reel with spaces' }),
    MediaUploadValidationError
  );
});

check('rejects an unsupported image type for reelThumbnail (image/gif)', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/gif', fileSizeBytes: 1000, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('rejects a video/* content type for reelThumbnail', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'video/mp4', fileSizeBytes: 1000, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('REEL_THUMBNAIL_MAX_SIZE_BYTES is 5 MB — mirrors firestore.rules\' isValidReelThumbnail and src/types/reel.ts exactly', () => {
  assert.equal(REEL_THUMBNAIL_MAX_SIZE_BYTES, 5 * 1024 * 1024);
});

check('reelThumbnail accepts a file exactly at its own maximum size', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({
      mediaKind: 'reelThumbnail',
      contentType: 'image/jpeg',
      fileSizeBytes: REEL_THUMBNAIL_MAX_SIZE_BYTES,
      reelId: 'reel1',
    })
  );
});

check('reelThumbnail rejects a file one byte over its own maximum size', () => {
  assert.throws(
    () =>
      validateMediaUploadInput({
        mediaKind: 'reelThumbnail',
        contentType: 'image/jpeg',
        fileSizeBytes: REEL_THUMBNAIL_MAX_SIZE_BYTES + 1,
        reelId: 'reel1',
      }),
    MediaUploadValidationError
  );
});

check('reelThumbnail rejects a file within profilePhoto\'s smaller cap\'s excess but over its own only if it truly exceeds 5 MB — sanity-checks the cap is genuinely REEL_THUMBNAIL_MAX_SIZE_BYTES, not the profileCover/eventCover 8 MB one', () => {
  assert.throws(
    () =>
      validateMediaUploadInput({
        mediaKind: 'reelThumbnail',
        contentType: 'image/jpeg',
        fileSizeBytes: 6 * 1024 * 1024,
        reelId: 'reel1',
      }),
    MediaUploadValidationError
  );
});

check('reelThumbnail rejects a zero or negative file size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: 0, reelId: 'reel1' }),
    MediaUploadValidationError
  );
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelThumbnail', contentType: 'image/jpeg', fileSizeBytes: -1, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('ignores an extra uid/authorUid field in a reelThumbnail payload — ownership is verified server-side against Firestore, never trusted from request data', () => {
  const result = validateMediaUploadInput({
    mediaKind: 'reelThumbnail',
    contentType: 'image/jpeg',
    fileSizeBytes: 1000,
    reelId: 'reel1',
    uid: 'some-other-uid',
    authorUid: 'some-other-uid',
  });
  assert.equal('uid' in result, false);
  assert.equal('authorUid' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['contentType', 'fileSizeBytes', 'mediaKind', 'reelId']);
});

check('reelThumbnailKey is deterministic for the same uid+reelId', () => {
  assert.equal(reelThumbnailKey('uid-a', 'reel1'), reelThumbnailKey('uid-a', 'reel1'));
});

check('reelThumbnailKey differs for a different uid at the same reelId — one user\'s Reel can never target another user\'s namespace', () => {
  assert.notEqual(reelThumbnailKey('uid-a', 'reel1'), reelThumbnailKey('uid-b', 'reel1'));
});

check('reelThumbnailKey matches the exact existing Firebase convention', () => {
  assert.equal(reelThumbnailKey('uid-a', 'reel1'), 'reels/uid-a/reel1/thumbnail');
});

// ---------------------------------------------------------------------------
// Step 9A — 'reelVideo' media kind. Same required-reelId shape-validation
// reasoning as 'reelThumbnail' above, but with its OWN, separate content-type
// allowlist (ALLOWED_VIDEO_CONTENT_TYPES, not ALLOWED_CONTENT_TYPES) and its
// OWN, much larger size cap (REEL_VIDEO_MAX_SIZE_BYTES). This file only
// covers the PURE shape validation this module can check —
// verifyReelVideoOwnership's own real Firestore ownership/status/mediaType/
// musicSourceType/needsPhotoVideoRender checks (in
// requestMediaUploadAuthorization.ts, which transitively imports
// firebase-admin and so can't run under this plain-Node test runner — see
// this file's own top doc comment) are verified by direct code review
// instead, same convention as every other callable-level check in this
// file.
// ---------------------------------------------------------------------------

check('accepts mediaKind "reelVideo" with a valid reelId and video/mp4', () => {
  const result = validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: 1000, reelId: 'reel-abc123' });
  assert.equal(result.mediaKind, 'reelVideo');
  assert.equal(result.reelId, 'reel-abc123');
});

check('accepts mediaKind "reelVideo" with video/quicktime — live testing has confirmed real iOS .mov uploads use this exact type', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/quicktime', fileSizeBytes: 1000, reelId: 'reel1' })
  );
});

check('accepts mediaKind "reelVideo" with video/x-m4v and video/webm — the other two extensions camera.tsx\'s own KNOWN_VIDEO_EXTENSIONS map declares supported', () => {
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/x-m4v', fileSizeBytes: 1000, reelId: 'reel1' }));
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/webm', fileSizeBytes: 1000, reelId: 'reel1' }));
});

check('rejects mediaKind "reelVideo" with no reelId at all', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "reelVideo" with an empty-string reelId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: 1000, reelId: '' }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "reelVideo" with a non-string reelId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: 1000, reelId: 12345 }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId containing a slash (path-fragment injection) for reelVideo', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: 1000, reelId: 'a/b' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId attempting parent-directory traversal for reelVideo', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: 1000, reelId: '../other-uid' }),
    MediaUploadValidationError
  );
});

check('Step 9C — accepts an image/jpeg content type for reelVideo (a photo Reel/render-pending Reel\'s own original-photo upload), at a photo-sized fileSizeBytes', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'image/jpeg', fileSizeBytes: 1000, reelId: 'reel1' })
  );
});

check('rejects an audio/* content type for reelVideo', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'audio/mp4', fileSizeBytes: 1000, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('rejects application/octet-stream for reelVideo', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'application/octet-stream', fileSizeBytes: 1000, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('rejects an arbitrary/unrecognized video-shaped MIME type for reelVideo — a narrow allowlist, not a video/* wildcard', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/3gpp', fileSizeBytes: 1000, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

// ---------------------------------------------------------------------------
// Step 9C — 'reelVideo' now also accepts a PHOTO shape (a plain photo
// Reel's own source, or a photo-pending-render Reel's still-a-photo
// original upload). This pure layer only validates SOME allowed shape was
// sent (see ALLOWED_REEL_PHOTO_CONTENT_TYPES/REEL_PHOTO_SOURCE_MAX_SIZE_BYTES's
// own doc comments in mediaUploadValidation.ts) — the cross-check that
// it's the RIGHT shape for a given Reel's own current state is
// checkReelVideoEligibility's own job (see test-reel-eligibility-logic.cjs).
// ---------------------------------------------------------------------------

check('Step 9C — accepts image/png and image/webp for reelVideo, the same photo-shape allowlist as image/jpeg', () => {
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'image/png', fileSizeBytes: 1000, reelId: 'reel1' }));
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'image/webp', fileSizeBytes: 1000, reelId: 'reel1' }));
});

check('Step 9C — accepts image/heic and image/heif for reelVideo — genuinely unnormalized library-picked photos, not a guessed-away possibility', () => {
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'image/heic', fileSizeBytes: 1000, reelId: 'reel1' }));
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'image/heif', fileSizeBytes: 1000, reelId: 'reel1' }));
});

check('Step 9C — rejects image/gif for reelVideo — not in the photo-shape allowlist, same narrow-allowlist posture as the video shape', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'image/gif', fileSizeBytes: 1000, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('REEL_PHOTO_SOURCE_MAX_SIZE_BYTES is 10 MB — mirrors src/types/reel.ts\'s REEL_PHOTO_MAX_FILE_SIZE_BYTES and firestore.rules\' own existing 10485760 cap exactly', () => {
  assert.equal(REEL_PHOTO_SOURCE_MAX_SIZE_BYTES, 10 * 1024 * 1024);
});

check('Step 9C — reelVideo photo shape accepts a file exactly at its own (photo) maximum size', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'image/jpeg', fileSizeBytes: REEL_PHOTO_SOURCE_MAX_SIZE_BYTES, reelId: 'reel1' })
  );
});

check('Step 9C — reelVideo photo shape rejects a file one byte over its own (photo) maximum size — the SMALLER photo cap, not the video cap', () => {
  assert.throws(
    () =>
      validateMediaUploadInput({
        mediaKind: 'reelVideo',
        contentType: 'image/jpeg',
        fileSizeBytes: REEL_PHOTO_SOURCE_MAX_SIZE_BYTES + 1,
        reelId: 'reel1',
      }),
    MediaUploadValidationError
  );
});

check('Step 9C — a photo-shaped upload beyond the photo cap but still under the (larger) video cap is still REJECTED — the two caps are not interchangeable', () => {
  assert.ok(REEL_PHOTO_SOURCE_MAX_SIZE_BYTES < REEL_VIDEO_MAX_SIZE_BYTES);
  assert.throws(
    () =>
      validateMediaUploadInput({
        mediaKind: 'reelVideo',
        contentType: 'image/jpeg',
        fileSizeBytes: REEL_PHOTO_SOURCE_MAX_SIZE_BYTES + 1,
        reelId: 'reel1',
      }),
    MediaUploadValidationError
  );
});

check('ALLOWED_REEL_PHOTO_CONTENT_TYPES is exactly the five-format set this app\'s own photo Reel/render-pending upload paths actually produce', () => {
  assert.deepEqual(
    [...ALLOWED_REEL_PHOTO_CONTENT_TYPES].sort(),
    ['image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp'].sort()
  );
});

check('REEL_VIDEO_MAX_SIZE_BYTES is 50 MB — mirrors src/types/reel.ts\'s REEL_MAX_FILE_SIZE_BYTES and storage.rules\' own existing Reel-source cap exactly', () => {
  assert.equal(REEL_VIDEO_MAX_SIZE_BYTES, 50 * 1024 * 1024);
});

check('reelVideo accepts a file exactly at its own maximum size', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: REEL_VIDEO_MAX_SIZE_BYTES, reelId: 'reel1' })
  );
});

check('reelVideo rejects a file one byte over its own maximum size', () => {
  assert.throws(
    () =>
      validateMediaUploadInput({
        mediaKind: 'reelVideo',
        contentType: 'video/mp4',
        fileSizeBytes: REEL_VIDEO_MAX_SIZE_BYTES + 1,
        reelId: 'reel1',
      }),
    MediaUploadValidationError
  );
});

check('reelVideo rejects a zero or negative file size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: 0, reelId: 'reel1' }),
    MediaUploadValidationError
  );
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelVideo', contentType: 'video/mp4', fileSizeBytes: -1, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('ALLOWED_VIDEO_CONTENT_TYPES is exactly the four-format set this app\'s own camera.tsx KNOWN_VIDEO_EXTENSIONS map declares — not a broader video/* wildcard', () => {
  assert.deepEqual([...ALLOWED_VIDEO_CONTENT_TYPES].sort(), ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'].sort());
});

check('ignores an extra uid/authorUid field in a reelVideo payload — ownership is verified server-side against Firestore, never trusted from request data', () => {
  const result = validateMediaUploadInput({
    mediaKind: 'reelVideo',
    contentType: 'video/mp4',
    fileSizeBytes: 1000,
    reelId: 'reel1',
    uid: 'some-other-uid',
    authorUid: 'some-other-uid',
  });
  assert.equal('uid' in result, false);
  assert.equal('authorUid' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['contentType', 'fileSizeBytes', 'mediaKind', 'reelId']);
});

// ---------------------------------------------------------------------------
// Step 10A — 'storyMedia' media kind, reusing the EXACT same two shapes/
// allowlists/size caps as 'reelVideo' (see mediaUploadValidation.ts's own
// 'storyMedia' doc comment for why a Story's real MIME/size universe is
// provably identical to a Reel's — same camera/picker code path).
// ---------------------------------------------------------------------------

check('accepts mediaKind "storyMedia" with a valid storyId and video/mp4', () => {
  const result = validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'video/mp4', fileSizeBytes: 1000, storyId: 'story-abc123' });
  assert.equal(result.mediaKind, 'storyMedia');
  assert.equal(result.storyId, 'story-abc123');
});

check('accepts mediaKind "storyMedia" with a valid storyId and image/jpeg', () => {
  assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'image/jpeg', fileSizeBytes: 1000, storyId: 'story1' }));
});

check('accepts mediaKind "storyMedia" with image/heic/heif/png/webp — the same photo-shape allowlist as reelVideo', () => {
  for (const contentType of ['image/heic', 'image/heif', 'image/png', 'image/webp']) {
    assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType, fileSizeBytes: 1000, storyId: 'story1' }));
  }
});

check('accepts mediaKind "storyMedia" with video/quicktime/x-m4v/webm — the same video-shape allowlist as reelVideo', () => {
  for (const contentType of ['video/quicktime', 'video/x-m4v', 'video/webm']) {
    assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType, fileSizeBytes: 1000, storyId: 'story1' }));
  }
});

check('rejects mediaKind "storyMedia" with no storyId at all', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'video/mp4', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects a malformed storyId containing a slash (path-fragment injection) for storyMedia', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'video/mp4', fileSizeBytes: 1000, storyId: 'a/b' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed storyId attempting parent-directory traversal for storyMedia', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'video/mp4', fileSizeBytes: 1000, storyId: '../other-uid' }),
    MediaUploadValidationError
  );
});

check('rejects audio/* and application/octet-stream for storyMedia — neither shape matches', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'audio/mp4', fileSizeBytes: 1000, storyId: 'story1' }),
    MediaUploadValidationError
  );
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'application/octet-stream', fileSizeBytes: 1000, storyId: 'story1' }),
    MediaUploadValidationError
  );
});

check('storyMedia video shape accepts exactly REEL_VIDEO_MAX_SIZE_BYTES and rejects one byte over — the SAME cap as reelVideo, not a separate Story-specific number', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'video/mp4', fileSizeBytes: REEL_VIDEO_MAX_SIZE_BYTES, storyId: 'story1' })
  );
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'video/mp4', fileSizeBytes: REEL_VIDEO_MAX_SIZE_BYTES + 1, storyId: 'story1' }),
    MediaUploadValidationError
  );
});

check('storyMedia photo shape accepts exactly REEL_PHOTO_SOURCE_MAX_SIZE_BYTES and rejects one byte over — the SAME cap as reelVideo\'s own photo shape', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'image/jpeg', fileSizeBytes: REEL_PHOTO_SOURCE_MAX_SIZE_BYTES, storyId: 'story1' })
  );
  assert.throws(
    () =>
      validateMediaUploadInput({ mediaKind: 'storyMedia', contentType: 'image/jpeg', fileSizeBytes: REEL_PHOTO_SOURCE_MAX_SIZE_BYTES + 1, storyId: 'story1' }),
    MediaUploadValidationError
  );
});

check('ignores an extra uid/authorUid field in a storyMedia payload — ownership is verified server-side against Firestore, never trusted from request data', () => {
  const result = validateMediaUploadInput({
    mediaKind: 'storyMedia',
    contentType: 'video/mp4',
    fileSizeBytes: 1000,
    storyId: 'story1',
    uid: 'some-other-uid',
    authorUid: 'some-other-uid',
  });
  assert.equal('uid' in result, false);
  assert.equal('authorUid' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['contentType', 'fileSizeBytes', 'mediaKind', 'storyId']);
});

check('reelSourceKey is deterministic for the same uid+reelId', () => {
  assert.equal(reelSourceKey('uid-a', 'reel1'), reelSourceKey('uid-a', 'reel1'));
});

check('reelSourceKey differs for a different uid at the same reelId — one user\'s Reel can never target another user\'s namespace', () => {
  assert.notEqual(reelSourceKey('uid-a', 'reel1'), reelSourceKey('uid-b', 'reel1'));
});

check('reelSourceKey matches the exact existing Firebase convention', () => {
  assert.equal(reelSourceKey('uid-a', 'reel1'), 'reels/uid-a/reel1/source');
});

check('storySourceKey is deterministic for the same uid+storyId', () => {
  assert.equal(storySourceKey('uid-a', 'story1'), storySourceKey('uid-a', 'story1'));
});

check('storySourceKey differs for a different uid at the same storyId — one user\'s Story can never target another user\'s namespace', () => {
  assert.notEqual(storySourceKey('uid-a', 'story1'), storySourceKey('uid-b', 'story1'));
});

check('storySourceKey matches the exact existing Firebase convention', () => {
  assert.equal(storySourceKey('uid-a', 'story1'), 'stories/uid-a/story1/source');
});

// ---------------------------------------------------------------------------
// Step 10B — 'reelMusic' media kind. Unlike reelVideo/storyMedia (narrow,
// camera/library-bounded MIME allowlists), a Reel's own uploaded music comes
// from the device's own arbitrary file picker (expo-document-picker,
// `type: 'audio/*'`) — so this shape deliberately uses a WIDE
// `contentType.startsWith('audio/')` prefix check, mirroring storage.rules'
// own pre-existing `musicStorageContentType.matches('audio/.*')` wildcard,
// rather than a narrow enumerated Set like every other media kind here. See
// mediaUploadValidation.ts's own 'reelMusic' doc comment for the full
// reasoning.
// ---------------------------------------------------------------------------

check('accepts mediaKind "reelMusic" with a valid reelId and audio/mp4', () => {
  const result = validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 1000, reelId: 'reel-abc123' });
  assert.equal(result.mediaKind, 'reelMusic');
  assert.equal(result.reelId, 'reel-abc123');
});

check('accepts a wide range of real "audio/*" MIME types for reelMusic — a prefix check, not a narrow enumerated allowlist', () => {
  for (const contentType of ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/ogg', 'audio/flac', 'audio/x-wav']) {
    assert.doesNotThrow(() => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType, fileSizeBytes: 1000, reelId: 'reel1' }));
  }
});

check('rejects mediaKind "reelMusic" with no reelId at all', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 1000 }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "reelMusic" with an empty-string reelId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 1000, reelId: '' }),
    MediaUploadValidationError
  );
});

check('rejects mediaKind "reelMusic" with a non-string reelId', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 1000, reelId: 12345 }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId containing a slash (path-fragment injection) for reelMusic', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 1000, reelId: 'a/b' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId attempting parent-directory traversal for reelMusic', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 1000, reelId: '../other-uid' }),
    MediaUploadValidationError
  );
});

check('rejects a malformed reelId containing whitespace for reelMusic', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 1000, reelId: 'reel with spaces' }),
    MediaUploadValidationError
  );
});

check('rejects a non-audio contentType for reelMusic (video/mp4, image/jpeg, application/octet-stream)', () => {
  for (const contentType of ['video/mp4', 'image/jpeg', 'application/octet-stream']) {
    assert.throws(
      () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType, fileSizeBytes: 1000, reelId: 'reel1' }),
      MediaUploadValidationError
    );
  }
});

check('rejects a non-string contentType for reelMusic', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 123, fileSizeBytes: 1000, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('REEL_MUSIC_MAX_SIZE_BYTES is 20 MB — mirrors src/types/reel.ts\'s REEL_MUSIC_MAX_FILE_SIZE_BYTES exactly', () => {
  assert.equal(REEL_MUSIC_MAX_SIZE_BYTES, 20 * 1024 * 1024);
});

check('reelMusic accepts a file exactly at its own maximum size', () => {
  assert.doesNotThrow(() =>
    validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: REEL_MUSIC_MAX_SIZE_BYTES, reelId: 'reel1' })
  );
});

check('reelMusic rejects a file one byte over its own maximum size', () => {
  assert.throws(
    () =>
      validateMediaUploadInput({
        mediaKind: 'reelMusic',
        contentType: 'audio/mp4',
        fileSizeBytes: REEL_MUSIC_MAX_SIZE_BYTES + 1,
        reelId: 'reel1',
      }),
    MediaUploadValidationError
  );
});

check('reelMusic rejects a zero or negative file size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: 0, reelId: 'reel1' }),
    MediaUploadValidationError
  );
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: -1, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('reelMusic rejects a non-finite or NaN file size', () => {
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: Infinity, reelId: 'reel1' }),
    MediaUploadValidationError
  );
  assert.throws(
    () => validateMediaUploadInput({ mediaKind: 'reelMusic', contentType: 'audio/mp4', fileSizeBytes: NaN, reelId: 'reel1' }),
    MediaUploadValidationError
  );
});

check('ignores an extra uid/authorUid field in a reelMusic payload — ownership is verified server-side against Firestore, never trusted from request data', () => {
  const result = validateMediaUploadInput({
    mediaKind: 'reelMusic',
    contentType: 'audio/mp4',
    fileSizeBytes: 1000,
    reelId: 'reel1',
    uid: 'some-other-uid',
    authorUid: 'some-other-uid',
  });
  assert.equal('uid' in result, false);
  assert.equal('authorUid' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['contentType', 'fileSizeBytes', 'mediaKind', 'reelId']);
});

check('reelMusicKey is deterministic for the same uid+reelId', () => {
  assert.equal(reelMusicKey('uid-a', 'reel1'), reelMusicKey('uid-a', 'reel1'));
});

check('reelMusicKey differs for a different uid at the same reelId — one user\'s Reel can never target another user\'s namespace', () => {
  assert.notEqual(reelMusicKey('uid-a', 'reel1'), reelMusicKey('uid-b', 'reel1'));
});

check('reelMusicKey matches the exact existing Firebase convention', () => {
  assert.equal(reelMusicKey('uid-a', 'reel1'), 'reels/uid-a/reel1/music');
});

check('reelMusicKey never collides with reelSourceKey or reelThumbnailKey for the same uid+reelId', () => {
  assert.notEqual(reelMusicKey('uid-a', 'reel1'), reelSourceKey('uid-a', 'reel1'));
  assert.notEqual(reelMusicKey('uid-a', 'reel1'), reelThumbnailKey('uid-a', 'reel1'));
});

console.log('\n=== functions/ media upload authorization logic test results ===');
let failures = 0;
for (const result of results) {
  if (result.pass) {
    console.log(`PASS — ${result.name}`);
  } else {
    failures += 1;
    console.log(`FAIL — ${result.name}`);
    console.log(`       ${result.error instanceof Error ? result.error.message : result.error}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} passed.`);

if (failures > 0) {
  process.exit(1);
}
