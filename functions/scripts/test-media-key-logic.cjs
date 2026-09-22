/**
 * Step 4 (storage-provider foundation) — plain-Node tests for the pure
 * object-key helpers in functions/src/media/objectKey.ts: deterministic
 * key shape (matches the client's own existing storagePath convention
 * exactly) and path-traversal/malformed-segment safety. Runs against the
 * COMPILED lib/ output — `npm run build` first (see the `test` script in
 * package.json).
 *
 * Deliberately does not touch r2Config.ts/r2Storage.ts — those require
 * either real R2 credentials or a mocked S3 client to exercise
 * meaningfully, and this pass is only about the pure key-building logic
 * (see objectKey.ts's own doc comment on why it's kept dependency-free).
 */
const assert = require('node:assert/strict');
const {
  isSafePathSegment,
  reelSourceKey,
  reelThumbnailKey,
  reelMusicKey,
  storySourceKey,
  profilePhotoKey,
  profileCoverKey,
  eventCoverKey,
  soundOriginKey,
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
// isSafePathSegment — the guard every key builder relies on.
// ---------------------------------------------------------------------------

check('isSafePathSegment accepts a real Firebase Auth-shaped uid', () => {
  assert.equal(isSafePathSegment('SlPP2gBioxfl5TbsJSP8P8RcLIK2'), true);
});

check('isSafePathSegment accepts a real Firestore auto-ID-shaped doc id', () => {
  assert.equal(isSafePathSegment('vGTQSKyynShZ1OGsHoj7'), true);
});

check('isSafePathSegment accepts a SHA-256 hex hash (soundOrigins key)', () => {
  assert.equal(isSafePathSegment('a3f5c8d9e1b2a3f5c8d9e1b2a3f5c8d9e1b2a3f5c8d9e1b2a3f5c8d9e1b2a3f5'), true);
});

check('isSafePathSegment rejects a segment containing a slash', () => {
  assert.equal(isSafePathSegment('uid/other'), false);
});

check('isSafePathSegment rejects a parent-directory traversal attempt', () => {
  assert.equal(isSafePathSegment('..'), false);
});

check('isSafePathSegment rejects a traversal attempt embedded in a longer segment', () => {
  assert.equal(isSafePathSegment('../etc-passwd'), false);
});

check('isSafePathSegment rejects an empty string', () => {
  assert.equal(isSafePathSegment(''), false);
});

check('isSafePathSegment rejects a segment with embedded whitespace', () => {
  assert.equal(isSafePathSegment('uid with spaces'), false);
});

check('isSafePathSegment rejects a non-string value', () => {
  assert.equal(isSafePathSegment(null), false);
  assert.equal(isSafePathSegment(undefined), false);
});

// ---------------------------------------------------------------------------
// Key builders — exact shape match against the client's own existing
// storagePath convention (see this file's own top doc comment).
// ---------------------------------------------------------------------------

check('reelSourceKey matches the existing reels/{uid}/{reelId}/source convention', () => {
  assert.equal(reelSourceKey('uid1', 'reel1'), 'reels/uid1/reel1/source');
});

check('reelThumbnailKey matches the existing reels/{uid}/{reelId}/thumbnail convention', () => {
  assert.equal(reelThumbnailKey('uid1', 'reel1'), 'reels/uid1/reel1/thumbnail');
});

check('reelThumbnailKey differs for a different uid at the same reelId — one user can never write into another\'s reels/ namespace', () => {
  assert.notEqual(reelThumbnailKey('uid-a', 'reel1'), reelThumbnailKey('uid-b', 'reel1'));
});

check('reelThumbnailKey differs for a different reelId at the same uid — a fresh Reel never collides with an earlier one', () => {
  assert.notEqual(reelThumbnailKey('uid1', 'reel1'), reelThumbnailKey('uid1', 'reel2'));
});

check('reelMusicKey matches the existing reels/{uid}/{reelId}/music convention', () => {
  assert.equal(reelMusicKey('uid1', 'reel1'), 'reels/uid1/reel1/music');
});

check('storySourceKey matches the existing stories/{uid}/{storyId}/source convention', () => {
  assert.equal(storySourceKey('uid1', 'story1'), 'stories/uid1/story1/source');
});

check('profilePhotoKey matches the existing profilePhotos/{uid}/photo convention', () => {
  assert.equal(profilePhotoKey('uid1'), 'profilePhotos/uid1/photo');
});

check('profileCoverKey matches the existing profileCovers/{uid}/photo convention', () => {
  assert.equal(profileCoverKey('uid1'), 'profileCovers/uid1/photo');
});

check('eventCoverKey matches the existing eventCovers/{uid}/{draftId}/photo convention', () => {
  assert.equal(eventCoverKey('uid1', 'draft1'), 'eventCovers/uid1/draft1/photo');
});

check('eventCoverKey differs for a different uid at the same draftId — one user can never write into another\'s eventCovers/ namespace', () => {
  assert.notEqual(eventCoverKey('uid-a', 'draft1'), eventCoverKey('uid-b', 'draft1'));
});

check('eventCoverKey differs for a different draftId at the same uid — a fresh draft never collides with an earlier one', () => {
  assert.notEqual(eventCoverKey('uid1', 'draft1'), eventCoverKey('uid1', 'draft2'));
});

check('soundOriginKey matches the existing soundOrigins/{hash}/audio convention', () => {
  assert.equal(soundOriginKey('abcdef0123456789'), 'soundOrigins/abcdef0123456789/audio');
});

// ---------------------------------------------------------------------------
// Every key builder rejects a hostile/malformed segment rather than
// silently building a traversal-capable key.
// ---------------------------------------------------------------------------

check('reelSourceKey throws on a path-traversal uid rather than building an escaping key', () => {
  assert.throws(() => reelSourceKey('../other-uid', 'reel1'));
});

check('reelSourceKey throws on a path-traversal reelId rather than building an escaping key', () => {
  assert.throws(() => reelSourceKey('uid1', '../../etc'));
});

check('eventCoverKey throws on a slash-containing draftId', () => {
  assert.throws(() => eventCoverKey('uid1', 'a/b'));
});

check('eventCoverKey throws on a path-traversal draftId', () => {
  assert.throws(() => eventCoverKey('uid1', '../other-uid'));
});

check('reelThumbnailKey throws on a slash-containing reelId', () => {
  assert.throws(() => reelThumbnailKey('uid1', 'a/b'));
});

check('reelThumbnailKey throws on a path-traversal reelId', () => {
  assert.throws(() => reelThumbnailKey('uid1', '../other-uid'));
});

console.log('\n=== functions/ media object-key logic test results ===');
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
