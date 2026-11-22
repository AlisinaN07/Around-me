/**
 * Step 5B/5C — plain-Node tests for the pure, media-kind-agnostic URL
 * construction logic in functions/src/media/mediaUrl.ts: buildMediaUrl.
 * Runs against the COMPILED lib/ output — `npm run build` first (see the
 * `test` script in package.json).
 *
 * Covers: correct joining, absent/malformed base URL, malformed path
 * rejection, and the cache-busting property (two different versions of
 * the SAME object produce two different URLs — the whole point of the
 * `?v=` query string, per this feature's own report on why Option B
 * — stable path + version query string — was chosen over versioned
 * object keys or a CDN cache-purge call). Exercised with both
 * profilePhotos/ and profileCovers/ paths — the function itself has no
 * media-kind awareness at all, so this also proves it works unchanged
 * for the media kind Step 5C added.
 */
const assert = require('node:assert/strict');
const { buildMediaUrl } = require('../lib/media/mediaUrl.js');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const BASE = 'https://media.example.com';
const PATH = 'profilePhotos/uid-1/photo';

// ---------------------------------------------------------------------------
// Correct joining.
// ---------------------------------------------------------------------------

check('joins base URL, path, and version into the expected shape', () => {
  assert.equal(buildMediaUrl(BASE, PATH, 1700000000000), 'https://media.example.com/profilePhotos/uid-1/photo?v=1700000000000');
});

check('strips a trailing slash on the base URL before joining', () => {
  assert.equal(buildMediaUrl('https://media.example.com/', PATH, 5), 'https://media.example.com/profilePhotos/uid-1/photo?v=5');
});

check('strips multiple trailing slashes on the base URL', () => {
  assert.equal(buildMediaUrl('https://media.example.com///', PATH, 5), 'https://media.example.com/profilePhotos/uid-1/photo?v=5');
});

// ---------------------------------------------------------------------------
// Cache-busting — the actual property this whole file exists to prove:
// the SAME object path, at two different versions, is two different URLs.
// This is what makes both Cloudflare's edge cache and expo-image's own
// memory/disk cache (which keys on the full URL) serve fresh content
// after a profile photo is replaced, with no versioned object key and no
// CDN cache-purge call needed.
// ---------------------------------------------------------------------------

check('two different versions of the same path produce two different URLs', () => {
  const first = buildMediaUrl(BASE, PATH, 1);
  const second = buildMediaUrl(BASE, PATH, 2);
  assert.notEqual(first, second);
});

check('the same version of the same path is deterministic (same URL every time)', () => {
  assert.equal(buildMediaUrl(BASE, PATH, 42), buildMediaUrl(BASE, PATH, 42));
});

check('different uids produce different URLs at the same version (user isolation)', () => {
  const a = buildMediaUrl(BASE, 'profilePhotos/uid-a/photo', 1);
  const b = buildMediaUrl(BASE, 'profilePhotos/uid-b/photo', 1);
  assert.notEqual(a, b);
});

check('works identically for a profileCovers/ path — the function has no media-kind awareness of its own', () => {
  assert.equal(
    buildMediaUrl(BASE, 'profileCovers/uid-1/photo', 1700000000000),
    'https://media.example.com/profileCovers/uid-1/photo?v=1700000000000'
  );
});

check('a profilePhoto URL and a profileCover URL for the SAME uid are distinct (different object paths)', () => {
  const photo = buildMediaUrl(BASE, 'profilePhotos/uid-1/photo', 1);
  const cover = buildMediaUrl(BASE, 'profileCovers/uid-1/photo', 1);
  assert.notEqual(photo, cover);
});

// ---------------------------------------------------------------------------
// Absent/malformed public media base URL — the exact "no delivery
// configured yet" case this feature's own report requires: never
// fabricate a URL, return null instead.
// ---------------------------------------------------------------------------

check('returns null for an empty base URL', () => {
  assert.equal(buildMediaUrl('', PATH, 1), null);
});

check('returns null for a non-https base URL (http, not https)', () => {
  assert.equal(buildMediaUrl('http://media.example.com', PATH, 1), null);
});

check('returns null for a bare hostname with no scheme', () => {
  assert.equal(buildMediaUrl('media.example.com', PATH, 1), null);
});

check('returns null for a non-string base URL', () => {
  assert.equal(buildMediaUrl(null, PATH, 1), null);
  assert.equal(buildMediaUrl(undefined, PATH, 1), null);
});

// ---------------------------------------------------------------------------
// Malformed path rejection — defense in depth even though the real
// caller (requestMediaUploadAuthorization.ts) only ever passes an
// already-safe, server-derived path from objectKey.ts.
// ---------------------------------------------------------------------------

check('returns null for an empty path', () => {
  assert.equal(buildMediaUrl(BASE, '', 1), null);
});

check('returns null for a path with a leading slash (would collide with the base URL\'s own path)', () => {
  assert.equal(buildMediaUrl(BASE, '/profilePhotos/uid-1/photo', 1), null);
});

check('returns null for a path attempting parent-directory traversal', () => {
  assert.equal(buildMediaUrl(BASE, '../etc/passwd', 1), null);
  assert.equal(buildMediaUrl(BASE, 'profilePhotos/../other-uid/photo', 1), null);
});

check('returns null for a path attempting protocol/absolute-URL injection', () => {
  assert.equal(buildMediaUrl(BASE, 'https://evil.example.com/x', 1), null);
  assert.equal(buildMediaUrl(BASE, '//evil.example.com/x', 1), null);
});

check('returns null for a path containing whitespace', () => {
  assert.equal(buildMediaUrl(BASE, 'profile Photos/uid-1/photo', 1), null);
});

check('returns null for a non-string path', () => {
  assert.equal(buildMediaUrl(BASE, null, 1), null);
});

// ---------------------------------------------------------------------------
// Malformed/invalid version.
// ---------------------------------------------------------------------------

check('returns null for a zero or negative version', () => {
  assert.equal(buildMediaUrl(BASE, PATH, 0), null);
  assert.equal(buildMediaUrl(BASE, PATH, -1), null);
});

check('returns null for a non-finite version', () => {
  assert.equal(buildMediaUrl(BASE, PATH, Infinity), null);
  assert.equal(buildMediaUrl(BASE, PATH, NaN), null);
});

console.log('\n=== functions/ media URL construction logic test results ===');
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
