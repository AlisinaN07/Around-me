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
    placeId: null,
    status: 'published',
    visibility: 'city',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function validPlace(placeId, name, cityKey, overrides = {}) {
  return {
    placeId,
    name,
    nameLower: name.toLowerCase(),
    categoryId: 'cafe',
    cityName: cityKey === 'se:stockholm' ? 'Stockholm' : 'Karlstad',
    countryCode: 'SE',
    cityKey,
    address: 'Test address 1',
    latitude: 59.3,
    longitude: 13.5,
    geohash: 'u6sce',
    status: 'active',
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

function validLike(uid, overrides = {}) {
  return { uid, createdAt: serverTimestamp(), ...overrides };
}

function validPublicProfile(uid, displayName, username, overrides = {}) {
  return {
    uid,
    displayName,
    username,
    usernameLower: username,
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: 'se:karlstad',
    interests: ['music'],
    accountType: 'personal',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function validFollow(followerUid, followingUid, overrides = {}) {
  return { followerUid, followingUid, createdAt: serverTimestamp(), ...overrides };
}

function validComment(commentId, authorUid, authorDisplayName, authorUsername, body, overrides = {}) {
  return {
    commentId,
    authorUid,
    authorDisplayName,
    authorUsername,
    body,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
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

    // Step 10: root content delete is now disabled entirely (see
    // firestore.rules) — content has five possible subcollections
    // (participants/stats/responses/likes/comments) that Firestore never
    // cascade-deletes, and there's no safe production cascade-delete
    // workflow yet. This used to be an ALLOW case; it's a DENY case now.
    await check('DENY: author can no longer delete their own content (cascade-delete safety)', async () => {
      await assertFails(deleteDoc(doc(alice, 'content', 'post-alice-1')));
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

    // =========================================================================
    // content/{contentId}/likes/{uid}
    // Reuses post-alice-1, post-bob-1, activity-alice-1, event-alice-1 from
    // earlier in the suite (all still exist — content delete is disabled).
    // =========================================================================
    await check('ALLOW: completed user Likes a published Post', async () => {
      await assertSucceeds(setDoc(doc(bob, 'content', 'post-alice-1', 'likes', 'bob'), validLike('bob')));
    });

    await check('ALLOW: Likes a published Activity', async () => {
      await assertSucceeds(setDoc(doc(bob, 'content', 'activity-alice-1', 'likes', 'bob'), validLike('bob')));
    });

    await check('ALLOW: Likes a published Event', async () => {
      await assertSucceeds(setDoc(doc(bob, 'content', 'event-alice-1', 'likes', 'bob'), validLike('bob')));
    });

    await check('ALLOW: authenticated user reads Likes', async () => {
      await assertSucceeds(getDocs(collection(carol, 'content', 'post-alice-1', 'likes')));
    });

    await check('DENY: duplicate Like does not create a second record', async () => {
      // bob already liked activity-alice-1 above — re-creating the same
      // uid-keyed doc is a write-to-existing-doc, i.e. an update, and
      // updates are denied — this is what actually prevents double-liking.
      await assertFails(setDoc(doc(bob, 'content', 'activity-alice-1', 'likes', 'bob'), validLike('bob')));
    });

    await check('ALLOW: user deletes their own Like', async () => {
      await assertSucceeds(deleteDoc(doc(bob, 'content', 'post-alice-1', 'likes', 'bob')));
    });

    await check('DENY: unauthenticated Like', async () => {
      await assertFails(setDoc(doc(anon, 'content', 'post-alice-1', 'likes', 'ghost'), validLike('ghost')));
    });

    await check('DENY: Like document created for another uid', async () => {
      await assertFails(setDoc(doc(bob, 'content', 'post-alice-1', 'likes', 'carol'), validLike('carol')));
    });

    await check('DENY: mismatched uid field inside Like data', async () => {
      await assertFails(setDoc(doc(carol, 'content', 'post-alice-1', 'likes', 'carol'), validLike('bob')));
    });

    await check('DENY: update an existing Like', async () => {
      // bob's like on event-alice-1 is still there (never deleted above).
      await assertFails(updateDoc(doc(bob, 'content', 'event-alice-1', 'likes', 'bob'), { createdAt: serverTimestamp() }));
    });

    await check('DENY: user deletes another user\'s Like', async () => {
      await assertFails(deleteDoc(doc(alice, 'content', 'event-alice-1', 'likes', 'bob')));
    });

    await check('DENY: Like on nonexistent content', async () => {
      await assertFails(setDoc(doc(bob, 'content', 'does-not-exist', 'likes', 'bob'), validLike('bob')));
    });

    await check('setup: seed an unpublished content doc (admin bypass — content create rules always force status=published)', async () => {
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        await setDoc(doc(adminContext.firestore(), 'content', 'post-unpublished-1'), {
          ...validPost('alice', 'Test User', 'alice_handle', 'post-unpublished-1'),
          status: 'draft',
        });
      });
    });

    await check('DENY: Like on unpublished content', async () => {
      await assertFails(setDoc(doc(bob, 'content', 'post-unpublished-1', 'likes', 'bob'), validLike('bob')));
    });

    async function likeCount(db, contentId) {
      const snapshot = await getCountFromServer(collection(db, 'content', contentId, 'likes'));
      return snapshot.data().count;
    }

    await check('setup: fresh Post for Like aggregation testing', async () => {
      await assertSucceeds(setDoc(doc(alice, 'content', 'post-agg-1'), validPost('alice', 'Test User', 'alice_handle', 'post-agg-1')));
    });

    await check('AGGREGATION: Like count 0 -> 1 -> 2 -> 1', async () => {
      assert.equal(await likeCount(bob, 'post-agg-1'), 0);
      await assertSucceeds(setDoc(doc(bob, 'content', 'post-agg-1', 'likes', 'bob'), validLike('bob')));
      assert.equal(await likeCount(bob, 'post-agg-1'), 1);
      await assertSucceeds(setDoc(doc(carol, 'content', 'post-agg-1', 'likes', 'carol'), validLike('carol')));
      assert.equal(await likeCount(bob, 'post-agg-1'), 2);
      await assertSucceeds(deleteDoc(doc(bob, 'content', 'post-agg-1', 'likes', 'bob')));
      assert.equal(await likeCount(bob, 'post-agg-1'), 1);
    });

    // =========================================================================
    // content/{contentId}/comments/{commentId}
    // =========================================================================
    await check('ALLOW: completed User A comments on published content', async () => {
      await assertSucceeds(
        setDoc(
          doc(alice, 'content', 'post-bob-1', 'comments', 'comment-1'),
          validComment('comment-1', 'alice', 'Test User', 'alice_handle', 'Nice post!')
        )
      );
    });

    await check('ALLOW: authenticated user reads comments', async () => {
      await assertSucceeds(getDocs(collection(carol, 'content', 'post-bob-1', 'comments')));
    });

    await check('ALLOW: User A deletes their own comment', async () => {
      await assertSucceeds(deleteDoc(doc(alice, 'content', 'post-bob-1', 'comments', 'comment-1')));
    });

    await check('DENY: unauthenticated comment', async () => {
      await assertFails(
        setDoc(
          doc(anon, 'content', 'post-bob-1', 'comments', 'comment-ghost'),
          validComment('comment-ghost', 'ghost', 'Ghost', 'ghost_handle', 'hi')
        )
      );
    });

    await check('DENY: commenter with no completed profile', async () => {
      const dave = testEnv.authenticatedContext('dave').firestore(); // dave has no seeded profile anywhere in this suite
      await assertFails(
        setDoc(doc(dave, 'content', 'post-bob-1', 'comments', 'comment-dave'), validComment('comment-dave', 'dave', 'Dave', 'dave_handle', 'hi'))
      );
    });

    await check('DENY: spoofed authorUid', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-bob-1', 'comments', 'comment-spoof-uid'),
          validComment('comment-spoof-uid', 'alice', 'Bob Bobsson', 'bob_handle', 'hi')
        )
      );
    });

    await check('DENY: spoofed authorUsername', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-bob-1', 'comments', 'comment-spoof-username'),
          validComment('comment-spoof-username', 'bob', 'Bob Bobsson', 'alice_handle', 'hi')
        )
      );
    });

    await check('DENY: spoofed authorDisplayName', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-bob-1', 'comments', 'comment-spoof-name'),
          validComment('comment-spoof-name', 'bob', 'Test User', 'bob_handle', 'hi')
        )
      );
    });

    await check('DENY: empty comment body', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'post-bob-1', 'comments', 'comment-empty'), validComment('comment-empty', 'bob', 'Bob Bobsson', 'bob_handle', ''))
      );
    });

    await check('DENY: comment body over 500 characters', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-bob-1', 'comments', 'comment-long'),
          validComment('comment-long', 'bob', 'Bob Bobsson', 'bob_handle', 'x'.repeat(501))
        )
      );
    });

    await check('DENY: malformed comment shape (missing body)', async () => {
      const malformed = validComment('comment-malformed', 'bob', 'Bob Bobsson', 'bob_handle', 'hi');
      delete malformed.body;
      await assertFails(setDoc(doc(bob, 'content', 'post-bob-1', 'comments', 'comment-malformed'), malformed));
    });

    await check('DENY: commentId field does not match document ID', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'post-bob-1', 'comments', 'comment-mismatch'), validComment('wrong-id', 'bob', 'Bob Bobsson', 'bob_handle', 'hi'))
      );
    });

    await check('DENY: update an existing comment', async () => {
      await assertSucceeds(
        setDoc(doc(bob, 'content', 'post-bob-1', 'comments', 'comment-2'), validComment('comment-2', 'bob', 'Bob Bobsson', 'bob_handle', 'Original'))
      );
      await assertFails(updateDoc(doc(bob, 'content', 'post-bob-1', 'comments', 'comment-2'), { body: 'Edited' }));
    });

    await check('DENY: User A deletes User B\'s comment', async () => {
      await assertFails(deleteDoc(doc(alice, 'content', 'post-bob-1', 'comments', 'comment-2')));
    });

    await check('DENY: comment on nonexistent content', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'does-not-exist', 'comments', 'comment-x'), validComment('comment-x', 'bob', 'Bob Bobsson', 'bob_handle', 'hi'))
      );
    });

    await check('DENY: comment on unpublished content', async () => {
      await assertFails(
        setDoc(
          doc(bob, 'content', 'post-unpublished-1', 'comments', 'comment-y'),
          validComment('comment-y', 'bob', 'Bob Bobsson', 'bob_handle', 'hi')
        )
      );
    });

    async function commentCount(db, contentId) {
      const snapshot = await getCountFromServer(collection(db, 'content', contentId, 'comments'));
      return snapshot.data().count;
    }

    await check('setup: fresh Post for Comment aggregation testing', async () => {
      await assertSucceeds(setDoc(doc(alice, 'content', 'post-agg-2'), validPost('alice', 'Test User', 'alice_handle', 'post-agg-2')));
    });

    await check('AGGREGATION: Comment count 0 -> 1 -> 2 -> 1', async () => {
      assert.equal(await commentCount(bob, 'post-agg-2'), 0);
      await assertSucceeds(setDoc(doc(bob, 'content', 'post-agg-2', 'comments', 'c-a'), validComment('c-a', 'bob', 'Bob Bobsson', 'bob_handle', 'First!')));
      assert.equal(await commentCount(bob, 'post-agg-2'), 1);
      await assertSucceeds(
        setDoc(doc(carol, 'content', 'post-agg-2', 'comments', 'c-b'), validComment('c-b', 'carol', 'Carol Carlsson', 'carol_handle', 'Second!'))
      );
      assert.equal(await commentCount(bob, 'post-agg-2'), 2);
      await assertSucceeds(deleteDoc(doc(bob, 'content', 'post-agg-2', 'comments', 'c-a')));
      assert.equal(await commentCount(bob, 'post-agg-2'), 1);
    });

    // =========================================================================
    // publicProfiles/{uid}
    // =========================================================================
    await check('ALLOW: completed user creates own matching public profile', async () => {
      await assertSucceeds(setDoc(doc(alice, 'publicProfiles', 'alice'), validPublicProfile('alice', 'Test User', 'alice_handle')));
    });

    await check('ALLOW: authenticated user reads a public profile', async () => {
      await assertSucceeds(getDoc(doc(bob, 'publicProfiles', 'alice')));
    });

    await check('DENY: unauthenticated read', async () => {
      await assertFails(getDoc(doc(anon, 'publicProfiles', 'alice')));
    });

    await check('DENY: user A creates a public profile at user B\'s UID', async () => {
      await assertFails(setDoc(doc(alice, 'publicProfiles', 'bob'), validPublicProfile('bob', 'Bob Bobsson', 'bob_handle')));
    });

    await check('DENY: spoofed displayName on public profile', async () => {
      await assertFails(setDoc(doc(bob, 'publicProfiles', 'bob'), validPublicProfile('bob', 'Someone Else', 'bob_handle')));
    });

    await check('DENY: spoofed username on public profile', async () => {
      await assertFails(setDoc(doc(bob, 'publicProfiles', 'bob'), validPublicProfile('bob', 'Bob Bobsson', 'alice_handle')));
    });

    await check('DENY: spoofed city on public profile', async () => {
      await assertFails(
        setDoc(doc(bob, 'publicProfiles', 'bob'), validPublicProfile('bob', 'Bob Bobsson', 'bob_handle', { cityName: 'Stockholm', cityKey: 'se:stockholm' }))
      );
    });

    await check('DENY: public profile includes an email field', async () => {
      await assertFails(
        setDoc(doc(bob, 'publicProfiles', 'bob'), { ...validPublicProfile('bob', 'Bob Bobsson', 'bob_handle'), email: 'bob@example.com' })
      );
    });

    await check('DENY: public profile includes an arbitrary extra field', async () => {
      await assertFails(setDoc(doc(bob, 'publicProfiles', 'bob'), { ...validPublicProfile('bob', 'Bob Bobsson', 'bob_handle'), bio: 'hello' }));
    });

    await check('ALLOW: second user creates own matching public profile (setup for follows)', async () => {
      await assertSucceeds(setDoc(doc(bob, 'publicProfiles', 'bob'), validPublicProfile('bob', 'Bob Bobsson', 'bob_handle')));
    });

    await check('ALLOW: third user creates own matching public profile (setup for follows)', async () => {
      await assertSucceeds(setDoc(doc(carol, 'publicProfiles', 'carol'), validPublicProfile('carol', 'Carol Carlsson', 'carol_handle')));
    });

    await check('DENY: update a public profile', async () => {
      await assertFails(updateDoc(doc(alice, 'publicProfiles', 'alice'), { displayName: 'Changed' }));
    });

    await check('DENY: delete a public profile', async () => {
      await assertFails(deleteDoc(doc(alice, 'publicProfiles', 'alice')));
    });

    // =========================================================================
    // follows/{followerUid}_{followingUid}
    // =========================================================================
    await check('ALLOW: user A follows user B', async () => {
      await assertSucceeds(setDoc(doc(alice, 'follows', 'alice_bob'), validFollow('alice', 'bob')));
    });

    await check('ALLOW: authenticated user reads follow edges', async () => {
      await assertSucceeds(getDoc(doc(carol, 'follows', 'alice_bob')));
    });

    await check('DENY: duplicate follow does not create a second edge', async () => {
      // Same deterministic ID as the existing follow above => a rules
      // "update" (the doc already exists), which is denied — that's what
      // actually prevents a duplicate edge, not a separate exists() check.
      await assertFails(setDoc(doc(alice, 'follows', 'alice_bob'), validFollow('alice', 'bob')));
    });

    await check('ALLOW: user A unfollows user B', async () => {
      await assertSucceeds(deleteDoc(doc(alice, 'follows', 'alice_bob')));
    });

    await check('DENY: unauthenticated follow', async () => {
      await assertFails(setDoc(doc(anon, 'follows', 'ghost_bob'), validFollow('ghost', 'bob')));
    });

    await check('DENY: user A creates a follow with followerUid = user C', async () => {
      await assertFails(setDoc(doc(alice, 'follows', 'carol_bob'), validFollow('carol', 'bob')));
    });

    await check('DENY: self-follow', async () => {
      await assertFails(setDoc(doc(alice, 'follows', 'alice_alice'), validFollow('alice', 'alice')));
    });

    await check('DENY: follow a nonexistent public profile', async () => {
      await assertFails(setDoc(doc(alice, 'follows', 'alice_dave'), validFollow('alice', 'dave')));
    });

    await check('DENY: wrong deterministic follow document ID', async () => {
      await assertFails(setDoc(doc(alice, 'follows', 'wrong-id'), validFollow('alice', 'bob')));
    });

    await check('DENY: follow document with extra fields', async () => {
      await assertFails(setDoc(doc(alice, 'follows', 'alice_carol'), { ...validFollow('alice', 'carol'), note: 'hi' }));
    });

    await check('DENY: update a follow document', async () => {
      await assertSucceeds(setDoc(doc(alice, 'follows', 'alice_carol'), validFollow('alice', 'carol')));
      await assertFails(updateDoc(doc(alice, 'follows', 'alice_carol'), { createdAt: serverTimestamp() }));
    });

    await check('DENY: user A deletes user C\'s follow edge', async () => {
      await assertSucceeds(setDoc(doc(bob, 'follows', 'bob_carol'), validFollow('bob', 'carol')));
      await assertFails(deleteDoc(doc(alice, 'follows', 'bob_carol')));
    });

    // =========================================================================
    // Counts + list verification — fresh users so counts start at a known
    // zero, independent of the follow edges created above.
    // =========================================================================
    await seedProfile(testEnv, 'usera', 'usera_handle', { displayName: 'User A' });
    await seedProfile(testEnv, 'userb', 'userb_handle', { displayName: 'User B' });
    await seedProfile(testEnv, 'userc', 'userc_handle', { displayName: 'User C' });
    const userA = testEnv.authenticatedContext('usera').firestore();
    const userB = testEnv.authenticatedContext('userb').firestore();
    const userC = testEnv.authenticatedContext('userc').firestore();

    await check('setup: fresh users create their own public profiles', async () => {
      await assertSucceeds(setDoc(doc(userA, 'publicProfiles', 'usera'), validPublicProfile('usera', 'User A', 'usera_handle')));
      await assertSucceeds(setDoc(doc(userB, 'publicProfiles', 'userb'), validPublicProfile('userb', 'User B', 'userb_handle')));
      await assertSucceeds(setDoc(doc(userC, 'publicProfiles', 'userc'), validPublicProfile('userc', 'User C', 'userc_handle')));
    });

    async function followerCount(db, uid) {
      const snapshot = await getCountFromServer(query(collection(db, 'follows'), where('followingUid', '==', uid)));
      return snapshot.data().count;
    }
    async function followingCount(db, uid) {
      const snapshot = await getCountFromServer(query(collection(db, 'follows'), where('followerUid', '==', uid)));
      return snapshot.data().count;
    }

    await check('AGGREGATION: follower count 0 -> 1 (A follows B) -> 2 (C follows B) -> 1 (A unfollows B)', async () => {
      assert.equal(await followerCount(userB, 'userb'), 0);
      await assertSucceeds(setDoc(doc(userA, 'follows', 'usera_userb'), validFollow('usera', 'userb')));
      assert.equal(await followerCount(userB, 'userb'), 1);
      await assertSucceeds(setDoc(doc(userC, 'follows', 'userc_userb'), validFollow('userc', 'userb')));
      assert.equal(await followerCount(userB, 'userb'), 2);
      await assertSucceeds(deleteDoc(doc(userA, 'follows', 'usera_userb')));
      assert.equal(await followerCount(userB, 'userb'), 1);
    });

    await check('AGGREGATION: following count 0 -> 1 (A follows B) -> 0 (A unfollows B)', async () => {
      assert.equal(await followingCount(userA, 'usera'), 0);
      await assertSucceeds(setDoc(doc(userA, 'follows', 'usera_userb'), validFollow('usera', 'userb')));
      assert.equal(await followingCount(userA, 'usera'), 1);
      await assertSucceeds(deleteDoc(doc(userA, 'follows', 'usera_userb')));
      assert.equal(await followingCount(userA, 'usera'), 0);
    });

    await check('setup: A follows B, A follows C (C already follows B from aggregation tests above)', async () => {
      await assertSucceeds(setDoc(doc(userA, 'follows', 'usera_userb'), validFollow('usera', 'userb')));
      await assertSucceeds(setDoc(doc(userA, 'follows', 'usera_userc'), validFollow('usera', 'userc')));
    });

    async function followingUidsOf(db, uid) {
      const snapshot = await getDocs(query(collection(db, 'follows'), where('followerUid', '==', uid)));
      return snapshot.docs.map((docSnapshot) => docSnapshot.data().followingUid).sort();
    }
    async function followerUidsOf(db, uid) {
      const snapshot = await getDocs(query(collection(db, 'follows'), where('followingUid', '==', uid)));
      return snapshot.docs.map((docSnapshot) => docSnapshot.data().followerUid).sort();
    }

    await check('LIST: fetchFollowing(A) contains exactly B and C, nothing else', async () => {
      assert.deepEqual(await followingUidsOf(userA, 'usera'), ['userb', 'userc']);
    });

    await check('LIST: fetchFollowers(B) contains exactly A and C, nothing else', async () => {
      assert.deepEqual(await followerUidsOf(userB, 'userb'), ['usera', 'userc']);
    });

    // =========================================================================
    // Onboarding regression — the exact 3-document transaction shape used by
    // createInitialUserProfile (users + usernames + publicProfiles), proving
    // Firestore transactions are genuinely atomic against these rules: if
    // any one write would be denied, NONE of the three documents land.
    // =========================================================================
    await check('ALLOW: onboarding transaction creates users + usernames + publicProfiles atomically', async () => {
      const frank = testEnv.authenticatedContext('frank').firestore();
      const userRef = doc(frank, 'users', 'frank');
      const usernameRef = doc(frank, 'usernames', 'frank_handle');
      const publicRef = doc(frank, 'publicProfiles', 'frank');

      await assertSucceeds(
        runTransaction(frank, async (tx) => {
          await Promise.all([tx.get(userRef), tx.get(usernameRef)]);
          tx.set(usernameRef, usernameReservation('frank'));
          tx.set(userRef, validUserProfile('frank', 'frank_handle'));
          tx.set(publicRef, validPublicProfile('frank', 'Test User', 'frank_handle'));
        })
      );

      const [userSnap, usernameSnap, publicSnap] = await Promise.all([getDoc(userRef), getDoc(usernameRef), getDoc(publicRef)]);
      assert.equal(userSnap.exists(), true);
      assert.equal(usernameSnap.exists(), true);
      assert.equal(publicSnap.exists(), true);
      assert.equal('email' in publicSnap.data(), false);
    });

    await check('DENY: onboarding transaction with a spoofed publicProfile fails atomically (no partial documents)', async () => {
      const gina = testEnv.authenticatedContext('gina').firestore();
      const userRef = doc(gina, 'users', 'gina');
      const usernameRef = doc(gina, 'usernames', 'gina_handle');
      const publicRef = doc(gina, 'publicProfiles', 'gina');

      await assertFails(
        runTransaction(gina, async (tx) => {
          await Promise.all([tx.get(userRef), tx.get(usernameRef)]);
          tx.set(usernameRef, usernameReservation('gina'));
          tx.set(userRef, validUserProfile('gina', 'gina_handle'));
          // Doesn't match the private profile's displayName ('Test User') —
          // this single bad write should roll back the entire transaction.
          tx.set(publicRef, validPublicProfile('gina', 'SPOOFED NAME', 'gina_handle'));
        })
      );

      const [userSnap, usernameSnap, publicSnap] = await Promise.all([getDoc(userRef), getDoc(usernameRef), getDoc(publicRef)]);
      assert.equal(userSnap.exists(), false);
      assert.equal(usernameSnap.exists(), false);
      assert.equal(publicSnap.exists(), false);
    });

    // =========================================================================
    // Existing-user lazy migration (ensureMyPublicProfile) — a legacy user
    // has a private profile + username but no public profile yet, matching
    // an account that completed onboarding before Step 11.
    // =========================================================================
    await seedProfile(testEnv, 'legacy', 'legacy_handle', { displayName: 'Legacy User' });
    const legacy = testEnv.authenticatedContext('legacy').firestore();

    await check('ALLOW: ensureMyPublicProfile creates a matching public profile for a legacy user', async () => {
      await assertSucceeds(setDoc(doc(legacy, 'publicProfiles', 'legacy'), validPublicProfile('legacy', 'Legacy User', 'legacy_handle')));
    });

    await check('DENY+IDEMPOTENT: calling it again does not overwrite — a second create is denied, the original document is untouched', async () => {
      await assertFails(setDoc(doc(legacy, 'publicProfiles', 'legacy'), validPublicProfile('legacy', 'Legacy User', 'legacy_handle')));
      const snapshot = await getDoc(doc(legacy, 'publicProfiles', 'legacy'));
      assert.equal(snapshot.exists(), true);
    });

    // =========================================================================
    // Places (Step 13) — places/{placeId} is read-only from any client.
    // Seeded here with the security rules disabled (the same admin bypass
    // seedProfile() uses above), mirroring how trusted tooling — never an
    // ordinary client — creates real Places in production.
    // =========================================================================
    await testEnv.withSecurityRulesDisabled(async (adminContext) => {
      const adminDb = adminContext.firestore();
      await setDoc(doc(adminDb, 'places', 'place-karlstad-cafe'), validPlace('place-karlstad-cafe', 'Test Café Karlstad', 'se:karlstad'));
      await setDoc(doc(adminDb, 'places', 'place-stockholm-venue'), validPlace('place-stockholm-venue', 'Test Venue Stockholm', 'se:stockholm'));
      await setDoc(
        doc(adminDb, 'places', 'place-inactive'),
        validPlace('place-inactive', 'Test Inactive Place', 'se:karlstad', { status: 'pending' })
      );
    });

    const aliceForPlaces = testEnv.authenticatedContext('alice').firestore();
    const anonForPlaces = testEnv.unauthenticatedContext().firestore();

    await check('ALLOW: authenticated user reads an active place', async () => {
      const snapshot = await assertSucceeds(getDoc(doc(aliceForPlaces, 'places', 'place-karlstad-cafe')));
      assert.equal(snapshot.data().name, 'Test Café Karlstad');
    });

    await check('ALLOW: authenticated city query reads active places (and excludes other cities)', async () => {
      const cityPlacesQuery = query(
        collection(aliceForPlaces, 'places'),
        where('cityKey', '==', 'se:karlstad'),
        where('status', '==', 'active')
      );
      const snapshot = await assertSucceeds(getDocs(cityPlacesQuery));
      const ids = snapshot.docs.map((d) => d.id).sort();
      assert.deepEqual(ids, ['place-karlstad-cafe']);
    });

    await check('DENY: unauthenticated read of a place', async () => {
      await assertFails(getDoc(doc(anonForPlaces, 'places', 'place-karlstad-cafe')));
    });

    await check('DENY: ordinary client creates a place', async () => {
      await assertFails(setDoc(doc(aliceForPlaces, 'places', 'place-fake'), validPlace('place-fake', 'Fake Place', 'se:karlstad')));
    });

    await check('DENY: ordinary client updates a place', async () => {
      await assertFails(updateDoc(doc(aliceForPlaces, 'places', 'place-karlstad-cafe'), { name: 'Hijacked Name' }));
    });

    await check('DENY: ordinary client deletes a place', async () => {
      await assertFails(deleteDoc(doc(aliceForPlaces, 'places', 'place-karlstad-cafe')));
    });

    // --- Content <-> Place linking ---------------------------------------

    await check('ALLOW: content with an active same-city placeId + matching placeName', async () => {
      await assertSucceeds(
        setDoc(
          doc(aliceForPlaces, 'content', 'post-known-place'),
          validPost('alice', 'Test User', 'alice_handle', 'post-known-place', {
            placeId: 'place-karlstad-cafe',
            placeName: 'Test Café Karlstad',
          })
        )
      );
    });

    await check('ALLOW: content with placeId null + a valid manual place name', async () => {
      await assertSucceeds(
        setDoc(
          doc(aliceForPlaces, 'content', 'post-manual-place'),
          validPost('alice', 'Test User', 'alice_handle', 'post-manual-place', {
            placeId: null,
            placeName: 'Some spot not in Around Me yet',
          })
        )
      );
    });

    await check('DENY: content links to a nonexistent placeId', async () => {
      await assertFails(
        setDoc(
          doc(aliceForPlaces, 'content', 'post-bad-place-1'),
          validPost('alice', 'Test User', 'alice_handle', 'post-bad-place-1', {
            placeId: 'place-does-not-exist',
            placeName: 'Whatever',
          })
        )
      );
    });

    await check('DENY: content links to an inactive place', async () => {
      await assertFails(
        setDoc(
          doc(aliceForPlaces, 'content', 'post-bad-place-2'),
          validPost('alice', 'Test User', 'alice_handle', 'post-bad-place-2', {
            placeId: 'place-inactive',
            placeName: 'Test Inactive Place',
          })
        )
      );
    });

    await check('DENY: content links to a different-city place (Stockholm place on Karlstad content)', async () => {
      await assertFails(
        setDoc(
          doc(aliceForPlaces, 'content', 'post-bad-place-3'),
          validPost('alice', 'Test User', 'alice_handle', 'post-bad-place-3', {
            placeId: 'place-stockholm-venue',
            placeName: 'Test Venue Stockholm',
          })
        )
      );
    });

    await check('DENY: content spoofs placeName for a real, same-city place', async () => {
      await assertFails(
        setDoc(
          doc(aliceForPlaces, 'content', 'post-bad-place-4'),
          validPost('alice', 'Test User', 'alice_handle', 'post-bad-place-4', {
            placeId: 'place-karlstad-cafe',
            placeName: 'Fake Casino',
          })
        )
      );
    });

    await check('DENY: malformed placeId type (number instead of string)', async () => {
      await assertFails(
        setDoc(
          doc(aliceForPlaces, 'content', 'post-bad-place-5'),
          validPost('alice', 'Test User', 'alice_handle', 'post-bad-place-5', {
            placeId: 12345,
            placeName: 'Test Café Karlstad',
          })
        )
      );
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
