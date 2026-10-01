/**
 * Step 10A — DETERMINISTIC MIRROR of firestore.rules' own Story
 * provider-transition predicate (isValidStoryProviderUpdate) plus the
 * surrounding isValidStoryCreate/isValidStoryPublish/allow-update logic
 * it now shares a disjunct with, reimplemented here as plain JS functions
 * and tested against fixtures — same reasoning and same real-emulator
 * limitation as test-reel-rules-predicates.cjs's own top doc comment
 * (the Firestore emulator still cannot run `loadFirestoreRules` under
 * `emulators:exec` in this sandbox — see that file for the full
 * diagnosis). THIS FILE IS NOT A SUBSTITUTE for a real emulator run — a
 * mismatch between this file and firestore.rules' own text is a real
 * risk this file cannot catch on its own.
 */
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Plain JS mirror of firestore.rules' storyBaseKeys().
// ---------------------------------------------------------------------------
const STORY_BASE_KEYS = [
  'storyId', 'authorUid', 'authorDisplayName', 'authorUsername',
  'mediaType', 'storagePath', 'storageContentType', 'fileSizeBytes',
  'durationMs', 'width', 'height', 'status',
  'storageProvider', 'mediaUrl', 'sourceNormalized',
  'createdAt', 'updatedAt', 'publishedAt', 'expiresAt',
];

function hasOnlyKeys(data, allowed) {
  return Object.keys(data).every((k) => allowed.includes(k));
}
function isServerTimestampSentinel(value) {
  return value === 'SERVER_TIMESTAMP';
}

/** Mirrors isValidStoryCreate's provider-relevant subset (firestore.rules) — NOT the full image/video size-branch logic, which predates Step 10A and is unrelated to the provider fields this step introduced. */
function isValidStoryCreateProviderDefaults(data) {
  return data.storageProvider === 'firebase' && data.mediaUrl === '' && data.sourceNormalized === false;
}

/** Mirrors isValidStoryPublish (firestore.rules). */
function isValidStoryPublish(newData, oldData) {
  return (
    oldData.status === 'uploading' &&
    newData.status === 'published' &&
    oldData.publishedAt === null &&
    isServerTimestampSentinel(newData.publishedAt) &&
    isServerTimestampSentinel(newData.updatedAt) &&
    newData.storyId === oldData.storyId &&
    newData.authorUid === oldData.authorUid &&
    newData.authorDisplayName === oldData.authorDisplayName &&
    newData.authorUsername === oldData.authorUsername &&
    newData.mediaType === oldData.mediaType &&
    // Step 11C — a VIDEO Story can never publish until finalizeStoryVideo
    // has stamped sourceNormalized: true (an Admin SDK write, bypassing
    // these Rules entirely). A PHOTO Story is exempt — never transcoded
    // at all (Part 4 of the Step 11C spec).
    (oldData.mediaType === 'photo' || oldData.sourceNormalized === true) &&
    newData.sourceNormalized === oldData.sourceNormalized &&
    newData.storagePath === oldData.storagePath &&
    newData.storageContentType === oldData.storageContentType &&
    newData.fileSizeBytes === oldData.fileSizeBytes &&
    newData.durationMs === oldData.durationMs &&
    newData.width === oldData.width &&
    newData.height === oldData.height &&
    newData.storageProvider === oldData.storageProvider &&
    newData.mediaUrl === oldData.mediaUrl &&
    newData.createdAt === oldData.createdAt &&
    hasOnlyKeys(newData, STORY_BASE_KEYS)
  );
}

/** Mirrors isValidStoryProviderUpdate (firestore.rules, Step 10A). */
function isValidStoryProviderUpdate(newData, oldData) {
  return (
    oldData.status === 'uploading' &&
    newData.status === 'uploading' &&
    oldData.storageProvider === 'firebase' &&
    newData.storageProvider === 'r2' &&
    typeof newData.mediaUrl === 'string' &&
    newData.mediaUrl.length > 0 &&
    newData.mediaUrl.length <= 2048 &&
    /^https:\/\//.test(newData.mediaUrl) &&
    isServerTimestampSentinel(newData.updatedAt) &&
    newData.storyId === oldData.storyId &&
    newData.authorUid === oldData.authorUid &&
    newData.authorDisplayName === oldData.authorDisplayName &&
    newData.authorUsername === oldData.authorUsername &&
    newData.mediaType === oldData.mediaType &&
    newData.storagePath === oldData.storagePath &&
    newData.storageContentType === oldData.storageContentType &&
    newData.fileSizeBytes === oldData.fileSizeBytes &&
    newData.durationMs === oldData.durationMs &&
    newData.width === oldData.width &&
    newData.height === oldData.height &&
    newData.sourceNormalized === oldData.sourceNormalized &&
    newData.publishedAt === oldData.publishedAt &&
    newData.expiresAt === oldData.expiresAt &&
    newData.createdAt === oldData.createdAt &&
    hasOnlyKeys(newData, STORY_BASE_KEYS)
  );
}

/** The actual `allow update` clause: author-only, then either transition. */
function isValidStoryUpdate(newData, oldData, requestAuthUid) {
  if (oldData.authorUid !== requestAuthUid) return false;
  return isValidStoryPublish(newData, oldData) || isValidStoryProviderUpdate(newData, oldData);
}

/** The actual `allow delete` clause — author-only, no status constraint at all (unlike a Reel). */
function isValidStoryDelete(oldData, requestAuthUid) {
  return oldData.authorUid === requestAuthUid;
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

/** A fully-populated, otherwise-legitimate plain-video-no-music Story document, matching storyBaseKeys() exactly. */
function baseStoryDoc(overrides = {}) {
  return {
    storyId: 'story1',
    authorUid: 'uid1',
    authorDisplayName: 'Author',
    authorUsername: 'author',
    mediaType: 'video',
    storagePath: 'stories/uid1/story1/source',
    storageContentType: 'video/mp4',
    fileSizeBytes: 1024,
    durationMs: 5000,
    width: 720,
    height: 1280,
    status: 'uploading',
    storageProvider: 'firebase',
    mediaUrl: '',
    sourceNormalized: false,
    createdAt: 'CREATED_AT_FIXED',
    updatedAt: 'SERVER_TIMESTAMP',
    publishedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. valid Firebase draft creation
// ---------------------------------------------------------------------------
check('create: a fresh draft with storageProvider/mediaUrl at their Firebase defaults passes the provider-defaults check', () => {
  assert.equal(isValidStoryCreateProviderDefaults(baseStoryDoc()), true);
});
check('create: a draft that already claims storageProvider "r2" is rejected — a client can never create with R2 pre-claimed', () => {
  assert.equal(isValidStoryCreateProviderDefaults(baseStoryDoc({ storageProvider: 'r2' })), false);
});
check('create: a draft with a non-empty mediaUrl at creation time is rejected', () => {
  assert.equal(isValidStoryCreateProviderDefaults(baseStoryDoc({ mediaUrl: 'https://cdn.example.com/x' })), false);
});

// ---------------------------------------------------------------------------
// 2. valid provider transition: firebase -> r2
// ---------------------------------------------------------------------------
check('provider transition: firebase -> r2 with a valid https mediaUrl and only provider/URL/updatedAt changed is ACCEPTED', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'https://media.example.com/stories/uid1/story1/source', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), true);
});

check('provider transition: works identically for a photo Story', () => {
  const oldData = baseStoryDoc({ mediaType: 'photo', storageContentType: 'image/jpeg', durationMs: 0 });
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'https://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), true);
});

// ---------------------------------------------------------------------------
// 3. reject r2 -> firebase (reverse transition never allowed)
// ---------------------------------------------------------------------------
check('provider transition: r2 -> firebase is REJECTED — the one-shot guard only ever fires firebase -> r2, never the reverse', () => {
  const oldData = baseStoryDoc({ storageProvider: 'r2', mediaUrl: 'https://media.example.com/x' });
  const newData = { ...oldData, storageProvider: 'firebase', mediaUrl: '' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 4. reject changing mediaUrl without a provider transition
// ---------------------------------------------------------------------------
check('provider transition: mediaUrl changed while storageProvider stays "firebase" is REJECTED', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, mediaUrl: 'https://media.example.com/sneaky', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 5. reject unrelated field mutation during provider confirmation
// ---------------------------------------------------------------------------
check('provider transition: a valid provider flip that ALSO sneaks in a mediaType change is REJECTED', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'https://media.example.com/x', mediaType: 'photo', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});
check('provider transition: a valid provider flip that ALSO changes storagePath is REJECTED', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'https://media.example.com/x', storagePath: 'stories/uid1/story1/hacked', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});
check('provider transition: sneaking status to "published" IN THE SAME write as the provider flip is REJECTED — these are two separate, narrow transitions, never combined', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'https://media.example.com/x', status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 6. reject provider update after publish
// ---------------------------------------------------------------------------
check('provider transition: attempted against an already-published Story is REJECTED — requires status "uploading" on both sides', () => {
  const oldData = baseStoryDoc({ status: 'published', publishedAt: 'PUBLISHED_AT_FIXED', expiresAt: 'EXPIRES_AT_FIXED' });
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'https://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 7. mediaUrl shape validation
// ---------------------------------------------------------------------------
check('provider transition: an empty mediaUrl is REJECTED even with storageProvider correctly flipped', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: '', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryProviderUpdate(newData, oldData), false);
});
check('provider transition: a non-https mediaUrl is REJECTED', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'http://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryProviderUpdate(newData, oldData), false);
});

// ---------------------------------------------------------------------------
// 8. publish after valid R2 confirmation
// ---------------------------------------------------------------------------
check('publish: a Story already confirmed as storageProvider "r2" (from an earlier, separate transition) can still publish', () => {
  // Step 11C — finalizeStoryVideo already ran for this direct video Story.
  const oldData = baseStoryDoc({ storageProvider: 'r2', mediaUrl: 'https://media.example.com/x', sourceNormalized: true });
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP', expiresAt: 'EXPIRES_AT_FIXED' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), true);
});
check('publish: a Story still on storageProvider "firebase" can also still publish, unaffected by Step 10A', () => {
  const oldData = baseStoryDoc({ sourceNormalized: true });
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP', expiresAt: 'EXPIRES_AT_FIXED' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), true);
});
check('publish: sneaking a storageProvider change INTO the publish write itself is REJECTED — publish requires storageProvider stay byte-identical', () => {
  const oldData = baseStoryDoc({ sourceNormalized: true });
  const newData = {
    ...oldData,
    status: 'published',
    publishedAt: 'SERVER_TIMESTAMP',
    updatedAt: 'SERVER_TIMESTAMP',
    expiresAt: 'EXPIRES_AT_FIXED',
    storageProvider: 'r2',
    mediaUrl: 'https://media.example.com/x',
  };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// Step 11C — the universal video normalization publish gate.
// ---------------------------------------------------------------------------

check('Step 11C — create: a draft that already claims sourceNormalized true is rejected', () => {
  assert.equal(isValidStoryCreateProviderDefaults(baseStoryDoc({ sourceNormalized: true })), false);
});

check('Step 11C — publish: a VIDEO Story still at sourceNormalized false is REJECTED — it must be finalized first', () => {
  const oldData = baseStoryDoc(); // sourceNormalized: false (the default)
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP', expiresAt: 'EXPIRES_AT_FIXED' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

check('Step 11C — publish: the SAME VIDEO Story, once sourceNormalized flips to true (finalizeStoryVideo\'s own Admin SDK write), can now publish', () => {
  const oldData = baseStoryDoc({ sourceNormalized: true });
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP', expiresAt: 'EXPIRES_AT_FIXED' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), true);
});

check('Step 11C — publish: a PHOTO Story can publish while sourceNormalized is still false — exempt from the gate entirely', () => {
  const oldData = baseStoryDoc({ mediaType: 'photo', storageContentType: 'image/jpeg', durationMs: 0 }); // sourceNormalized: false (default)
  assert.equal(oldData.sourceNormalized, false);
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP', expiresAt: 'EXPIRES_AT_FIXED' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), true);
});

check('Step 11C — publish: sneaking a sourceNormalized flip (false -> true) INTO the publish write itself is REJECTED — must already be done by a separate prior Admin SDK write', () => {
  const oldData = baseStoryDoc({ sourceNormalized: false });
  const newData = { ...oldData, status: 'published', publishedAt: 'SERVER_TIMESTAMP', updatedAt: 'SERVER_TIMESTAMP', expiresAt: 'EXPIRES_AT_FIXED', sourceNormalized: true };
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

check('Step 11C — sneaking a sourceNormalized change into an UNRELATED transition (the provider confirm) is REJECTED', () => {
  const oldData = baseStoryDoc();
  const newData = {
    ...oldData,
    storageProvider: 'r2',
    mediaUrl: 'https://media.example.com/x',
    sourceNormalized: true,
    updatedAt: 'SERVER_TIMESTAMP',
  };
  assert.equal(isValidStoryProviderUpdate(newData, oldData), false);
  assert.equal(isValidStoryUpdate(newData, oldData, 'uid1'), false);
});

// ---------------------------------------------------------------------------
// 9. ownership gate
// ---------------------------------------------------------------------------
check('update: a valid provider transition attempted by a non-author is REJECTED at the ownership gate, before any predicate even runs', () => {
  const oldData = baseStoryDoc();
  const newData = { ...oldData, storageProvider: 'r2', mediaUrl: 'https://media.example.com/x', updatedAt: 'SERVER_TIMESTAMP' };
  assert.equal(isValidStoryUpdate(newData, oldData, 'attacker-uid'), false);
});

// ---------------------------------------------------------------------------
// 10. delete — author-only, any status, mixed provider
// ---------------------------------------------------------------------------
check('delete: the author can delete a still-uploading Firebase Story draft', () => {
  assert.equal(isValidStoryDelete(baseStoryDoc(), 'uid1'), true);
});
check('delete: the author can delete an already-published R2 Story', () => {
  const published = baseStoryDoc({ status: 'published', storageProvider: 'r2', mediaUrl: 'https://media.example.com/x' });
  assert.equal(isValidStoryDelete(published, 'uid1'), true);
});
check('delete: a non-author can never delete someone else\'s Story, regardless of status or provider', () => {
  assert.equal(isValidStoryDelete(baseStoryDoc({ status: 'published' }), 'attacker-uid'), false);
});

console.log('\n=== firestore.rules Story-provider-transition predicate mirror test results ===');
console.log('NOTE: this is a deterministic mirror, not the real Firestore Rules engine — see test-reel-rules-predicates.cjs\'s own top doc comment for the full emulator-unavailability diagnosis.');
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
