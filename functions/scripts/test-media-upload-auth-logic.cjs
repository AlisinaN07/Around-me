/**
 * Step 5A/5C — plain-Node tests for the pure request-validation logic
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
  PROFILE_PHOTO_MAX_SIZE_BYTES,
  PROFILE_COVER_PHOTO_MAX_SIZE_BYTES,
} = require('../lib/media/mediaUploadValidation.js');
const { profileCoverKey, profilePhotoKey } = require('../lib/media/objectKey.js');

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
