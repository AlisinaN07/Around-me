/**
 * Step 9A — DETERMINISTIC MIRROR of firestore.rules' own Reel
 * source/thumbnail-provider transition predicates
 * (isValidReelSourceProviderUpdate, isValidReelThumbnailProviderUpdate,
 * isValidReelPublish, isValidReelCreate's storageProvider/sourceUrl
 * defaults, and the plain `allow read` condition), reimplemented here as
 * plain JS functions and tested against fixtures.
 *
 * WHY THIS FILE EXISTS: `npm run test:rules` (the real Firestore emulator
 * suite) cannot currently execute in this sandbox — every attempt
 * (`initializeTestEnvironment` -> `loadFirestoreRules`) fails with
 * `TypeError: fetch failed` / `ECONNRESET`, reproduced even with a
 * minimal PUT/GET/POST against the emulator's own `:securityRules`
 * management endpoint, using raw curl (not just the JS SDK), across
 * Node 18/20/22 and firebase-tools 15.27.0 AND @latest, with the
 * `-Djava.net.preferIPv4Stack=true` JVM fix already applied (which DID
 * fix a real, separate IPv6-binding bug — see package.json's own
 * `test:rules` script and functions/src/media/r2Storage.ts's doc
 * comment). The emulator's own trivial root health-check path
 * (`GET /`) responds correctly; every REST management/data endpoint
 * beyond that resets the connection at the TCP level in this specific
 * sandboxed environment — most likely a Java 21 + the bundled
 * grpc-java/Netty transport incompatibility in this exact
 * cloud-firestore-emulator jar version, not something fixable by
 * editing this repository's own code, test scripts, or npm
 * configuration. See the Step 9A report's own "Rules-test diagnosis"
 * section for the full investigation.
 *
 * THIS FILE IS NOT A SUBSTITUTE for that real emulator run — it is a
 * plain reimplementation of the same boolean logic, so a mismatch
 * between this file and firestore.rules' own text is a real risk this
 * file cannot catch on its own (only a real rules-engine run can prove
 * the ACTUAL deployed rules behave this way). Each predicate below cites
 * the exact firestore.rules function/line range it mirrors; whenever
 * firestore.rules' own Reel rules change, this file must be updated to
 * match by hand. What this file DOES prove deterministically: the
 * INTENDED transition logic (as designed and reviewed) produces the
 * right accept/reject decision for every scenario below — a genuine,
 * valuable check even though it isn't the real rules engine.
 */
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Plain JS mirror of firestore.rules' reelBaseKeys() (line ~1390-1404).
// ---------------------------------------------------------------------------
const REEL_BASE_KEYS = [
  'reelId', 'authorUid', 'authorDisplayName', 'authorUsername',
  'cityName', 'countryCode', 'cityKey', 'categoryId', 'caption', 'hashtags',
  'mediaType', 'needsPhotoVideoRender', 'storagePath', 'storageContentType', 'fileSizeBytes', 'durationMs',
  'storageProvider', 'sourceUrl',
  'width', 'height', 'status', 'visibility',
  'musicSourceType', 'musicTitle', 'musicStorageAudioPath',
  'musicStorageContentType', 'musicFileSizeBytes', 'musicDurationMs',
  'musicHash', 'soundOriginAuthorUid', 'soundOriginReelId',
  'thumbnailStoragePath', 'thumbnailStorageContentType',
  'thumbnailFileSizeBytes', 'thumbnailWidth', 'thumbnailHeight',
  'thumbnailStorageProvider', 'thumbnailUrl',
  'createdAt', 'updatedAt', 'publishedAt',
];

function hasOnlyKeys(data, allowed) {
  return Object.keys(data).every((k) => allowed.includes(k));
}
function isServerTimestampSentinel(value) {
  // firestore.rules' isServerTimestamp() checks for the FieldValue.serverTimestamp()
  // sentinel a real write carries — this mirror just needs a fixture-level
  // stand-in a test can set, since we're never talking to a real Firestore.
  return value === 'SERVER_TIMESTAMP';
}

/**
 * Mirrors isValidReelSourceProviderUpdate (firestore.rules, line
 * ~1751-1806) field-for-field, including its exhaustive
 * "every other field must stay byte-identical" equality list and the
 * defense-in-depth musicSourceType/needsPhotoVideoRender checks. Step
 * 9B relaxed the musicSourceType constraint from `'none'`-only to
 * `'none' or 'device'` (kept UNCHANGED across the transition either
 * way) — mirrored here exactly.
 */
function isValidReelSourceProviderUpdate(newData, oldData) {
  return (
    oldData.status === 'uploading' &&
    newData.status === 'uploading' &&
    oldData.mediaType === 'video' &&
    newData.mediaType === 'video' &&
    (oldData.musicSourceType === 'none' || oldData.musicSourceType === 'device') &&
    newData.musicSourceType === oldData.musicSourceType &&
    oldData.needsPhotoVideoRender === false &&
    newData.needsPhotoVideoRender === false &&
    oldData.storageProvider === 'firebase' &&
    newData.storageProvider === 'r2' &&
    typeof newData.sourceUrl === 'string' &&
    newData.sourceUrl.length > 0 &&
    newData.sourceUrl.length <= 2048 &&
    /^https:\/\//.test(newData.sourceUrl) &&
    isServerTimestampSentinel(newData.updatedAt) &&
    newData.reelId === oldData.reelId &&
    newData.authorUid === oldData.authorUid &&
    newData.authorDisplayName === oldData.authorDisplayName &&
    newData.authorUsername === oldData.authorUsername &&
    newData.cityName === oldData.cityName &&
    newData.countryCode === oldData.countryCode &&
    newData.cityKey === oldData.cityKey &&
    newData.categoryId === oldData.categoryId &&
    newData.caption === oldData.caption &&
    JSON.stringify(newData.hashtags) === JSON.stringify(oldData.hashtags) &&
    newData.storagePath === oldData.storagePath &&
    newData.storageContentType === oldData.storageContentType &&
    newData.fileSizeBytes === oldData.fileSizeBytes &&
    newData.durationMs === oldData.durationMs &&
    newData.width === oldData.width &&
    newData.height === oldData.height &&
    newData.visibility === oldData.visibility &&
    newData.musicTitle === oldData.musicTitle &&
    newData.musicStorageAudioPath === oldData.musicStorageAudioPath &&
    newData.musicStorageContentType === oldData.musicStorageContentType &&
    newData.musicFileSizeBytes === oldData.musicFileSizeBytes &&
    newData.musicDurationMs === oldData.musicDurationMs &&
    newData.musicHash === oldData.musicHash &&
    newData.soundOriginAuthorUid === oldData.soundOriginAuthorUid &&
    newData.soundOriginReelId === oldData.soundOriginReelId &&
    newData.thumbnailStoragePath === oldData.thumbnailStoragePath &&
    newData.thumbnailStorageContentType === oldData.thumbnailStorageContentType &&
    newData.thumbnailFileSizeBytes === oldData.thumbnailFileSizeBytes &&
    newData.thumbnailWidth === oldData.thumbnailWidth &&
    newData.thumbnailHeight === oldData.thumbnailHeight &&
    newData.thumbnailStorageProvider === oldData.thumbnailStorageProvider &&
    newData.thumbnailUrl === oldData.thumbnailUrl &&
    newData.createdAt === oldData.createdAt &&
    newData.publishedAt === oldData.publishedAt &&
    hasOnlyKeys(newData, REEL_BASE_KEYS)
  );
}

/** Mirrors isValidReelThumbnailProviderUpdate (firestore.rules, line ~1666-1727). */
function isValidReelThumbnailProviderUpdate(newData, oldData) {
  return (
    oldData.status === 'uploading' &&
    newData.status === 'uploading' &&
    oldData.mediaType === 'video' &&
    newData.mediaType === 'video' &&
    oldData.thumbnailStorageProvider === 'firebase' &&
    newData.thumbnailStorageProvider === 'r2' &&
    typeof newData.thumbnailUrl === 'string' &&
    newData.thumbnailUrl.length > 0 &&
    newData.thumbnailUrl.length <= 2048 &&
    /^https:\/\//.test(newData.thumbnailUrl) &&
    isServerTimestampSentinel(newData.updatedAt) &&
    newData.reelId === oldData.reelId &&
    newData.authorUid === oldData.authorUid &&
    newData.authorDisplayName === oldData.authorDisplayName &&
    newData.authorUsername === oldData.authorUsername &&
    newData.cityName === oldData.cityName &&
    newData.countryCode === oldData.countryCode &&
    newData.cityKey === oldData.cityKey &&
    newData.categoryId === oldData.categoryId &&
    newData.caption === oldData.caption &&
    JSON.stringify(newData.hashtags) === JSON.stringify(oldData.hashtags) &&
    newData.needsPhotoVideoRender === oldData.needsPhotoVideoRender &&
    newData.storagePath === oldData.storagePath &&
    newData.storageContentType === oldData.storageContentType &&
    newData.fileSizeBytes === oldData.fileSizeBytes &&
    newData.storageProvider === oldData.storageProvider &&
    newData.sourceUrl === oldData.sourceUrl &&
    newData.durationMs === oldData.durationMs &&
    newData.width === oldData.width &&
    newData.height === oldData.height &&
    newData.visibility === oldData.visibility &&
    newData.musicSourceType === oldData.musicSourceType &&
    newData.musicTitle === oldData.musicTitle &&
    newData.musicStorageAudioPath === oldData.musicStorageAudioPath &&
    newData.musicStorageContentType === oldData.musicStorageContentType &&
    newData.musicFileSizeBytes === oldData.musicFileSizeBytes &&
    newData.musicDurationMs === oldData.musicDurationMs &&
    newData.musicHash === oldData.musicHash &&
    newData.soundOriginAuthorUid === oldData.soundOriginAuthorUid &&
    newData.soundOriginReelId === oldData.soundOriginReelId &&
    newData.thumbnailStoragePath === oldData.thumbnailStoragePath &&
    newData.thumbnailStorageContentType === oldData.thumbnailStorageContentType &&
    newData.thumbnailFileSizeBytes === oldData.thumbnailFileSizeBytes &&
    newData.thumbnailWidth === oldData.thumbnailWidth &&
    newData.thumbnailHeight === oldData.thumbnailHeight &&
    newData.createdAt === oldData.createdAt &&
    newData.publishedAt === oldData.publishedAt &&
    hasOnlyKeys(newData, REEL_BASE_KEYS)
  );
}

/** Mirrors isValidReelPublish (firestore.rules, line ~1595-1649). */
function isValidReelPublish(newData, oldData) {
  return (
    oldData.status === 'uploading' &&
    newData.status === 'published' &&
    oldData.publishedAt === null &&
    isServerTimestampSentinel(newData.publishedAt) &&
    isServerTimestampSentinel(newData.updatedAt) &&
    newData.reelId === oldData.reelId &&
    newData.authorUid === oldData.authorUid &&
    newData.authorDisplayName === oldData.authorDisplayName &&
    newData.authorUsername === oldData.authorUsername &&
    newData.cityName === oldData.cityName &&
    newData.countryCode === oldData.countryCode &&
    newData.cityKey === oldData.cityKey &&
    newData.categoryId === oldData.categoryId &&
    newData.caption === oldData.caption &&
    JSON.stringify(newData.hashtags) === JSON.stringify(oldData.hashtags) &&
    newData.mediaType === oldData.mediaType &&
    oldData.needsPhotoVideoRender === false &&
    newData.needsPhotoVideoRender === false &&
    newData.storagePath === oldData.storagePath &&
    newData.storageContentType === oldData.storageContentType &&
    newData.fileSizeBytes === oldData.fileSizeBytes &&
    newData.storageProvider === oldData.storageProvider &&
    newData.sourceUrl === oldData.sourceUrl &&
    newData.durationMs === oldData.durationMs &&
    newData.width === oldData.width &&
    newData.height === oldData.height &&
    newData.visibility === oldData.visibility &&
    newData.musicSourceType === oldData.musicSourceType &&
    newData.musicTitle === oldData.musicTitle &&
    newData.musicStorageAudioPath === oldData.musicStorageAudioPath &&
    newData.musicStorageContentType === oldData.musicStorageContentType &&
    newData.musicFileSizeBytes === oldData.musicFileSizeBytes &&
    newData.musicDurationMs === oldData.musicDurationMs &&
    newData.musicHash === oldData.musicHash &&
    newData.soundOriginAuthorUid === oldData.soundOriginAuthorUid &&
    newData.soundOriginReelId === oldData.soundOriginReelId &&
    newData.thumbnailStoragePath === oldData.thumbnailStoragePath &&
    newData.thumbnailStorageContentType === oldData.thumbnailStorageContentType &&
    newData.thumbnailFileSizeBytes === oldData.thumbnailFileSizeBytes &&
    newData.thumbnailWidth === oldData.thumbnailWidth &&
    newData.thumbnailHeight === oldData.thumbnailHeight &&
    newData.thumbnailStorageProvider === oldData.thumbnailStorageProvider &&
    newData.thumbnailUrl === oldData.thumbnailUrl &&
    newData.createdAt === oldData.createdAt &&
    hasOnlyKeys(newData, REEL_BASE_KEYS)
  );
}

/** The actual `allow update` clause (firestore.rules line ~1203-1209): author-only, then any ONE of the three transitions. */
function isValidReelUpdate(newData, oldData, requestAuthUid) {
  if (oldData.authorUid !== requestAuthUid) return false;
  return isValidReelPublish(newData, oldData) || isValidReelThumbnailProviderUpdate(newData, oldData) || isValidReelSourceProviderUpdate(newData, oldData);
}

/** Mirrors isValidReelCreate's storageProvider/sourceUrl-relevant subset (firestore.rules line ~1469-1587) — NOT the full image/video size-branch logic, which predates Step 9A and is unrelated to the provider fields this step introduced. */
function isValidReelCreateProviderDefaults(data) {
  return data.storageProvider === 'firebase' && data.sourceUrl === '' && data.thumbnailStorageProvider === 'firebase' && data.thumbnailUrl === '';
}

/** Mirrors the plain `allow read` condition (firestore.rules line ~1187-1188) — included to prove a legacy document (missing storageProvider/sourceUrl entirely) is unaffected, since this predicate never references either field. */
function isValidReelRead(reelData, requestAuthUid, isSignedIn) {
  if (!isSignedIn) return false;
  return reelData.status === 'published' || reelData.authorUid === requestAuthUid;
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

/** A fully-populated, otherwise-legitimate plain-video-no-music Reel document, matching reelBaseKeys() exactly — the baseline every test mutates from. */
function baseReelDoc(overrides = {}) {
  return {
    reelId: 'reel1',
    authorUid: 'uid1',
    authorDisplayName: 'Author',
    authorUsername: 'author',
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: 'se:karlstad',
    categoryId: 'music',
    caption: 'hello',
    hashtags: [],
    mediaType: 'video',
    needsPhotoVideoRender: false,
    storagePath: 'reels/uid1/reel1/source',
    storageContentType: 'video/mp4',
    fileSizeBytes: 1024,
    storageProvider: 'firebase',
    sourceUrl: '',
    durationMs: 5000,
    width: 720,
    height: 1280,
    status: 'uploading',
    visibility: 'city',
    musicSourceType: 'none',
    musicTitle: '',
    musicStorageAudioPath: '',
    musicStorageContentType: '',
    musicFileSizeBytes: 0,
    musicDurationMs: 0,
    musicHash: '',
    soundOriginAuthorUid: '',
    soundOriginReelId: '',
    thumbnailStoragePath: 'reels/uid1/reel1/thumbnail',
    thumbnailStorageContentType: 'image/jpeg',
    thumbnailFileSizeBytes: 2048,
    thumbnailWidth: 720,
    thumbnailHeight: 1280,
    thumbnailStorageProvider: 'firebase',
    thumbnailUrl: '',
    createdAt: 'CREATED_AT_FIXED',
    updatedAt: 'SERVER_TIMESTAMP',
    publishedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. valid Firebase draft creation
// ---------------------------------------------------------------------------
check('create: a fresh draft with storageProvider/sourceUrl at their Firebase defaults passes the provider-defaults check', () => {
  assert.equal(isValidReelCreateProviderDefaults(baseReelDoc()), true);
});
check('create: a draft that already claims storageProvider "r2" is rejected — a client can never create with R2 pre-claimed', () => {
  assert.equal(isValidReelCreateProviderDefaults(baseReelDoc({ storageProvider: 'r2' })), false);
});
check('create: a draft with a non-empty sourceUrl at creation time is rejected', () => {
  assert.equal(isValidReelCreateProviderDefaults(baseReelDoc({ sourceUrl: 'https://cdn.example.com/x' })), false);
});

// ---------------------------------------------------------------------------
// 2. valid source-provider transition: firebase -> r2
// ---------------------------------------------------------------------------
check('source transition: firebase -> r2 with a valid https sourceUrl and only provider/URL/updatedAt changed is ACCEPTED', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/reels/uid1/reel1/source', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), true);
});

// ---------------------------------------------------------------------------
// Step 9B — the SAME transition, now for a Reel with device-picked music —
// the newly-relaxed case.
// ---------------------------------------------------------------------------
check('Step 9B — source transition: firebase -> r2 for a Reel WITH device-picked music is now ACCEPTED', () => {
  const oldData = baseReelDoc({ musicSourceType: 'device', musicTitle: 'Song.mp3', musicStorageAudioPath: 'reels/uid1/reel1/music' });
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/reels/uid1/reel1/source', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), true);
});
check('Step 9B — source transition: an unsupported/unrecognized musicSourceType value is still REJECTED — an allowlist, not a blocklist', () => {
  const oldData = baseReelDoc({ musicSourceType: 'catalog' });
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelSourceProviderUpdate(newData, oldData), false);
});
check('Step 9B — source transition: sneaking a musicSourceType CHANGE into the same write (e.g. "device" -> "none") is REJECTED — music state itself must stay unchanged during this transition', () => {
  const oldData = baseReelDoc({ musicSourceType: 'device', musicTitle: 'Song.mp3', musicStorageAudioPath: 'reels/uid1/reel1/music' });
  const newData = {
    ...oldData,
    storageProvider: 'r2',
    sourceUrl: 'https://media.example.com/x',
    updatedAt: 'SERVER_TIMESTAMP',
    musicSourceType: 'none',
    musicTitle: '',
    musicStorageAudioPath: '',
  };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 3. reject r2 -> firebase (reverse transition never allowed)
// ---------------------------------------------------------------------------
check('source transition: r2 -> firebase is REJECTED — the one-shot guard only ever fires firebase -> r2, never the reverse', () => {
  const oldData = baseReelDoc({ storageProvider: 'r2', sourceUrl: 'https://media.example.com/x' });
  const newData = { ...oldData, storageProvider: 'firebase', sourceUrl: '' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 4. reject changing sourceUrl without a valid provider transition
// ---------------------------------------------------------------------------
check('source transition: sourceUrl changed while storageProvider stays "firebase" is REJECTED — no rule permits sourceUrl to move without the provider flag also moving', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, sourceUrl: 'https://media.example.com/sneaky', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 5. reject simultaneous source + thumbnail provider mutation
// ---------------------------------------------------------------------------
check('simultaneous mutation: flipping BOTH storageProvider and thumbnailStorageProvider to "r2" in ONE write is REJECTED by all three update predicates', () => {
  const oldData = baseReelDoc();
  const newData = {
    ...oldData,
    storageProvider: 'r2',
    sourceUrl: 'https://media.example.com/source',
    thumbnailStorageProvider: 'r2',
    thumbnailUrl: 'https://media.example.com/thumb',
    updatedAt: 'SERVER_TIMESTAMP',
  };
  assert.equal(isValidReelSourceProviderUpdate(newData, oldData), false, 'source-update predicate must reject since thumbnail also changed');
  assert.equal(isValidReelThumbnailProviderUpdate(newData, oldData), false, 'thumbnail-update predicate must reject since source also changed');
  assert.equal(isValidReelPublish(newData, oldData), false);
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false, 'the combined allow-update clause must reject this write entirely');
});

// ---------------------------------------------------------------------------
// 6. reject unrelated field mutation during source-provider confirmation
// ---------------------------------------------------------------------------
check('source transition: a valid provider flip that ALSO sneaks in a caption change is REJECTED', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', caption: 'sneaky edit', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});
check('source transition: a valid provider flip that ALSO changes cityKey is REJECTED', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', cityKey: 'se:stockholm', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});
check('source transition: a valid provider flip that ALSO changes storagePath is REJECTED', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', storagePath: 'reels/uid1/reel1/hacked', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 7. reject provider update after publish
// ---------------------------------------------------------------------------
check('source transition: attempted against an already-published Reel is REJECTED — the one-shot guard requires status "uploading" on both sides', () => {
  const oldData = baseReelDoc({ status: 'published', publishedAt: 'PUBLISHED_AT_FIXED' });
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 8. reject photo Reel
// ---------------------------------------------------------------------------
check('source transition: a photo Reel (mediaType "photo") is REJECTED regardless of music/render fields', () => {
  const oldData = baseReelDoc({ mediaType: 'photo' });
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelSourceProviderUpdate(newData, oldData), false);
});

// ---------------------------------------------------------------------------
// 9. music Reel — Step 9A rejected this outright; Step 9B relaxed it
// (already covered above, right after the plain firebase->r2 case). This
// section keeps ONLY the genuinely-still-rejected variant: an
// unsupported music state (covered above too) — nothing further to add
// here beyond what Step 9B's own dedicated block already tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 10. reject pending photo-render Reel
// ---------------------------------------------------------------------------
check('source transition: a Reel with needsPhotoVideoRender true is REJECTED even though mediaType is already "video"', () => {
  const oldData = baseReelDoc({ needsPhotoVideoRender: true, musicSourceType: 'device' });
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', needsPhotoVideoRender: true, updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelSourceProviderUpdate(newData, oldData), false);
});

// ---------------------------------------------------------------------------
// 11. publish after valid R2 confirmation
// ---------------------------------------------------------------------------
check('publish: a Reel already confirmed as storageProvider "r2" (from an earlier, separate transition) can still publish — isValidReelPublish requires equality, not a fixed provider value', () => {
  const oldData = baseReelDoc({ storageProvider: 'r2', sourceUrl: 'https://media.example.com/x' });
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), true);
});
check('publish: a Reel still on storageProvider "firebase" can also still publish, unaffected by Step 9A', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), true);
});
check('publish: sneaking a storageProvider change INTO the publish write itself is REJECTED — publish requires storageProvider stay byte-identical', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP', storageProvider: 'r2', sourceUrl: 'https://media.example.com/x' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), false);
});
check('Step 9B — publish: a MUSIC Reel already confirmed as storageProvider "r2" AND already carrying a trusted post-mux musicHash (both set by a prior, separate Admin SDK write — muxReelMusic bypasses these Rules entirely, exactly like musicHash always has) can still publish', () => {
  const oldData = baseReelDoc({
    musicSourceType: 'device',
    musicTitle: 'Song.mp3',
    musicStorageAudioPath: 'reels/uid1/reel1/music',
    storageProvider: 'r2',
    sourceUrl: 'https://media.example.com/reels/uid1/reel1/source?v=999',
    musicHash: 'abc123',
    soundOriginAuthorUid: 'uid1',
    soundOriginReelId: 'reel1',
  });
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'uid1'), true);
});

// ---------------------------------------------------------------------------
// 12. legacy reads remain allowed as intended
// ---------------------------------------------------------------------------
check('read: a published legacy Reel document with NO storageProvider/sourceUrl keys at all is still readable by any signed-in user', () => {
  const legacy = baseReelDoc({ status: 'published' });
  delete legacy.storageProvider;
  delete legacy.sourceUrl;
  assert.equal(isValidReelRead(legacy, 'some-other-uid', true), true);
});
check('read: an unauthenticated request is denied regardless of the Reel\'s own fields', () => {
  assert.equal(isValidReelRead(baseReelDoc({ status: 'published' }), 'uid1', false), false);
});
check('read: a still-uploading legacy Reel is only readable by its own author', () => {
  const legacy = baseReelDoc();
  delete legacy.storageProvider;
  delete legacy.sourceUrl;
  assert.equal(isValidReelRead(legacy, 'uid1', true), true);
  assert.equal(isValidReelRead(legacy, 'someone-else', true), false);
});

// ---------------------------------------------------------------------------
// Extra: ownership gate on the combined allow-update clause
// ---------------------------------------------------------------------------
check('update: a valid source transition attempted by a non-author is REJECTED at the ownership gate, before any predicate even runs', () => {
  const oldData = baseReelDoc();
  const newData = { ...oldData, storageProvider: 'r2', sourceUrl: 'https://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidReelUpdate(newData, oldData, 'attacker-uid'), false);
});

console.log('\n=== firestore.rules Reel-provider-transition predicate mirror test results ===');
console.log('NOTE: this is a deterministic mirror, not the real Firestore Rules engine — see this file\'s own top doc comment for the full emulator-unavailability diagnosis.');
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
