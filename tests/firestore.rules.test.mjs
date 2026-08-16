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
import { collection, doc, getDoc, getDocs, runTransaction, serverTimestamp, setDoc } from 'firebase/firestore';

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
