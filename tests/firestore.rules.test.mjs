/**
 * Firestore security rules test suite — runs against the Firebase emulator,
 * using the exact firestore.rules file that gets deployed. Run via:
 *   npm run test:rules
 * (wraps this in `firebase emulators:exec`, so the emulator starts fresh,
 * runs these tests, and shuts down afterward — no data is left behind.)
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  where,
} from 'firebase/firestore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rules = readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
  } catch (error) {
    results.push({ name, pass: false, error });
  }
}

function validUserProfile(uid, usernameLower) {
  return {
    uid,
    email: `${uid}@example.com`,
    displayName: 'Test User',
    username: usernameLower,
    usernameLower,
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: 'se:karlstad',
    interests: ['music'],
    accountType: 'personal',
    onboardingCompleted: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

function usernameReservation(uid) {
  return { uid, createdAt: serverTimestamp() };
}

function contentBase(authorUid, authorDisplayName, authorUsername, contentId, overrides = {}) {
  return {
    contentId,
    authorUid,
    authorDisplayName,
    authorUsername,
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: 'se:karlstad',
    categoryId: 'music',
    status: 'published',
    visibility: 'city',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function validPost(authorUid, authorDisplayName, authorUsername, contentId, overrides = {}) {
  return {
    ...contentBase(authorUid, authorDisplayName, authorUsername, contentId, overrides),
    type: 'post',
    body: 'Hello Around Me!',
    ...overrides,
  };
}

function validActivity(authorUid, authorDisplayName, authorUsername, contentId, overrides = {}) {
  const now = Date.now();
  return {
    ...contentBase(authorUid, authorDisplayName, authorUsername, contentId, overrides),
    type: 'activity',
    title: 'Football tonight',
    description: 'Need 3 more players.',
    placeName: 'Tingvallastadion',
    startsAt: Timestamp.fromMillis(now + 60 * 60 * 1000),
    endsAt: Timestamp.fromMillis(now + 2 * 60 * 60 * 1000),
    ...overrides,
  };
}

function validEvent(authorUid, authorDisplayName, authorUsername, contentId, overrides = {}) {
  const now = Date.now();
  return {
    ...contentBase(authorUid, authorDisplayName, authorUsername, contentId, overrides),
    type: 'event',
    title: 'Live music night',
    description: 'Local band playing tonight.',
    placeName: 'Nöjesfabriken',
    startsAt: Timestamp.fromMillis(now + 60 * 60 * 1000),
    endsAt: Timestamp.fromMillis(now + 3 * 60 * 60 * 1000),
    ...overrides,
  };
}

/** Seeds a users/{uid} profile directly, bypassing rules (already tested above). */
async function seedProfile(testEnv, uid, usernameLower, overrides = {}) {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    await setDoc(doc(adminContext.firestore(), 'users', uid), { ...validUserProfile(uid, usernameLower), ...overrides });
  });
}

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'around-me-rules-test',
    // 127.0.0.1, not 'localhost' — some sandboxes reset IPv6 loopback
    // connections while IPv4 loopback works fine.
    firestore: { rules, host: '127.0.0.1', port: 8080 },
  });

  try {
    // --- ALLOW: authenticated user creates their own profile + username
    // reservation as one atomic transaction (mirrors createInitialUserProfile). ---
    await check('ALLOW: user creates own users/{uid} + usernames/{usernameLower} atomically', async () => {
      const alice = testEnv.authenticatedContext('alice').firestore();
      const userRef = doc(alice, 'users', 'alice');
      const usernameRef = doc(alice, 'usernames', 'alice_handle');

      await assertSucceeds(
        runTransaction(alice, async (tx) => {
          await Promise.all([tx.get(userRef), tx.get(usernameRef)]);
          tx.set(usernameRef, usernameReservation('alice'));
          tx.set(userRef, validUserProfile('alice', 'alice_handle'));
        })
      );

      const savedProfile = await getDoc(userRef);
      assert.equal(savedProfile.exists(), true);
      const savedUsername = await getDoc(usernameRef);
      assert.equal(savedUsername.exists(), true);
    });

    // --- DENY: unauthenticated user attempts to create a profile. ---
    await check('DENY: unauthenticated profile create', async () => {
      const anon = testEnv.unauthenticatedContext().firestore();
      await assertFails(setDoc(doc(anon, 'users', 'ghost'), validUserProfile('ghost', 'ghost_handle')));
    });

    // --- DENY: user A creates users/{userB's uid}. ---
    await check('DENY: user A writes users/{userB}', async () => {
      const alice = testEnv.authenticatedContext('alice').firestore();
      await assertFails(setDoc(doc(alice, 'users', 'bob'), validUserProfile('bob', 'bob_handle')));
    });

    // --- DENY: user A reserves a username doc whose stored uid is user B's. ---
    await check('DENY: user A reserves username with uid belonging to user B', async () => {
      const alice = testEnv.authenticatedContext('alice').firestore();
      await assertFails(setDoc(doc(alice, 'usernames', 'spoofed_handle'), usernameReservation('bob')));
    });

    // --- DENY: a second user reserves an already-existing username. ---
    await check('DENY: second user reserves an already-taken username', async () => {
      // 'alice_handle' was already reserved by alice in the first test above.
      const bob = testEnv.authenticatedContext('bob').firestore();
      await assertFails(setDoc(doc(bob, 'usernames', 'alice_handle'), usernameReservation('bob')));
    });

    // --- DENY: malformed user profile (wrong type / missing required field). ---
    await check('DENY: malformed user profile', async () => {
      const carol = testEnv.authenticatedContext('carol').firestore();
      const malformed = { ...validUserProfile('carol', 'carol_handle'), interests: 'not-a-list' };
      await assertFails(setDoc(doc(carol, 'users', 'carol'), malformed));
    });

    // --- DENY: listing the usernames collection (enumeration). ---
    await check('DENY: list usernames collection', async () => {
      const bob = testEnv.authenticatedContext('bob').firestore();
      await assertFails(getDocs(collection(bob, 'usernames')));
    });

    // --- ALLOW: signed-in user can get a specific username doc to check availability. ---
    await check('ALLOW: get a single username doc to check availability', async () => {
      const bob = testEnv.authenticatedContext('bob').firestore();
      await assertSucceeds(getDoc(doc(bob, 'usernames', 'alice_handle')));
    });

    // =========================================================================
    // content/{contentId} — posts, activities, events
    // alice's profile already exists from the tests above (displayName
    // 'Test User', username 'alice_handle', Karlstad). Seed bob and erin
    // (a different city) with distinct displayNames so spoofing tests are
    // meaningful, not accidentally identical strings.
    // =========================================================================
    await seedProfile(testEnv, 'bob', 'bob_handle', { displayName: 'Bob Bobsson' });
    await seedProfile(testEnv, 'erin', 'erin_handle', {
      displayName: 'Erin Ericsson',
      cityName: 'Stockholm',
      cityKey: 'se:stockholm',
    });

    const alice = testEnv.authenticatedContext('alice').firestore();
    const bob = testEnv.authenticatedContext('bob').firestore();
    const anon = testEnv.unauthenticatedContext().firestore();

    await check('ALLOW: completed user creates a valid Post', async () => {
      await assertSucceeds(
        setDoc(doc(alice, 'content', 'post-alice-1'), validPost('alice', 'Test User', 'alice_handle', 'post-alice-1'))
      );
    });

    await check('ALLOW: completed user creates a valid Activity', async () => {
      await assertSucceeds(
        setDoc(
          doc(alice, 'content', 'activity-alice-1'),
          validActivity('alice', 'Test User', 'alice_handle', 'activity-alice-1')
        )
      );
    });

    await check('ALLOW: completed user creates a valid Event', async () => {
      await assertSucceeds(
        setDoc(doc(alice, 'content', 'event-alice-1'), validEvent('alice', 'Test User', 'alice_handle', 'event-alice-1'))
      );
    });

    await check('ALLOW: authenticated user reads published content', async () => {
      await assertSucceeds(getDoc(doc(bob, 'content', 'post-alice-1')));
    });

    await check('ALLOW: authenticated user lists published city content', async () => {
      const cityFeedQuery = query(
        collection(bob, 'content'),
        where('cityKey', '==', 'se:karlstad'),
        where('status', '==', 'published')
      );
      const snapshot = await assertSucceeds(getDocs(cityFeedQuery));
      assert.ok(snapshot.size >= 3);
    });

    await check('DENY: unauthenticated create', async () => {
      await assertFails(
        setDoc(doc(anon, 'content', 'post-anon-1'), validPost('ghost', 'Ghost', 'ghost_handle', 'post-anon-1'))
      );
    });

    await check('DENY: unauthenticated read (get)', async () => {
      await assertFails(getDoc(doc(anon, 'content', 'post-alice-1')));
    });

    await check('DENY: unauthenticated read (list)', async () => {
      await assertFails(getDocs(collection(anon, 'content')));
    });

    await check('DENY: user creates content with another user\'s UID', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'post-spoof-uid'), validPost('alice', 'Bob Bobsson', 'bob_handle', 'post-spoof-uid'))
      );
    });

    await check('DENY: user spoofs another username', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-spoof-username'),
          validPost('bob', 'Bob Bobsson', 'alice_handle', 'post-spoof-username')
        )
      );
    });

    await check('DENY: user spoofs displayName', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-spoof-name'),
          validPost('bob', 'Test User', 'bob_handle', 'post-spoof-name')
        )
      );
    });

    await check('DENY: user posts with a different cityKey than their own profile', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-spoof-city'),
          validPost('bob', 'Bob Bobsson', 'bob_handle', 'post-spoof-city', {
            cityName: 'Stockholm',
            cityKey: 'se:stockholm',
          })
        )
      );
    });

    await check('DENY: user with no profile creates content', async () => {
      const dave = testEnv.authenticatedContext('dave').firestore();
      await assertFails(
        setDoc(doc(dave, 'content', 'post-dave-1'), validPost('dave', 'Dave', 'dave_handle', 'post-dave-1'))
      );
    });

    await check('DENY: malformed Post (missing body)', async () => {
      const malformed = validPost('alice', 'Test User', 'alice_handle', 'post-malformed-1');
      delete malformed.body;
      await assertFails(setDoc(doc(alice, 'content', 'post-malformed-1'), malformed));
    });

    await check('DENY: malformed Activity (missing placeName)', async () => {
      const malformed = validActivity('alice', 'Test User', 'alice_handle', 'activity-malformed-1');
      delete malformed.placeName;
      await assertFails(setDoc(doc(alice, 'content', 'activity-malformed-1'), malformed));
    });

    await check('DENY: malformed Event (description wrong type)', async () => {
      const malformed = validEvent('alice', 'Test User', 'alice_handle', 'event-malformed-1', { description: 42 });
      await assertFails(setDoc(doc(alice, 'content', 'event-malformed-1'), malformed));
    });

    await check('DENY: invalid content type', async () => {
      const malformed = { ...validPost('alice', 'Test User', 'alice_handle', 'post-bad-type'), type: 'poll' };
      await assertFails(setDoc(doc(alice, 'content', 'post-bad-type'), malformed));
    });

    await check('DENY: invalid timestamps (startsAt >= endsAt)', async () => {
      const now = Timestamp.now();
      const malformed = validActivity('alice', 'Test User', 'alice_handle', 'activity-bad-times', {
        startsAt: now,
        endsAt: now,
      });
      await assertFails(setDoc(doc(alice, 'content', 'activity-bad-times'), malformed));
    });

    await check('ALLOW: second author creates their own valid Post (setup for delete tests)', async () => {
      await assertSucceeds(
        setDoc(doc(bob, 'content', 'post-bob-1'), validPost('bob', 'Bob Bobsson', 'bob_handle', 'post-bob-1'))
      );
    });

    await check('DENY: user deletes another user\'s content', async () => {
      await assertFails(deleteDoc(doc(alice, 'content', 'post-bob-1')));
    });

    await check('DENY: unauthenticated delete', async () => {
      await assertFails(deleteDoc(doc(anon, 'content', 'post-bob-1')));
    });

    await check('ALLOW: author deletes their own content', async () => {
      await assertSucceeds(deleteDoc(doc(alice, 'content', 'post-alice-1')));
    });

    await testEnv.clearFirestore();
  } finally {
    await testEnv.cleanup();
  }

  console.log('\n=== Firestore rules test results ===');
  let failures = 0;
  for (const result of results) {
    if (result.pass) {
      console.log(`PASS — ${result.name}`);
    } else {
      failures += 1;
      console.log(`FAIL — ${result.name}`);
      console.log(`       ${result.error?.message ?? result.error}`);
    }
  }
  console.log(`\n${results.length - failures}/${results.length} passed.`);

  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Test run crashed:', error);
  process.exit(1);
});
