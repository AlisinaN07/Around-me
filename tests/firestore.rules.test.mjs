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
  getCountFromServer,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
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

function validParticipant(uid, displayName, username, overrides = {}) {
  return { uid, displayName, username, joinedAt: serverTimestamp(), ...overrides };
}

function statsDoc(count) {
  return { participantCount: count, updatedAt: serverTimestamp() };
}

function validResponse(uid, displayName, username, status, overrides = {}) {
  return { uid, displayName, username, status, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...overrides };
}

/** Mirrors the real joinActivity transaction: participant create + stats increment, atomically. */
function joinTransaction(db, activityId, uid, displayName, username, nextCount) {
  const participantRef = doc(db, 'content', activityId, 'participants', uid);
  const statsRef = doc(db, 'content', activityId, 'stats', 'activity');
  return runTransaction(db, async (tx) => {
    await Promise.all([tx.get(participantRef), tx.get(statsRef)]);
    tx.set(participantRef, validParticipant(uid, displayName, username));
    tx.set(statsRef, statsDoc(nextCount));
  });
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

    // =========================================================================
    // content/{activityId}/participants/{uid} + stats/activity
    // Reuses 'activity-alice-1' (created above, future start/end, no cap) for
    // the main join/read/leave flow. Dedicated fresh activities are used for
    // tests that need a specific, uncontaminated participant count.
    // =========================================================================
    await seedProfile(testEnv, 'carol', 'carol_handle', { displayName: 'Carol Carlsson' });
    const carol = testEnv.authenticatedContext('carol').firestore();

    await check('ALLOW: completed user joins a valid Activity (participant + stats paired write)', async () => {
      await assertSucceeds(joinTransaction(alice, 'activity-alice-1', 'alice', 'Test User', 'alice_handle', 1));
      const stats = await getDoc(doc(alice, 'content', 'activity-alice-1', 'stats', 'activity'));
      assert.equal(stats.data().participantCount, 1);
    });

    await check('DENY: duplicate join does not double-increment (second paired write for same user rejected)', async () => {
      // alice is already joined; a second create attempt for the same
      // participant doc is a create-on-existing-doc, which Firestore itself
      // rejects (the real joinActivity() service returns "alreadyJoined"
      // instead of ever attempting this) — confirms no double count is possible.
      await assertFails(joinTransaction(alice, 'activity-alice-1', 'alice', 'Test User', 'alice_handle', 2));
      const stats = await getDoc(doc(alice, 'content', 'activity-alice-1', 'stats', 'activity'));
      assert.equal(stats.data().participantCount, 1);
    });

    await check('ALLOW: authenticated user reads the participant list', async () => {
      await assertSucceeds(getDocs(collection(bob, 'content', 'activity-alice-1', 'participants')));
    });

    await check('DENY: unauthenticated join', async () => {
      const participantRef = doc(anon, 'content', 'activity-alice-1', 'participants', 'ghost');
      const statsRef = doc(anon, 'content', 'activity-alice-1', 'stats', 'activity');
      await assertFails(
        runTransaction(testEnv.unauthenticatedContext().firestore(), async (tx) => {
          await Promise.all([tx.get(participantRef), tx.get(statsRef)]);
          tx.set(participantRef, validParticipant('ghost', 'Ghost', 'ghost_handle'));
          tx.set(statsRef, statsDoc(2));
        })
      );
    });

    await check('DENY: user A creates a participant doc for user B', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'activity-alice-1', 'participants', 'carol'), validParticipant('carol', 'Carol Carlsson', 'carol_handle'))
      );
    });

    await check('DENY: user spoofs username on participant doc', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'activity-alice-1', 'participants', 'bob'), validParticipant('bob', 'Bob Bobsson', 'alice_handle'))
      );
    });

    await check('DENY: user spoofs displayName on participant doc', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'activity-alice-1', 'participants', 'bob'), validParticipant('bob', 'Test User', 'bob_handle'))
      );
    });

    await check('DENY: join non-Activity content (a Post)', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'post-bob-1', 'participants', 'bob'), validParticipant('bob', 'Bob Bobsson', 'bob_handle'))
      );
    });

    await check('setup: create an already-ended Activity', async () => {
      await assertSucceeds(
        setDoc(
          doc(alice, 'content', 'activity-ended-1'),
          validActivity('alice', 'Test User', 'alice_handle', 'activity-ended-1', {
            startsAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000),
            endsAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
          })
        )
      );
    });

    await check('DENY: join an ended Activity', async () => {
      await assertFails(joinTransaction(bob, 'activity-ended-1', 'bob', 'Bob Bobsson', 'bob_handle', 1));
    });

    await check('DENY: stats increment without a paired participant creation', async () => {
      await assertFails(setDoc(doc(bob, 'content', 'activity-alice-1', 'stats', 'activity'), statsDoc(2)));
    });

    await check('DENY: stats increments by more than 1', async () => {
      const participantRef = doc(bob, 'content', 'activity-alice-1', 'participants', 'bob');
      const statsRef = doc(bob, 'content', 'activity-alice-1', 'stats', 'activity');
      await assertFails(
        runTransaction(bob, async (tx) => {
          await Promise.all([tx.get(participantRef), tx.get(statsRef)]);
          tx.set(participantRef, validParticipant('bob', 'Bob Bobsson', 'bob_handle'));
          tx.set(statsRef, statsDoc(5));
        })
      );
    });

    await check('DENY: participant deletion without a paired stats decrement', async () => {
      // bob has no participant doc on activity-alice-1 yet in this suite, so
      // delete alice's instead to prove a lone delete (no stats pairing) fails —
      // confirms via a fresh doc rather than reusing alice's real membership.
      await assertFails(deleteDoc(doc(alice, 'content', 'activity-alice-1', 'participants', 'alice')));
    });

    await check('DENY: direct participant document update', async () => {
      await assertFails(updateDoc(doc(alice, 'content', 'activity-alice-1', 'participants', 'alice'), { displayName: 'Changed' }));
    });

    await check('setup: activity with maxParticipants = 1', async () => {
      await assertSucceeds(
        setDoc(
          doc(alice, 'content', 'activity-full-1'),
          validActivity('alice', 'Test User', 'alice_handle', 'activity-full-1', { maxParticipants: 1 })
        )
      );
    });

    await check('ALLOW: first user joins a maxParticipants=1 Activity', async () => {
      await assertSucceeds(joinTransaction(bob, 'activity-full-1', 'bob', 'Bob Bobsson', 'bob_handle', 1));
    });

    await check('DENY: second user joins when maxParticipants is already full', async () => {
      await assertFails(joinTransaction(carol, 'activity-full-1', 'carol', 'Carol Carlsson', 'carol_handle', 2));
    });

    await check('DENY: negative participant count', async () => {
      const participantRef = doc(bob, 'content', 'activity-full-1', 'participants', 'bob');
      const statsRef = doc(bob, 'content', 'activity-full-1', 'stats', 'activity');
      await assertFails(
        runTransaction(bob, async (tx) => {
          await tx.get(statsRef);
          tx.delete(participantRef);
          tx.set(statsRef, statsDoc(-1));
        })
      );
    });

    await check('ALLOW: user leaves an Activity (paired delete + decrement)', async () => {
      const participantRef = doc(alice, 'content', 'activity-alice-1', 'participants', 'alice');
      const statsRef = doc(alice, 'content', 'activity-alice-1', 'stats', 'activity');
      await assertSucceeds(
        runTransaction(alice, async (tx) => {
          await tx.get(statsRef);
          tx.delete(participantRef);
          tx.set(statsRef, statsDoc(0));
        })
      );
    });

    await check('DENY: user A deletes user B\'s participant document', async () => {
      // bob is still joined on activity-full-1 from the capacity test above.
      const participantRef = doc(alice, 'content', 'activity-full-1', 'participants', 'bob');
      const statsRef = doc(alice, 'content', 'activity-full-1', 'stats', 'activity');
      await assertFails(
        runTransaction(alice, async (tx) => {
          await tx.get(statsRef);
          tx.delete(participantRef);
          tx.set(statsRef, statsDoc(0));
        })
      );
    });

    // =========================================================================
    // content/{eventId}/responses/{uid}
    // =========================================================================
    await check('ALLOW: completed user marks Interested on an Event', async () => {
      await assertSucceeds(
        setDoc(doc(alice, 'content', 'event-alice-1', 'responses', 'alice'), validResponse('alice', 'Test User', 'alice_handle', 'interested'))
      );
    });

    await check('ALLOW: user switches their response from Interested to Going', async () => {
      await assertSucceeds(
        updateDoc(doc(alice, 'content', 'event-alice-1', 'responses', 'alice'), { status: 'going', updatedAt: serverTimestamp() })
      );
      const saved = await getDoc(doc(alice, 'content', 'event-alice-1', 'responses', 'alice'));
      assert.equal(saved.data().status, 'going');
    });

    await check('ALLOW: authenticated user reads Event responses', async () => {
      await assertSucceeds(getDocs(collection(bob, 'content', 'event-alice-1', 'responses')));
    });

    await check('DENY: unauthenticated response', async () => {
      await assertFails(
        setDoc(doc(anon, 'content', 'event-alice-1', 'responses', 'ghost'), validResponse('ghost', 'Ghost', 'ghost_handle', 'interested'))
      );
    });

    await check('DENY: response on non-Event content (an Activity)', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'activity-alice-1', 'responses', 'bob'), validResponse('bob', 'Bob Bobsson', 'bob_handle', 'interested'))
      );
    });

    await check('DENY: user A writes a response for user B', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'event-alice-1', 'responses', 'carol'), validResponse('carol', 'Carol Carlsson', 'carol_handle', 'interested'))
      );
    });

    await check('DENY: spoofed username on response', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'event-alice-1', 'responses', 'bob'), validResponse('bob', 'Bob Bobsson', 'alice_handle', 'interested'))
      );
    });

    await check('DENY: spoofed displayName on response', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'event-alice-1', 'responses', 'bob'), validResponse('bob', 'Test User', 'bob_handle', 'interested'))
      );
    });

    await check('DENY: invalid response status', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'event-alice-1', 'responses', 'bob'), validResponse('bob', 'Bob Bobsson', 'bob_handle', 'maybe'))
      );
    });

    await check('DENY: changing immutable uid on response update', async () => {
      await assertFails(updateDoc(doc(alice, 'content', 'event-alice-1', 'responses', 'alice'), { uid: 'bob', updatedAt: serverTimestamp() }));
    });

    await check('DENY: changing immutable createdAt on response update', async () => {
      await assertFails(
        updateDoc(doc(alice, 'content', 'event-alice-1', 'responses', 'alice'), { createdAt: Timestamp.now(), updatedAt: serverTimestamp() })
      );
    });

    await check('setup: create an already-ended Event', async () => {
      await assertSucceeds(
        setDoc(
          doc(alice, 'content', 'event-ended-1'),
          validEvent('alice', 'Test User', 'alice_handle', 'event-ended-1', {
            startsAt: Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000),
            endsAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
          })
        )
      );
    });

    await check('DENY: response after Event has ended', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'event-ended-1', 'responses', 'bob'), validResponse('bob', 'Bob Bobsson', 'bob_handle', 'going'))
      );
    });

    await check('ALLOW: user removes their own response', async () => {
      await assertSucceeds(deleteDoc(doc(alice, 'content', 'event-alice-1', 'responses', 'alice')));
    });

    await check('DENY: user A deletes user B\'s response', async () => {
      await assertSucceeds(
        setDoc(doc(bob, 'content', 'event-alice-1', 'responses', 'bob'), validResponse('bob', 'Bob Bobsson', 'bob_handle', 'going'))
      );
      await assertFails(deleteDoc(doc(alice, 'content', 'event-alice-1', 'responses', 'bob')));
    });

    // =========================================================================
    // Aggregation counts (getCountFromServer) — a fresh Event so the counts
    // start at a known zero, independent of the response tests above.
    // =========================================================================
    await check('setup: create a fresh Event for aggregation-count testing', async () => {
      await assertSucceeds(setDoc(doc(alice, 'content', 'event-agg-1'), validEvent('alice', 'Test User', 'alice_handle', 'event-agg-1')));
    });

    async function responseCounts(db) {
      const responsesRef = collection(db, 'content', 'event-agg-1', 'responses');
      const [interested, going] = await Promise.all([
        getCountFromServer(query(responsesRef, where('status', '==', 'interested'))),
        getCountFromServer(query(responsesRef, where('status', '==', 'going'))),
      ]);
      return { interestedCount: interested.data().count, goingCount: going.data().count };
    }

    await check('AGGREGATION: counts are 0/0 with no responses', async () => {
      const counts = await responseCounts(bob);
      assert.deepEqual(counts, { interestedCount: 0, goingCount: 0 });
    });

    await check('AGGREGATION: counts after one Interested response', async () => {
      await assertSucceeds(
        setDoc(doc(bob, 'content', 'event-agg-1', 'responses', 'bob'), validResponse('bob', 'Bob Bobsson', 'bob_handle', 'interested'))
      );
      const counts = await responseCounts(bob);
      assert.deepEqual(counts, { interestedCount: 1, goingCount: 0 });
    });

    await check('AGGREGATION: counts after a second user marks Going', async () => {
      await assertSucceeds(
        setDoc(doc(carol, 'content', 'event-agg-1', 'responses', 'carol'), validResponse('carol', 'Carol Carlsson', 'carol_handle', 'going'))
      );
      const counts = await responseCounts(bob);
      assert.deepEqual(counts, { interestedCount: 1, goingCount: 1 });
    });

    await check('AGGREGATION: counts after Interested user switches to Going', async () => {
      await assertSucceeds(updateDoc(doc(bob, 'content', 'event-agg-1', 'responses', 'bob'), { status: 'going', updatedAt: serverTimestamp() }));
      const counts = await responseCounts(bob);
      assert.deepEqual(counts, { interestedCount: 0, goingCount: 2 });
    });

    await check('AGGREGATION: counts after a response is removed', async () => {
      await assertSucceeds(deleteDoc(doc(bob, 'content', 'event-agg-1', 'responses', 'bob')));
      const counts = await responseCounts(bob);
      assert.deepEqual(counts, { interestedCount: 0, goingCount: 1 });
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
