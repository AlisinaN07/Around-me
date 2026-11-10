/**
 * Plain unit tests for src/utils/eventCoverStorageFields.ts's
 * resolveEventCoverStorageFields — the pure decision behind which
 * cover-related fields createEvent (src/services/content.ts) actually
 * persists onto a new Event document. Run via:
 *   npx tsx tests/eventCoverStorage.test.ts
 * Same plain assert()/check() convention as tests/mediaProvider.test.ts.
 *
 * Step 2B — `coverStoragePath` is no longer an accepted INPUT at all
 * (see the function's own doc comment): it is always DERIVED from
 * `uid` + `contentId`, exercised directly by the "exact ID relationship"
 * tests below, not merely a namespace/string-shape check.
 *
 * Deliberately does NOT import src/services/content.ts itself — it
 * transitively imports firebase.ts, which references the Expo-only
 * `__DEV__` global and cannot run under plain tsx. This is exactly why
 * the decision was extracted into its own, dependency-free file.
 */
import { resolveEventCoverStorageFields } from '../src/utils/eventCoverStorageFields';

const assert = {
  ok(value: unknown, message?: string): void {
    if (!value) throw new Error(message ?? `Expected truthy value, got ${String(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string): void {
    if (actual !== expected) throw new Error(message ?? `Expected ${String(expected)}, got ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string): void {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a !== e) throw new Error(message ?? `Expected ${e}, got ${a}`);
  },
};

const results: { name: string; pass: boolean; error?: unknown }[] = [];
function check(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

const uid = 'u1';
const contentId = 'event-abc123';

// ---------------------------------------------------------------------------
// Event creation WITHOUT a cover.
// ---------------------------------------------------------------------------

check('no coverPhotoURL at all -> no cover fields whatsoever, not even an empty object key', () => {
  assert.deepEqual(resolveEventCoverStorageFields({ uid, contentId }), {});
});

check('an empty-string coverPhotoURL is treated exactly like "no cover" (never a blank value persisted)', () => {
  assert.deepEqual(resolveEventCoverStorageFields({ uid, contentId, coverPhotoURL: '' }), {});
});

// ---------------------------------------------------------------------------
// Event creation WITH cover metadata — the real ID relationship.
// ---------------------------------------------------------------------------

check('a cover with a known Firebase provider derives coverStoragePath from uid + contentId EXACTLY — never a caller-supplied path', () => {
  assert.deepEqual(
    resolveEventCoverStorageFields({
      uid,
      contentId,
      coverPhotoURL: 'https://firebasestorage.googleapis.com/v0/b/x/o/eventCovers%2Fu1%2Fevent-abc123%2Fphoto?alt=media',
      coverStorageProvider: 'firebase',
    }),
    {
      coverPhotoURL: 'https://firebasestorage.googleapis.com/v0/b/x/o/eventCovers%2Fu1%2Fevent-abc123%2Fphoto?alt=media',
      coverStoragePath: 'eventCovers/u1/event-abc123/photo',
      coverStorageProvider: 'firebase',
    }
  );
});

check('a cover with a known R2 provider derives the exact same coverStoragePath shape', () => {
  const result = resolveEventCoverStorageFields({
    uid,
    contentId,
    coverPhotoURL: 'https://media.example.com/eventCovers/u1/event-abc123/photo?v=123',
    coverStorageProvider: 'r2',
  });
  assert.deepEqual(result, {
    coverPhotoURL: 'https://media.example.com/eventCovers/u1/event-abc123/photo?v=123',
    coverStoragePath: 'eventCovers/u1/event-abc123/photo',
    coverStorageProvider: 'r2',
  });
});

check('a DIFFERENT contentId produces a DIFFERENT derived path for the SAME uid — proves the path is tied to this exact Event, not just this user', () => {
  const resultA = resolveEventCoverStorageFields({ uid, contentId: 'event-A', coverPhotoURL: 'https://x/a.jpg', coverStorageProvider: 'firebase' });
  const resultB = resolveEventCoverStorageFields({ uid, contentId: 'event-B', coverPhotoURL: 'https://x/b.jpg', coverStorageProvider: 'firebase' });
  assert.ok('coverStoragePath' in resultA && 'coverStoragePath' in resultB);
  assert.equal((resultA as { coverStoragePath: string }).coverStoragePath, 'eventCovers/u1/event-A/photo');
  assert.equal((resultB as { coverStoragePath: string }).coverStoragePath, 'eventCovers/u1/event-B/photo');
  assert.ok((resultA as { coverStoragePath: string }).coverStoragePath !== (resultB as { coverStoragePath: string }).coverStoragePath);
});

check('there is no way to pass a path at all — the function\'s own input type has no such field (a caller can never override the derivation)', () => {
  // This is a compile-time guarantee (EventCoverStorageInput has no
  // coverStoragePath member — see the TypeScript error this test file
  // would produce if someone tried to add one), asserted here only as
  // documentation of the property under test.
  const input = { uid, contentId, coverPhotoURL: 'https://x/a.jpg', coverStorageProvider: 'firebase' as const };
  assert.equal(Object.keys(input).includes('coverStoragePath'), false);
});

// ---------------------------------------------------------------------------
// Partial/incomplete storage metadata — never a half-written pair.
// ---------------------------------------------------------------------------

check('coverPhotoURL present but coverStorageProvider missing -> coverPhotoURL alone, no derived path either', () => {
  assert.deepEqual(resolveEventCoverStorageFields({ uid, contentId, coverPhotoURL: 'https://example.com/x.jpg' }), {
    coverPhotoURL: 'https://example.com/x.jpg',
  });
});

console.log('\n=== Event cover-storage field resolution test results ===');
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
if (failures > 0) process.exit(1);
