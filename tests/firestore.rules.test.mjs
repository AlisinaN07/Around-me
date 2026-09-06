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
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
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
    bio: '',
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
    bio: '',
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

// Same deterministic ID scheme as buildNotificationId in
// src/services/notifications.ts.
function likeNotificationId(contentId, actorUid) {
  return `like_${contentId}_${actorUid}`;
}
function commentNotificationId(commentId) {
  return `comment_${commentId}`;
}
function followNotificationId(actorUid, recipientUid) {
  return `follow_${actorUid}_${recipientUid}`;
}

function validNotification(notificationId, recipientUid, actorUid, actorDisplayName, actorUsername, type, overrides = {}) {
  return {
    notificationId,
    recipientUid,
    actorUid,
    actorDisplayName,
    actorUsername,
    type,
    contentId: null,
    // reelId: null by default — matches every real notification write
    // (src/services/socialEngagement.ts, following.ts, reelEngagement.ts),
    // which always sets this field explicitly even for non-Reel types
    // (see src/types/notification.ts). Only reel_like/reel_comment tests
    // override it to a real reelId.
    reelId: null,
    commentId: null,
    previewText: null,
    // responseStatus: null by default — matches every real notification
    // write (see src/types/notification.ts). Only event_response tests
    // override it to 'interested'/'going'.
    responseStatus: null,
    read: false,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

// Same deterministic ID scheme as buildNotificationId in
// src/services/notifications.ts for event_response/activity_join.
function eventResponseNotificationId(contentId, actorUid) {
  return `event_response_${contentId}_${actorUid}`;
}
function activityJoinNotificationId(contentId, actorUid) {
  return `activity_join_${contentId}_${actorUid}`;
}

// Same deterministic ID scheme as buildNotificationId in
// src/services/notifications.ts for the two Reel notification types.
function reelLikeNotificationId(reelId, actorUid) {
  return `reel_like_${reelId}_${actorUid}`;
}
function reelCommentNotificationId(commentId) {
  return `reel_comment_${commentId}`;
}

// Same deterministic ID scheme as getConversationId in
// src/services/messages.ts — lexicographic string ordering, verified here
// against Firestore Rules' own `<` string comparison via the tests below.
function conversationId(uidA, uidB) {
  return uidA < uidB ? `${uidA}_${uidB}` : `${uidB}_${uidA}`;
}

function sortedPair(uidA, uidB) {
  return uidA < uidB ? [uidA, uidB] : [uidB, uidA];
}

function validConversation(uidA, uidB, senderUid, messageId, messageText, overrides = {}) {
  const [uidLow, uidHigh] = sortedPair(uidA, uidB);
  const otherUid = senderUid === uidLow ? uidHigh : uidLow;
  return {
    conversationId: conversationId(uidA, uidB),
    participantUids: [uidLow, uidHigh],
    lastMessageId: messageId,
    lastMessageText: messageText,
    lastMessageSenderUid: senderUid,
    lastMessageAt: serverTimestamp(),
    unreadCounts: { [senderUid]: 0, [otherUid]: 1 },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function validMessage(messageId, senderUid, body, overrides = {}) {
  return { messageId, senderUid, body, createdAt: serverTimestamp(), ...overrides };
}

// Same deterministic ID scheme as blockDocId in src/services/blocks.ts —
// directional, like follows/{followerUid}_{followingUid}.
function blockId(blockerUid, blockedUid) {
  return `${blockerUid}_${blockedUid}`;
}
function validBlock(blockerUid, blockedUid, overrides = {}) {
  return { blockId: blockId(blockerUid, blockedUid), blockerUid, blockedUid, createdAt: serverTimestamp(), ...overrides };
}

function validPrivacySettings(uid, newMessagesFrom, overrides = {}) {
  return { uid, newMessagesFrom, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), ...overrides };
}

// Same deterministic ID schemes as src/services/reports.ts.
function userReportId(reporterUid, targetUid) {
  return `user_${reporterUid}_${targetUid}`;
}
function contentReportId(reporterUid, contentId) {
  return `content_${reporterUid}_${contentId}`;
}
function messageReportId(reporterUid, messageId) {
  return `message_${reporterUid}_${messageId}`;
}
function reelReportId(reporterUid, reelId) {
  return `reel_${reporterUid}_${reelId}`;
}
function validReport(reportId, reporterUid, targetType, overrides = {}) {
  return {
    reportId,
    reporterUid,
    targetType,
    targetUid: null,
    contentId: null,
    conversationId: null,
    messageId: null,
    reelId: null,
    reason: 'spam',
    details: null,
    createdAt: serverTimestamp(),
    // Step 39.1 moderation lifecycle — every report is created 'open';
    // status only ever changes via the trusted dismissReport callable.
    status: 'open',
    moderatedAt: null,
    moderatedByUid: null,
    ...overrides,
  };
}

// Same deterministic path scheme as src/services/reels.ts's reelStoragePath.
function reelStoragePath(authorUid, reelId) {
  return `reels/${authorUid}/${reelId}/source`;
}
function validReel(authorUid, displayName, username, reelId, overrides = {}) {
  return {
    reelId,
    authorUid,
    authorDisplayName: displayName,
    authorUsername: username,
    cityName: 'Karlstad',
    countryCode: 'SE',
    cityKey: 'se:karlstad',
    categoryId: 'music',
    caption: 'Test reel',
    storagePath: reelStoragePath(authorUid, reelId),
    storageContentType: 'video/mp4',
    fileSizeBytes: 1024,
    durationMs: 5000,
    width: 720,
    height: 1280,
    status: 'uploading',
    visibility: 'city',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    publishedAt: null,
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

/**
 * Seeds a published reels/{reelId} directly, bypassing rules — the
 * create/publish transition itself is already thoroughly covered by the
 * Step 18 reel tests above; Step 19's engagement tests just need a real
 * published Reel to hang Likes/Comments/notifications off of.
 */
async function seedReel(testEnv, authorUid, displayName, username, reelId, overrides = {}) {
  await testEnv.withSecurityRulesDisabled(async (adminContext) => {
    await setDoc(doc(adminContext.firestore(), 'reels', reelId), {
      ...validReel(authorUid, displayName, username, reelId),
      status: 'published',
      publishedAt: serverTimestamp(),
      ...overrides,
    });
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

    // --- DENY: accountType outside the two-value allowlist (Step 30). No
    // arbitrary role string — admin/organizer/verified_business/etc. — is
    // ever accepted, even though nothing in this codebase generates one. ---
    await check('DENY: user profile with invalid accountType', async () => {
      const dave = testEnv.authenticatedContext('dave').firestore();
      const invalid = { ...validUserProfile('dave', 'dave_handle'), accountType: 'organizer' };
      await assertFails(setDoc(doc(dave, 'users', 'dave'), invalid));
    });

    // --- DENY: accountType mutation after onboarding (Step 30). The
    // users/{uid} match block has no `allow update` at all, so this is
    // denied before any field-level check even runs — but the test asserts
    // the outcome that actually matters: a Personal account can never
    // rewrite itself to Business (or vice versa) after signup. ---
    await check('DENY: user attempts to mutate their own accountType', async () => {
      const alice = testEnv.authenticatedContext('alice').firestore();
      await assertFails(updateDoc(doc(alice, 'users', 'alice'), { accountType: 'business' }));
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

    // Alice was created as a Personal account above (testing the generic
    // profile-create path, before any Event was involved). Promote her to
    // Business here, admin-mode, so the Event-creation tests below — and
    // every later test in this file that reuses event-alice-1 for
    // responses/likes/comments — exercise a Business account, matching
    // Step 30's business-only Event gate. Bob stays Personal throughout,
    // which is what makes him the right fixture for the DENY case right
    // below.
    await testEnv.withSecurityRulesDisabled(async (adminContext) => {
      await setDoc(doc(adminContext.firestore(), 'users', 'alice'), { accountType: 'business' }, { merge: true });
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

    await check('ALLOW: Personal account creates a valid Activity', async () => {
      await assertSucceeds(
        setDoc(doc(bob, 'content', 'activity-bob-1'), validActivity('bob', 'Bob Bobsson', 'bob_handle', 'activity-bob-1'))
      );
    });

    // --- DENY: Personal account creates an Event (Step 30 core rule —
    // Business = Personal + the ability to create Events). Bob is Personal
    // throughout this file, so this is a real accountType == 'personal'
    // denial, not just a malformed-shape rejection. ---
    await check('DENY: Personal account creates an Event', async () => {
      await assertFails(
        setDoc(doc(bob, 'content', 'event-bob-denied-1'), validEvent('bob', 'Bob Bobsson', 'bob_handle', 'event-bob-denied-1'))
      );
    });

    await check('ALLOW: Business account creates a valid Event', async () => {
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

    // Bob is Personal throughout this file, so this also doubles as the
    // Step 30 matrix's "Personal account creates a Post -> ALLOW" case.
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
      // 'bio' itself is a real schema field as of Step 33 — use a name that
      // is still genuinely not part of the schema to keep testing what
      // this check is actually for (rejecting unexpected keys).
      await assertFails(
        setDoc(doc(bob, 'publicProfiles', 'bob'), { ...validPublicProfile('bob', 'Bob Bobsson', 'bob_handle'), verified: true })
      );
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
    // Edit Profile (Step 33) — users/{uid} + publicProfiles/{uid} updates,
    // and the paired usernames/{...} reservation swap on a real rename.
    // Alice is Business, Bob is Personal (both already exist from the
    // content/publicProfiles sections above); Carol's existing
    // 'carol_handle' is the target for the username-theft test below.
    // =========================================================================
    await check('ALLOW: owner changes displayName, bio, and interests together', async () => {
      const sharedUpdate = {
        displayName: 'Alice Updated',
        username: 'alice_handle',
        usernameLower: 'alice_handle',
        bio: 'Hello, this is my bio.',
        interests: ['music', 'sports', 'food'],
        updatedAt: serverTimestamp(),
      };
      await assertSucceeds(
        runTransaction(alice, async (tx) => {
          tx.update(doc(alice, 'users', 'alice'), sharedUpdate);
          tx.update(doc(alice, 'publicProfiles', 'alice'), sharedUpdate);
        })
      );
      const savedUser = await getDoc(doc(alice, 'users', 'alice'));
      const savedPublic = await getDoc(doc(alice, 'publicProfiles', 'alice'));
      assert.equal(savedUser.data().displayName, 'Alice Updated');
      assert.equal(savedUser.data().bio, 'Hello, this is my bio.');
      assert.deepEqual(savedUser.data().interests, ['music', 'sports', 'food']);
      assert.equal(savedPublic.data().displayName, 'Alice Updated');
      assert.equal(savedPublic.data().bio, 'Hello, this is my bio.');
    });

    await check('ALLOW: valid username-change transaction (reserve new, release old, update both docs)', async () => {
      const sharedUpdate = {
        displayName: 'Alice Updated',
        username: 'alice_new_handle',
        usernameLower: 'alice_new_handle',
        bio: 'Hello, this is my bio.',
        interests: ['music', 'sports', 'food'],
        updatedAt: serverTimestamp(),
      };
      await assertSucceeds(
        runTransaction(alice, async (tx) => {
          await Promise.all([tx.get(doc(alice, 'usernames', 'alice_new_handle'))]);
          tx.update(doc(alice, 'users', 'alice'), sharedUpdate);
          tx.update(doc(alice, 'publicProfiles', 'alice'), sharedUpdate);
          tx.set(doc(alice, 'usernames', 'alice_new_handle'), usernameReservation('alice'));
          tx.delete(doc(alice, 'usernames', 'alice_handle'));
        })
      );
      const oldReservation = await getDoc(doc(bob, 'usernames', 'alice_handle'));
      const newReservation = await getDoc(doc(bob, 'usernames', 'alice_new_handle'));
      assert.equal(oldReservation.exists(), false);
      assert.equal(newReservation.exists(), true);
      assert.equal(newReservation.data().uid, 'alice');
      const savedUser = await getDoc(doc(alice, 'users', 'alice'));
      assert.equal(savedUser.data().usernameLower, 'alice_new_handle');
    });

    await check('ALLOW: keeping the same username leaves the reservation untouched', async () => {
      await assertSucceeds(
        runTransaction(bob, async (tx) => {
          tx.update(doc(bob, 'users', 'bob'), { bio: 'Unchanged username.', updatedAt: serverTimestamp() });
          tx.update(doc(bob, 'publicProfiles', 'bob'), { bio: 'Unchanged username.', updatedAt: serverTimestamp() });
        })
      );
      const reservation = await getDoc(doc(bob, 'usernames', 'bob_handle'));
      assert.equal(reservation.exists(), true);
      assert.equal(reservation.data().uid, 'bob');
    });

    await check('DENY: user A updates user B\'s profile', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'alice'), { displayName: 'Hijacked' }));
    });

    await check('DENY: owner changes accountType via update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { accountType: 'business', updatedAt: serverTimestamp() }));
    });

    await check('DENY: owner changes cityName/cityKey via update', async () => {
      await assertFails(
        updateDoc(doc(bob, 'users', 'bob'), { cityName: 'Stockholm', cityKey: 'se:stockholm', updatedAt: serverTimestamp() })
      );
    });

    await check('DENY: owner changes email via update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { email: 'new@example.com', updatedAt: serverTimestamp() }));
    });

    await check('DENY: owner changes uid via update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { uid: 'someone-else', updatedAt: serverTimestamp() }));
    });

    await check('DENY: owner changes onboardingCompleted via update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { onboardingCompleted: false, updatedAt: serverTimestamp() }));
    });

    await check('DENY: owner changes createdAt via update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { createdAt: Timestamp.now(), updatedAt: serverTimestamp() }));
    });

    await check('DENY: bio exceeds 160 characters', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { bio: 'x'.repeat(161), updatedAt: serverTimestamp() }));
    });

    await check('DENY: interests below the 3-minimum on update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { interests: ['music'], updatedAt: serverTimestamp() }));
    });

    await check('DENY: interests above the 8-maximum on update', async () => {
      await assertFails(
        updateDoc(doc(bob, 'users', 'bob'), {
          interests: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
          updatedAt: serverTimestamp(),
        })
      );
    });

    await check('DENY: invalid username format on update', async () => {
      await assertFails(
        updateDoc(doc(bob, 'users', 'bob'), { username: 'a', usernameLower: 'a', updatedAt: serverTimestamp() })
      );
    });

    await check('DENY: username theft — change to an already-taken username', async () => {
      await assertFails(
        runTransaction(bob, async (tx) => {
          await tx.get(doc(bob, 'usernames', 'carol_handle'));
          tx.update(doc(bob, 'users', 'bob'), { username: 'carol_handle', usernameLower: 'carol_handle', updatedAt: serverTimestamp() });
          tx.set(doc(bob, 'usernames', 'carol_handle'), usernameReservation('bob'));
        })
      );
      // Carol's reservation must be completely unaffected by the failed attempt.
      const carolReservation = await getDoc(doc(bob, 'usernames', 'carol_handle'));
      assert.equal(carolReservation.data().uid, 'carol');
    });

    await check('DENY: delete another user\'s username reservation directly', async () => {
      await assertFails(deleteDoc(doc(bob, 'usernames', 'carol_handle')));
    });

    await check('DENY: delete your own CURRENT username reservation without renaming', async () => {
      await assertFails(deleteDoc(doc(bob, 'usernames', 'bob_handle')));
    });

    await check('DENY: publicProfiles update drifts from users/{uid} (not a paired write)', async () => {
      await assertFails(updateDoc(doc(bob, 'publicProfiles', 'bob'), { displayName: 'Drifted', updatedAt: serverTimestamp() }));
    });

    await check('DENY: arbitrary extra field on users update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { verified: true, updatedAt: serverTimestamp() }));
    });

    await check('DENY: fabricated (non-server) updatedAt on update', async () => {
      await assertFails(updateDoc(doc(bob, 'users', 'bob'), { bio: 'trying to fake a timestamp', updatedAt: Timestamp.now() }));
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

    // =========================================================================
    // notifications/{notificationId}
    // Fresh users + fresh content, independent of every mutated document
    // above, so these assertions never depend on earlier sections' state.
    // =========================================================================
    await seedProfile(testEnv, 'notifa', 'notifa_handle', { displayName: 'Notif Alpha' });
    await seedProfile(testEnv, 'notifb', 'notifb_handle', { displayName: 'Notif Bravo' });
    await seedProfile(testEnv, 'notifc', 'notifc_handle', { displayName: 'Notif Charlie' });

    const notifA = testEnv.authenticatedContext('notifa').firestore();
    const notifB = testEnv.authenticatedContext('notifb').firestore();
    const notifC = testEnv.authenticatedContext('notifc').firestore();

    await check('setup: notification test users create matching public profiles', async () => {
      await assertSucceeds(setDoc(doc(notifA, 'publicProfiles', 'notifa'), validPublicProfile('notifa', 'Notif Alpha', 'notifa_handle')));
      await assertSucceeds(setDoc(doc(notifB, 'publicProfiles', 'notifb'), validPublicProfile('notifb', 'Notif Bravo', 'notifb_handle')));
      await assertSucceeds(setDoc(doc(notifC, 'publicProfiles', 'notifc'), validPublicProfile('notifc', 'Notif Charlie', 'notifc_handle')));
    });

    await check('setup: notifa creates a Post for notification testing', async () => {
      await assertSucceeds(
        setDoc(doc(notifA, 'content', 'post-notif-1'), validPost('notifa', 'Notif Alpha', 'notifa_handle', 'post-notif-1'))
      );
    });

    // --- LIKE notifications ---
    await check('ALLOW: B likes A\'s post + notification created atomically', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      const batch = writeBatch(notifB);
      batch.set(doc(notifB, 'content', 'post-notif-1', 'likes', 'notifb'), validLike('notifb'));
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'like', { contentId: 'post-notif-1' })
      );
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(notifA, 'notifications', notificationId));
      assert.equal(snapshot.exists(), true);
      assert.equal(snapshot.data().read, false);
      assert.equal(snapshot.data().recipientUid, 'notifa');
    });

    await check('DENY: self notification (A likes own post, notification targets self)', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifa');
      const batch = writeBatch(notifA);
      batch.set(doc(notifA, 'content', 'post-notif-1', 'likes', 'notifa'), validLike('notifa'));
      batch.set(
        doc(notifA, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifa', 'Notif Alpha', 'notifa_handle', 'like', { contentId: 'post-notif-1' })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: B creates a notification pretending actorUid = C', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifc');
      const batch = writeBatch(notifB);
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'like', { contentId: 'post-notif-1' })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: notification sent to an arbitrary recipient with no matching Like', async () => {
      // post-notif-1 is authored by notifa, not notifc — the content-author
      // check fails regardless of the (nonexistent) Like.
      const batch = writeBatch(notifB);
      batch.set(
        doc(notifB, 'notifications', 'like_post-notif-1_spoofed'),
        validNotification('like_post-notif-1_spoofed', 'notifc', 'notifb', 'Notif Bravo', 'notifb_handle', 'like', {
          contentId: 'post-notif-1',
        })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: fake Comment notification with no matching Comment', async () => {
      const notificationId = commentNotificationId('comment-fake-1');
      const batch = writeBatch(notifB);
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'comment', {
          contentId: 'post-notif-1',
          commentId: 'comment-fake-1',
        })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: fake Follow notification with no matching follow edge', async () => {
      const notificationId = followNotificationId('notifb', 'notifa');
      await assertFails(
        setDoc(
          doc(notifB, 'notifications', notificationId),
          validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'follow')
        )
      );
    });

    await check('DENY: wrong deterministic notification ID for a real Like', async () => {
      // The Like write itself is perfectly valid — only the notification's
      // document ID doesn't match contentId+actorUid. Atomicity means the
      // whole batch (including the otherwise-valid Like) is rejected.
      const batch = writeBatch(notifC);
      batch.set(doc(notifC, 'content', 'post-notif-1', 'likes', 'notifc'), validLike('notifc'));
      batch.set(
        doc(notifC, 'notifications', 'wrong-id'),
        validNotification('wrong-id', 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'like', { contentId: 'post-notif-1' })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: notification create with an extra unexpected field', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifc');
      const batch = writeBatch(notifC);
      batch.set(doc(notifC, 'content', 'post-notif-1', 'likes', 'notifc'), validLike('notifc'));
      batch.set(doc(notifC, 'notifications', notificationId), {
        ...validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'like', { contentId: 'post-notif-1' }),
        extra: 'nope',
      });
      await assertFails(batch.commit());
    });

    await check('ALLOW: authenticated recipient reads their own notification', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      await assertSucceeds(getDoc(doc(notifA, 'notifications', notificationId)));
    });

    await check('ALLOW: A queries their own notifications, newest first', async () => {
      const notificationsQuery = query(collection(notifA, 'notifications'), where('recipientUid', '==', 'notifa'));
      const snapshot = await assertSucceeds(getDocs(notificationsQuery));
      assert.ok(snapshot.size >= 1);
    });

    await check('DENY: unauthenticated read of a notification', async () => {
      const anonCtx = testEnv.unauthenticatedContext().firestore();
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      await assertFails(getDoc(doc(anonCtx, 'notifications', notificationId)));
    });

    await check('DENY: another authenticated user reads A\'s notification', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      await assertFails(getDoc(doc(notifC, 'notifications', notificationId)));
    });

    await check('ALLOW: A marks their own notification read', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      await assertSucceeds(updateDoc(doc(notifA, 'notifications', notificationId), { read: true, updatedAt: serverTimestamp() }));
      const snapshot = await getDoc(doc(notifA, 'notifications', notificationId));
      assert.equal(snapshot.data().read, true);
    });

    await check('DENY: B marks A\'s notification read', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      await assertFails(updateDoc(doc(notifB, 'notifications', notificationId), { read: true, updatedAt: serverTimestamp() }));
    });

    await check('DENY: A modifies recipientUid on their own notification', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      await assertFails(updateDoc(doc(notifA, 'notifications', notificationId), { recipientUid: 'notifc' }));
    });

    await check('DENY: A modifies actorDisplayName on their own notification', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      await assertFails(updateDoc(doc(notifA, 'notifications', notificationId), { actorDisplayName: 'Someone Else' }));
    });

    await check('DENY: B deletes their own notification without removing the underlying Like', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      // The Like from the first test is still there — deleting only the
      // notification would break "notification exists iff the action does".
      await assertFails(deleteDoc(doc(notifB, 'notifications', notificationId)));
    });

    await check('ALLOW: B unlikes + notification removed atomically', async () => {
      const notificationId = likeNotificationId('post-notif-1', 'notifb');
      const batch = writeBatch(notifB);
      batch.delete(doc(notifB, 'content', 'post-notif-1', 'likes', 'notifb'));
      batch.delete(doc(notifB, 'notifications', notificationId));
      await assertSucceeds(batch.commit());

      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const snapshot = await getDoc(doc(adminContext.firestore(), 'notifications', notificationId));
        assert.equal(snapshot.exists(), false);
      });
    });

    // --- COMMENT notifications ---
    await check('ALLOW: B comments on A\'s post + notification created atomically', async () => {
      const notificationId = commentNotificationId('comment-notif-1');
      const batch = writeBatch(notifB);
      batch.set(
        doc(notifB, 'content', 'post-notif-1', 'comments', 'comment-notif-1'),
        validComment('comment-notif-1', 'notifb', 'Notif Bravo', 'notifb_handle', 'Are you coming tonight?')
      );
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'comment', {
          contentId: 'post-notif-1',
          commentId: 'comment-notif-1',
          previewText: 'Are you coming tonight?',
        })
      );
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(notifA, 'notifications', notificationId));
      assert.equal(snapshot.data().previewText, 'Are you coming tonight?');
      assert.equal(snapshot.data().commentId, 'comment-notif-1');
    });

    await check('DENY: comment notification previewText far exceeds the safe preview bound', async () => {
      const notificationId = commentNotificationId('comment-notif-2');
      const batch = writeBatch(notifB);
      batch.set(
        doc(notifB, 'content', 'post-notif-1', 'comments', 'comment-notif-2'),
        validComment('comment-notif-2', 'notifb', 'Notif Bravo', 'notifb_handle', 'x'.repeat(300))
      );
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'comment', {
          contentId: 'post-notif-1',
          commentId: 'comment-notif-2',
          previewText: 'y'.repeat(600),
        })
      );
      await assertFails(batch.commit());
    });

    await check('ALLOW: B deletes their own comment + notification removed atomically', async () => {
      const notificationId = commentNotificationId('comment-notif-1');
      const batch = writeBatch(notifB);
      batch.delete(doc(notifB, 'content', 'post-notif-1', 'comments', 'comment-notif-1'));
      batch.delete(doc(notifB, 'notifications', notificationId));
      await assertSucceeds(batch.commit());

      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const snapshot = await getDoc(doc(adminContext.firestore(), 'notifications', notificationId));
        assert.equal(snapshot.exists(), false);
      });
    });

    // --- FOLLOW notifications ---
    await check('ALLOW: B follows A + notification created atomically', async () => {
      const notificationId = followNotificationId('notifb', 'notifa');
      const batch = writeBatch(notifB);
      batch.set(doc(notifB, 'follows', 'notifb_notifa'), validFollow('notifb', 'notifa'));
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'follow')
      );
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(notifA, 'notifications', notificationId));
      assert.equal(snapshot.data().type, 'follow');
      assert.equal(snapshot.data().contentId, null);
    });

    await check('ALLOW: recipient deletes their own notification directly (Inbox cleanup)', async () => {
      const notificationId = followNotificationId('notifb', 'notifa');
      await assertSucceeds(deleteDoc(doc(notifA, 'notifications', notificationId)));
      // Recreate it for the unfollow test below, since self-cleanup doesn't
      // touch the underlying follow edge.
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        await setDoc(
          doc(adminContext.firestore(), 'notifications', notificationId),
          validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'follow')
        );
      });
    });

    await check('ALLOW: B unfollows + notification removed atomically', async () => {
      const notificationId = followNotificationId('notifb', 'notifa');
      const batch = writeBatch(notifB);
      batch.delete(doc(notifB, 'follows', 'notifb_notifa'));
      batch.delete(doc(notifB, 'notifications', notificationId));
      await assertSucceeds(batch.commit());

      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const snapshot = await getDoc(doc(adminContext.firestore(), 'notifications', notificationId));
        assert.equal(snapshot.exists(), false);
      });
    });

    // --- Mark-all-as-read (bounded batch over an already-fetched list) ---
    await check('setup: two fresh notifications for A (from B and C)', async () => {
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const db = adminContext.firestore();
        await setDoc(
          doc(db, 'notifications', likeNotificationId('post-notif-1', 'notifb')),
          validNotification(likeNotificationId('post-notif-1', 'notifb'), 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'like', {
            contentId: 'post-notif-1',
          })
        );
        await setDoc(
          doc(db, 'notifications', followNotificationId('notifc', 'notifa')),
          validNotification(followNotificationId('notifc', 'notifa'), 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'follow')
        );
      });
    });

    await check('ALLOW: A marks all their own notifications read in one batch', async () => {
      const batch = writeBatch(notifA);
      batch.update(doc(notifA, 'notifications', likeNotificationId('post-notif-1', 'notifb')), { read: true, updatedAt: serverTimestamp() });
      batch.update(doc(notifA, 'notifications', followNotificationId('notifc', 'notifa')), { read: true, updatedAt: serverTimestamp() });
      await assertSucceeds(batch.commit());
    });

    await check('DENY: B batch-updates A\'s notification (not B\'s to mark read)', async () => {
      const batch = writeBatch(notifB);
      batch.update(doc(notifB, 'notifications', likeNotificationId('post-notif-1', 'notifb')), { read: true, updatedAt: serverTimestamp() });
      await assertFails(batch.commit());
    });

    // --- EVENT RESPONSE notifications (Step 38) ---
    await check('setup: notifa creates an Event for notification testing', async () => {
      await assertSucceeds(
        setDoc(doc(notifA, 'content', 'event-notif-1'), validEvent('notifa', 'Notif Alpha', 'notifa_handle', 'event-notif-1'))
      );
    });

    await check('ALLOW: B responds Interested to A\'s Event + notification created atomically', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifb');
      const batch = writeBatch(notifB);
      batch.set(doc(notifB, 'content', 'event-notif-1', 'responses', 'notifb'), validResponse('notifb', 'Notif Bravo', 'notifb_handle', 'interested'));
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'event_response', {
          contentId: 'event-notif-1',
          responseStatus: 'interested',
        })
      );
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(notifA, 'notifications', notificationId));
      assert.equal(snapshot.data().responseStatus, 'interested');
      assert.equal(snapshot.data().read, false);
    });

    await check('DENY: self notification (A responds to own Event)', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifa');
      const batch = writeBatch(notifA);
      batch.set(doc(notifA, 'content', 'event-notif-1', 'responses', 'notifa'), validResponse('notifa', 'Notif Alpha', 'notifa_handle', 'going'));
      batch.set(
        doc(notifA, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifa', 'Notif Alpha', 'notifa_handle', 'event_response', {
          contentId: 'event-notif-1',
          responseStatus: 'going',
        })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: notification recipient is not the Event\'s real author', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifc');
      const batch = writeBatch(notifC);
      batch.set(doc(notifC, 'content', 'event-notif-1', 'responses', 'notifc'), validResponse('notifc', 'Notif Charlie', 'notifc_handle', 'going'));
      batch.set(
        doc(notifC, 'notifications', notificationId),
        // Real author is notifa, not notifb — recipientUid is spoofed.
        validNotification(notificationId, 'notifb', 'notifc', 'Notif Charlie', 'notifc_handle', 'event_response', {
          contentId: 'event-notif-1',
          responseStatus: 'going',
        })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: Event response notification with no matching response document', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifc');
      await assertFails(
        setDoc(
          doc(notifC, 'notifications', notificationId),
          validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'event_response', {
            contentId: 'event-notif-1',
            responseStatus: 'going',
          })
        )
      );
    });

    await check('DENY: notification claims Interested while the real response is Going', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifc');
      const batch = writeBatch(notifC);
      batch.set(doc(notifC, 'content', 'event-notif-1', 'responses', 'notifc'), validResponse('notifc', 'Notif Charlie', 'notifc_handle', 'going'));
      batch.set(
        doc(notifC, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'event_response', {
          contentId: 'event-notif-1',
          responseStatus: 'interested', // mismatched — the response doc above says 'going'
        })
      );
      await assertFails(batch.commit());
    });

    await check('ALLOW: B switches Interested -> Going — same logical notification, unread again', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifb');
      const before = await getDoc(doc(notifA, 'notifications', notificationId));
      const beforeCreatedAt = before.data().createdAt;

      const batch = writeBatch(notifB);
      batch.update(doc(notifB, 'content', 'event-notif-1', 'responses', 'notifb'), { status: 'going', updatedAt: serverTimestamp() });
      batch.update(doc(notifB, 'notifications', notificationId), {
        responseStatus: 'going',
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await assertSucceeds(batch.commit());

      const after = await getDoc(doc(notifA, 'notifications', notificationId));
      assert.equal(after.data().responseStatus, 'going');
      assert.equal(after.data().read, false);
      assert.ok(after.data().createdAt.toMillis() > beforeCreatedAt.toMillis(), 'createdAt should bump so this resurfaces at the top of the Inbox');

      // Exactly one notification for this (event, actor) pair — never a
      // stale second "Interested" alongside the new "Going".
      const notifQuery = query(
        collection(notifA, 'notifications'),
        where('recipientUid', '==', 'notifa'),
        where('contentId', '==', 'event-notif-1'),
        where('actorUid', '==', 'notifb')
      );
      const notifSnapshot = await getDocs(notifQuery);
      assert.equal(notifSnapshot.size, 1);
    });

    await check('DENY: updating an event_response notification without a real response change', async () => {
      // The notification is already 'going' (from the test above) — trying
      // to "update" it to 'going' again (no actual state change) must fail,
      // even though the response doc itself is untouched in this batch.
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifb');
      await assertFails(
        updateDoc(doc(notifB, 'notifications', notificationId), {
          responseStatus: 'going',
          read: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    await check('DENY: changing an immutable field (actorUid) on an event_response notification update', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifb');
      const batch = writeBatch(notifB);
      batch.update(doc(notifB, 'content', 'event-notif-1', 'responses', 'notifb'), { status: 'interested', updatedAt: serverTimestamp() });
      batch.update(doc(notifB, 'notifications', notificationId), {
        actorUid: 'notifc',
        responseStatus: 'interested',
        read: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await assertFails(batch.commit());
    });

    await check('ALLOW: B removes their Event response + notification deleted atomically', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifb');
      const batch = writeBatch(notifB);
      batch.delete(doc(notifB, 'content', 'event-notif-1', 'responses', 'notifb'));
      batch.delete(doc(notifB, 'notifications', notificationId));
      await assertSucceeds(batch.commit());

      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const snapshot = await getDoc(doc(adminContext.firestore(), 'notifications', notificationId));
        assert.equal(snapshot.exists(), false);
      });
    });

    await check('DENY: deleting an event_response notification while the response still exists', async () => {
      const notificationId = eventResponseNotificationId('event-notif-1', 'notifc');
      // notifc's response + notification from the mismatch test above were
      // never committed (that batch failed), so seed a real one first.
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const db = adminContext.firestore();
        await setDoc(doc(db, 'content', 'event-notif-1', 'responses', 'notifc'), validResponse('notifc', 'Notif Charlie', 'notifc_handle', 'going'));
        await setDoc(
          doc(db, 'notifications', notificationId),
          validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'event_response', {
            contentId: 'event-notif-1',
            responseStatus: 'going',
          })
        );
      });
      await assertFails(deleteDoc(doc(notifC, 'notifications', notificationId)));
    });

    await check('DENY: arbitrary/unknown notification type', async () => {
      await assertFails(
        setDoc(doc(notifB, 'notifications', 'made-up-id'), {
          notificationId: 'made-up-id',
          recipientUid: 'notifa',
          actorUid: 'notifb',
          actorDisplayName: 'Notif Bravo',
          actorUsername: 'notifb_handle',
          type: 'made_up_type',
          contentId: null,
          reelId: null,
          commentId: null,
          previewText: null,
          responseStatus: null,
          read: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        })
      );
    });

    // --- ACTIVITY JOIN notifications (Step 38) ---
    await check('setup: notifa creates an Activity for notification testing', async () => {
      await assertSucceeds(
        setDoc(doc(notifA, 'content', 'activity-notif-1'), validActivity('notifa', 'Notif Alpha', 'notifa_handle', 'activity-notif-1'))
      );
    });

    await check('ALLOW: B joins A\'s Activity + notification + counter, all atomic', async () => {
      const notificationId = activityJoinNotificationId('activity-notif-1', 'notifb');
      const batch = writeBatch(notifB);
      batch.set(doc(notifB, 'content', 'activity-notif-1', 'participants', 'notifb'), validParticipant('notifb', 'Notif Bravo', 'notifb_handle'));
      batch.set(doc(notifB, 'content', 'activity-notif-1', 'stats', 'activity'), statsDoc(1));
      batch.set(
        doc(notifB, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifb', 'Notif Bravo', 'notifb_handle', 'activity_join', { contentId: 'activity-notif-1' })
      );
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(notifA, 'notifications', notificationId));
      assert.equal(snapshot.data().type, 'activity_join');
      assert.equal(snapshot.data().read, false);
    });

    await check('DENY: self notification (A joins own Activity)', async () => {
      // A isn't actually joining (that would be a legitimate no-notification
      // case) — this asserts that even an attempted self-targeted
      // notification is rejected outright.
      const notificationId = activityJoinNotificationId('activity-notif-1', 'notifa');
      await assertFails(
        setDoc(
          doc(notifA, 'notifications', notificationId),
          validNotification(notificationId, 'notifa', 'notifa', 'Notif Alpha', 'notifa_handle', 'activity_join', { contentId: 'activity-notif-1' })
        )
      );
    });

    await check('DENY: Activity join notification with no matching participant document', async () => {
      const notificationId = activityJoinNotificationId('activity-notif-1', 'notifc');
      await assertFails(
        setDoc(
          doc(notifC, 'notifications', notificationId),
          validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'activity_join', { contentId: 'activity-notif-1' })
        )
      );
    });

    await check('DENY: Activity join notification after a full Activity rejects the join', async () => {
      await assertSucceeds(
        setDoc(
          doc(notifA, 'content', 'activity-notif-full'),
          validActivity('notifa', 'Notif Alpha', 'notifa_handle', 'activity-notif-full', { maxParticipants: 1 })
        )
      );
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const db = adminContext.firestore();
        await setDoc(doc(db, 'content', 'activity-notif-full', 'participants', 'notifa'), validParticipant('notifa', 'Notif Alpha', 'notifa_handle'));
        await setDoc(doc(db, 'content', 'activity-notif-full', 'stats', 'activity'), statsDoc(1));
      });

      const notificationId = activityJoinNotificationId('activity-notif-full', 'notifc');
      const batch = writeBatch(notifC);
      // The participant create itself must fail (Activity already full at
      // maxParticipants) — since it's in the same batch as the
      // notification, the notification's existsAfter(participant) check
      // also fails, and the notification create is denied — proving
      // "notification exists" can never happen without a real successful
      // join, even inside one combined batch.
      batch.set(doc(notifC, 'content', 'activity-notif-full', 'participants', 'notifc'), validParticipant('notifc', 'Notif Charlie', 'notifc_handle'));
      batch.set(doc(notifC, 'content', 'activity-notif-full', 'stats', 'activity'), statsDoc(2));
      batch.set(
        doc(notifC, 'notifications', notificationId),
        validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'activity_join', { contentId: 'activity-notif-full' })
      );
      await assertFails(batch.commit());
    });

    await check('ALLOW: B leaves the Activity + notification deleted atomically', async () => {
      const notificationId = activityJoinNotificationId('activity-notif-1', 'notifb');
      const batch = writeBatch(notifB);
      batch.delete(doc(notifB, 'content', 'activity-notif-1', 'participants', 'notifb'));
      batch.set(doc(notifB, 'content', 'activity-notif-1', 'stats', 'activity'), statsDoc(0));
      batch.delete(doc(notifB, 'notifications', notificationId));
      await assertSucceeds(batch.commit());

      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const snapshot = await getDoc(doc(adminContext.firestore(), 'notifications', notificationId));
        assert.equal(snapshot.exists(), false);
      });
    });

    await check('DENY: deleting an activity_join notification while the participant still exists', async () => {
      const notificationId = activityJoinNotificationId('activity-notif-1', 'notifc');
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        const db = adminContext.firestore();
        await setDoc(doc(db, 'content', 'activity-notif-1', 'participants', 'notifc'), validParticipant('notifc', 'Notif Charlie', 'notifc_handle'));
        await setDoc(doc(db, 'content', 'activity-notif-1', 'stats', 'activity'), statsDoc(1));
        await setDoc(
          doc(db, 'notifications', notificationId),
          validNotification(notificationId, 'notifa', 'notifc', 'Notif Charlie', 'notifc_handle', 'activity_join', { contentId: 'activity-notif-1' })
        );
      });
      // notifc still has a real participant doc — deleting only the
      // notification (without leaving) must be denied.
      await assertFails(deleteDoc(doc(notifC, 'notifications', notificationId)));
    });

    await check('ALLOW: recipient marks an activity_join notification read', async () => {
      const notificationId = activityJoinNotificationId('activity-notif-1', 'notifc');
      await assertSucceeds(updateDoc(doc(notifA, 'notifications', notificationId), { read: true, updatedAt: serverTimestamp() }));
    });

    // =========================================================================
    // conversations/{conversationId} and conversations/{conversationId}/messages/{messageId}
    // Fresh users, independent of everything above.
    // =========================================================================
    await seedProfile(testEnv, 'msga', 'msga_handle', { displayName: 'Msg Alpha' });
    await seedProfile(testEnv, 'msgb', 'msgb_handle', { displayName: 'Msg Bravo' });
    await seedProfile(testEnv, 'msgc', 'msgc_handle', { displayName: 'Msg Charlie' });

    const msgA = testEnv.authenticatedContext('msga').firestore();
    const msgB = testEnv.authenticatedContext('msgb').firestore();
    const msgC = testEnv.authenticatedContext('msgc').firestore();

    await check('setup: message test users create matching public profiles', async () => {
      await assertSucceeds(setDoc(doc(msgA, 'publicProfiles', 'msga'), validPublicProfile('msga', 'Msg Alpha', 'msga_handle')));
      await assertSucceeds(setDoc(doc(msgB, 'publicProfiles', 'msgb'), validPublicProfile('msgb', 'Msg Bravo', 'msgb_handle')));
      await assertSucceeds(setDoc(doc(msgC, 'publicProfiles', 'msgc'), validPublicProfile('msgc', 'Msg Charlie', 'msgc_handle')));
    });

    // Regression: sendMessage's own "does this pair already have a
    // conversation?" pre-check reads a conversation that may not exist yet
    // — that read must succeed (returning "not found"), not error, or a
    // first message could never be sent. Reading a nonexistent document
    // reveals no data (there is none), so this is safe for any signed-in
    // user, not just the two eventual participants.
    await check('ALLOW: checking a nonexistent conversation for existence does not error', async () => {
      const snapshot = await assertSucceeds(getDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb'))));
      assert.equal(snapshot.exists(), false);
    });

    await check('DENY: unauthenticated user checking a nonexistent conversation', async () => {
      await assertFails(getDoc(doc(anon, 'conversations', conversationId('msga', 'msgb'))));
    });

    // Regression: the Chat screen's realtime listener queries this
    // subcollection immediately on open, before any message (and
    // therefore before the Conversation itself) exists — that query must
    // return empty, not error.
    await check('ALLOW: listing Messages of a not-yet-existing conversation returns empty, not an error', async () => {
      const snapshot = await assertSucceeds(getDocs(collection(msgA, 'conversations', conversationId('msga', 'msgb'), 'messages')));
      assert.equal(snapshot.size, 0);
    });

    await check('DENY: unauthenticated user listing Messages of a not-yet-existing conversation', async () => {
      await assertFails(getDocs(collection(anon, 'conversations', conversationId('msga', 'msgb'), 'messages')));
    });

    await check('ALLOW: A creates conversation with B atomically with first message', async () => {
      const convId = conversationId('msga', 'msgb');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-1'), validMessage('msg-1', 'msga', 'Hey there'));
      batch.set(doc(msgA, 'conversations', convId), validConversation('msga', 'msgb', 'msga', 'msg-1', 'Hey there'));
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(msgA, 'conversations', convId));
      assert.equal(snapshot.exists(), true);
      assert.deepEqual(snapshot.data().unreadCounts, { msga: 0, msgb: 1 });
      assert.deepEqual(snapshot.data().participantUids, ['msga', 'msgb']);
    });

    await check('ALLOW: A reads own conversation', async () => {
      await assertSucceeds(getDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb'))));
    });

    await check('ALLOW: B reads same conversation', async () => {
      await assertSucceeds(getDoc(doc(msgB, 'conversations', conversationId('msga', 'msgb'))));
    });

    await check('DENY: C reads A<->B conversation (privacy)', async () => {
      await assertFails(getDoc(doc(msgC, 'conversations', conversationId('msga', 'msgb'))));
    });

    await check('DENY: unauthenticated conversation read', async () => {
      await assertFails(getDoc(doc(anon, 'conversations', conversationId('msga', 'msgb'))));
    });

    await check('DENY: self-conversation', async () => {
      const selfId = conversationId('msga', 'msga');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', selfId, 'messages', 'msg-self'), validMessage('msg-self', 'msga', 'hi'));
      batch.set(doc(msgA, 'conversations', selfId), validConversation('msga', 'msga', 'msga', 'msg-self', 'hi'));
      await assertFails(batch.commit());
    });

    await check('DENY: wrong deterministic conversation ID', async () => {
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', 'wrong-id', 'messages', 'msg-wrong'), validMessage('msg-wrong', 'msga', 'hi'));
      batch.set(doc(msgA, 'conversations', 'wrong-id'), validConversation('msga', 'msgc', 'msga', 'msg-wrong', 'hi'));
      await assertFails(batch.commit());
    });

    await check('DENY: conversation with nonexistent public profile', async () => {
      const convId = conversationId('msga', 'msgghost');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-ghost'), validMessage('msg-ghost', 'msga', 'hi'));
      batch.set(doc(msgA, 'conversations', convId), validConversation('msga', 'msgghost', 'msga', 'msg-ghost', 'hi'));
      await assertFails(batch.commit());
    });

    await check('DENY: conversation create without a matching first Message', async () => {
      const convId = conversationId('msga', 'msgc');
      await assertFails(setDoc(doc(msgA, 'conversations', convId), validConversation('msga', 'msgc', 'msga', 'msg-missing', 'hi')));
    });

    await check('DENY: arbitrary participantUids not matching the actual sender', async () => {
      const convId = conversationId('msga', 'msgc');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-arb'), validMessage('msg-arb', 'msga', 'hi'));
      batch.set(doc(msgA, 'conversations', convId), {
        ...validConversation('msga', 'msgc', 'msga', 'msg-arb', 'hi'),
        participantUids: ['msgb', 'msgc'], // doesn't include msga, the real caller
      });
      await assertFails(batch.commit());
    });

    await check('DENY: change participantUids after creation', async () => {
      await assertFails(updateDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb')), { participantUids: ['msga', 'msgc'] }));
    });

    await check('DENY: direct unreadCount manipulation (arbitrary large value)', async () => {
      await assertFails(updateDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb')), { 'unreadCounts.msgb': 999 }));
    });

    await check('DENY: A resets B unread count to 0', async () => {
      await assertFails(updateDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb')), { 'unreadCounts.msgb': 0 }));
    });

    await check('DENY: negative unread count', async () => {
      await assertFails(updateDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb')), { 'unreadCounts.msga': -1 }));
    });

    await check('DENY: conversation delete', async () => {
      await assertFails(deleteDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb'))));
    });

    // --- messages/{messageId} ---
    await check('ALLOW: A sends a second message on existing conversation', async () => {
      const convId = conversationId('msga', 'msgb');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-2'), validMessage('msg-2', 'msga', 'Second message'));
      batch.update(doc(msgA, 'conversations', convId), {
        lastMessageId: 'msg-2',
        lastMessageText: 'Second message',
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgb': 2,
      });
      await assertSucceeds(batch.commit());
    });

    await check('ALLOW: B sends a reply', async () => {
      const convId = conversationId('msga', 'msgb');
      const batch = writeBatch(msgB);
      batch.set(doc(msgB, 'conversations', convId, 'messages', 'msg-3'), validMessage('msg-3', 'msgb', 'Reply!'));
      batch.update(doc(msgB, 'conversations', convId), {
        lastMessageId: 'msg-3',
        lastMessageText: 'Reply!',
        lastMessageSenderUid: 'msgb',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msgb': 0,
        'unreadCounts.msga': 1,
      });
      await assertSucceeds(batch.commit());
    });

    await check('ALLOW: A reads Messages', async () => {
      await assertSucceeds(getDocs(collection(msgA, 'conversations', conversationId('msga', 'msgb'), 'messages')));
    });

    await check('ALLOW: B reads Messages', async () => {
      await assertSucceeds(getDocs(collection(msgB, 'conversations', conversationId('msga', 'msgb'), 'messages')));
    });

    await check('DENY: unauthenticated message read', async () => {
      await assertFails(getDocs(collection(anon, 'conversations', conversationId('msga', 'msgb'), 'messages')));
    });

    await check('DENY: C reads A<->B messages', async () => {
      await assertFails(getDocs(collection(msgC, 'conversations', conversationId('msga', 'msgb'), 'messages')));
    });

    await check('DENY: C creates a message in A<->B conversation', async () => {
      await assertFails(
        setDoc(doc(msgC, 'conversations', conversationId('msga', 'msgb'), 'messages', 'msg-intrude'), validMessage('msg-intrude', 'msgc', 'sneaky'))
      );
    });

    await check('DENY: senderUid spoofing on message create', async () => {
      const convId = conversationId('msga', 'msgb');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-spoof'), validMessage('msg-spoof', 'msgb', 'pretend to be B'));
      batch.update(doc(msgA, 'conversations', convId), {
        lastMessageId: 'msg-spoof',
        lastMessageText: 'pretend to be B',
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgb': 2,
      });
      await assertFails(batch.commit());
    });

    await check('DENY: empty message body', async () => {
      const convId = conversationId('msga', 'msgb');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-empty'), validMessage('msg-empty', 'msga', ''));
      batch.update(doc(msgA, 'conversations', convId), {
        lastMessageId: 'msg-empty',
        lastMessageText: '',
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgb': 2,
      });
      await assertFails(batch.commit());
    });

    await check('DENY: message body over 1000 characters', async () => {
      const convId = conversationId('msga', 'msgb');
      const longBody = 'x'.repeat(1001);
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-long'), validMessage('msg-long', 'msga', longBody));
      batch.update(doc(msgA, 'conversations', convId), {
        lastMessageId: 'msg-long',
        lastMessageText: longBody,
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgb': 2,
      });
      await assertFails(batch.commit());
    });

    await check('DENY: messageId field does not match document ID', async () => {
      const convId = conversationId('msga', 'msgb');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-real-id'), validMessage('different-id', 'msga', 'hi'));
      batch.update(doc(msgA, 'conversations', convId), {
        lastMessageId: 'msg-real-id',
        lastMessageText: 'hi',
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgb': 2,
      });
      await assertFails(batch.commit());
    });

    await check('DENY: message create without a paired Conversation update', async () => {
      await assertFails(
        setDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb'), 'messages', 'msg-orphan'), validMessage('msg-orphan', 'msga', 'orphan'))
      );
    });

    await check('DENY: Message body differs from Conversation.lastMessageText', async () => {
      const convId = conversationId('msga', 'msgb');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'msg-mismatch'), validMessage('msg-mismatch', 'msga', 'real body'));
      batch.update(doc(msgA, 'conversations', convId), {
        lastMessageId: 'msg-mismatch',
        lastMessageText: 'DIFFERENT claimed text',
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgb': 2,
      });
      await assertFails(batch.commit());
    });

    await check('DENY: message update', async () => {
      await assertFails(updateDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb'), 'messages', 'msg-3'), { body: 'edited' }));
    });

    await check('DENY: message delete', async () => {
      await assertFails(deleteDoc(doc(msgA, 'conversations', conversationId('msga', 'msgb'), 'messages', 'msg-3')));
    });

    // =========================================================================
    // Unread flow — exact sequence verification (fresh A<->C pair).
    // 0/1 -> 0/2 -> 0/0 -> 1/0 -> 0/0
    // =========================================================================
    await check('UNREAD FLOW: exact sequence verified at every step', async () => {
      const convId = conversationId('msga', 'msgc');

      let batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'flow-1'), validMessage('flow-1', 'msga', 'one'));
      batch.set(doc(msgA, 'conversations', convId), validConversation('msga', 'msgc', 'msga', 'flow-1', 'one'));
      await assertSucceeds(batch.commit());
      let snapshot = await getDoc(doc(msgA, 'conversations', convId));
      assert.deepEqual(snapshot.data().unreadCounts, { msga: 0, msgc: 1 });

      batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convId, 'messages', 'flow-2'), validMessage('flow-2', 'msga', 'two'));
      batch.update(doc(msgA, 'conversations', convId), {
        lastMessageId: 'flow-2',
        lastMessageText: 'two',
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgc': 2,
      });
      await assertSucceeds(batch.commit());
      snapshot = await getDoc(doc(msgA, 'conversations', convId));
      assert.deepEqual(snapshot.data().unreadCounts, { msga: 0, msgc: 2 });

      await assertSucceeds(updateDoc(doc(msgC, 'conversations', convId), { 'unreadCounts.msgc': 0 }));
      snapshot = await getDoc(doc(msgC, 'conversations', convId));
      assert.deepEqual(snapshot.data().unreadCounts, { msga: 0, msgc: 0 });

      batch = writeBatch(msgC);
      batch.set(doc(msgC, 'conversations', convId, 'messages', 'flow-3'), validMessage('flow-3', 'msgc', 'three'));
      batch.update(doc(msgC, 'conversations', convId), {
        lastMessageId: 'flow-3',
        lastMessageText: 'three',
        lastMessageSenderUid: 'msgc',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msgc': 0,
        'unreadCounts.msga': 1,
      });
      await assertSucceeds(batch.commit());
      snapshot = await getDoc(doc(msgC, 'conversations', convId));
      assert.deepEqual(snapshot.data().unreadCounts, { msga: 1, msgc: 0 });

      await assertSucceeds(updateDoc(doc(msgA, 'conversations', convId), { 'unreadCounts.msga': 0 }));
      snapshot = await getDoc(doc(msgA, 'conversations', convId));
      assert.deepEqual(snapshot.data().unreadCounts, { msga: 0, msgc: 0 });
    });

    // =========================================================================
    // Conversation uniqueness — B "starting" with A resolves to the exact
    // same document A already created with B; a naive re-create is denied.
    // =========================================================================
    await check('UNIQUENESS: B\'s canonical ID for the pair equals A\'s, and re-creating it is denied', async () => {
      const convId = conversationId('msga', 'msgb');
      assert.equal(conversationId('msgb', 'msga'), convId);

      await assertFails(
        setDoc(doc(msgB, 'conversations', convId), validConversation('msgb', 'msga', 'msgb', 'fake-recreate', 'hijack'))
      );
    });

    // =========================================================================
    // Ordering — Inbox's fetchConversations-equivalent query orders by
    // lastMessageAt DESC, using real send-triggered timestamps.
    // =========================================================================
    await check('ORDERING: more-recently-active conversation sorts first', async () => {
      const convIdAC = conversationId('msga', 'msgc');
      const batch = writeBatch(msgA);
      batch.set(doc(msgA, 'conversations', convIdAC, 'messages', 'flow-4'), validMessage('flow-4', 'msga', 'newest'));
      batch.update(doc(msgA, 'conversations', convIdAC), {
        lastMessageId: 'flow-4',
        lastMessageText: 'newest',
        lastMessageSenderUid: 'msga',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.msga': 0,
        'unreadCounts.msgc': 1,
      });
      await assertSucceeds(batch.commit());

      const conversationsQuery = query(
        collection(msgA, 'conversations'),
        where('participantUids', 'array-contains', 'msga'),
        orderBy('lastMessageAt', 'desc')
      );
      const snapshot = await assertSucceeds(getDocs(conversationsQuery));
      const ids = snapshot.docs.map((docSnapshot) => docSnapshot.id);
      const acIndex = ids.indexOf(convIdAC);
      const abIndex = ids.indexOf(conversationId('msga', 'msgb'));
      assert.ok(acIndex !== -1 && abIndex !== -1);
      assert.ok(acIndex < abIndex, 'A<->C (just updated) should sort before A<->B (older)');
    });

    // =========================================================================
    // Step 17 — blocks, block-aware follow/like/comment/messaging,
    // message privacy, reports. Fresh users, independent of everything above.
    // =========================================================================
    await seedProfile(testEnv, 's17a', 's17a_handle', { displayName: 'Step17 Alpha' });
    await seedProfile(testEnv, 's17b', 's17b_handle', { displayName: 'Step17 Bravo' });
    await seedProfile(testEnv, 's17c', 's17c_handle', { displayName: 'Step17 Charlie' });
    await seedProfile(testEnv, 's17d', 's17d_handle', { displayName: 'Step17 Delta' });

    const s17a = testEnv.authenticatedContext('s17a').firestore();
    const s17b = testEnv.authenticatedContext('s17b').firestore();
    const s17c = testEnv.authenticatedContext('s17c').firestore();
    const s17d = testEnv.authenticatedContext('s17d').firestore();

    await check('setup: Step 17 users create matching public profiles', async () => {
      await assertSucceeds(setDoc(doc(s17a, 'publicProfiles', 's17a'), validPublicProfile('s17a', 'Step17 Alpha', 's17a_handle')));
      await assertSucceeds(setDoc(doc(s17b, 'publicProfiles', 's17b'), validPublicProfile('s17b', 'Step17 Bravo', 's17b_handle')));
      await assertSucceeds(setDoc(doc(s17c, 'publicProfiles', 's17c'), validPublicProfile('s17c', 'Step17 Charlie', 's17c_handle')));
      await assertSucceeds(setDoc(doc(s17d, 'publicProfiles', 's17d'), validPublicProfile('s17d', 'Step17 Delta', 's17d_handle')));
    });

    await check('setup: Step17 Alpha and Bravo each create a Post', async () => {
      await assertSucceeds(setDoc(doc(s17a, 'content', 'post-s17a-1'), validPost('s17a', 'Step17 Alpha', 's17a_handle', 'post-s17a-1')));
      await assertSucceeds(setDoc(doc(s17b, 'content', 'post-s17b-1'), validPost('s17b', 'Step17 Bravo', 's17b_handle', 'post-s17b-1')));
    });

    // --- blocks/{blockerUid}_{blockedUid} — attack tests ---
    await check('DENY: unauthenticated block create', async () => {
      await assertFails(setDoc(doc(anon, 'blocks', blockId('s17a', 's17b')), validBlock('s17a', 's17b')));
    });

    await check('DENY: block create with spoofed blockerUid', async () => {
      await assertFails(setDoc(doc(s17a, 'blocks', blockId('s17b', 's17c')), validBlock('s17b', 's17c')));
    });

    await check('DENY: self block', async () => {
      await assertFails(setDoc(doc(s17a, 'blocks', blockId('s17a', 's17a')), validBlock('s17a', 's17a')));
    });

    await check('DENY: block a nonexistent public profile', async () => {
      await assertFails(setDoc(doc(s17a, 'blocks', blockId('s17a', 'ghost-user')), validBlock('s17a', 'ghost-user')));
    });

    await check('DENY: wrong deterministic block ID', async () => {
      await assertFails(setDoc(doc(s17a, 'blocks', 'wrong-id'), validBlock('s17a', 's17b')));
    });

    // Regression: blockUser()'s own "is this already blocked?" pre-check
    // reads a block that, for a first-time block (the common case),
    // legitimately doesn't exist yet — that read must succeed (return
    // "not found"), not error.
    await check('ALLOW: checking a nonexistent block for existence does not error', async () => {
      const snapshot = await assertSucceeds(getDoc(doc(s17a, 'blocks', blockId('s17a', 's17b'))));
      assert.equal(snapshot.exists(), false);
    });

    await check('ALLOW: A blocks B', async () => {
      await assertSucceeds(setDoc(doc(s17a, 'blocks', blockId('s17a', 's17b')), validBlock('s17a', 's17b')));
    });

    await check('ALLOW: A reads own Block', async () => {
      await assertSucceeds(getDoc(doc(s17a, 'blocks', blockId('s17a', 's17b'))));
    });

    await check('DENY: B (the blocked user) reads A\'s block doc about them', async () => {
      await assertFails(getDoc(doc(s17b, 'blocks', blockId('s17a', 's17b'))));
    });

    await check('DENY: update a block', async () => {
      await assertFails(updateDoc(doc(s17a, 'blocks', blockId('s17a', 's17b')), { blockedUid: 's17c' }));
    });

    await check('DENY: B deletes A\'s block record', async () => {
      await assertFails(deleteDoc(doc(s17b, 'blocks', blockId('s17a', 's17b'))));
    });

    // --- block-aware follow/like/comment (A still blocking B) ---
    await check('DENY: B follows A while blocked', async () => {
      await assertFails(setDoc(doc(s17b, 'follows', 's17b_s17a'), validFollow('s17b', 's17a')));
    });

    await check('DENY: A follows B while blocking B', async () => {
      await assertFails(setDoc(doc(s17a, 'follows', 's17a_s17b'), validFollow('s17a', 's17b')));
    });

    await check('DENY: B likes A\'s post while blocked', async () => {
      await assertFails(setDoc(doc(s17b, 'content', 'post-s17a-1', 'likes', 's17b'), validLike('s17b')));
    });

    await check('DENY: A likes B\'s post while blocking B', async () => {
      await assertFails(setDoc(doc(s17a, 'content', 'post-s17b-1', 'likes', 's17a'), validLike('s17a')));
    });

    await check('DENY: B comments on A\'s post while blocked', async () => {
      await assertFails(
        setDoc(
          doc(s17b, 'content', 'post-s17a-1', 'comments', 'comment-blocked-1'),
          validComment('comment-blocked-1', 's17b', 'Step17 Bravo', 's17b_handle', 'hi')
        )
      );
    });

    await check('DENY: A comments on B\'s post while blocking B', async () => {
      await assertFails(
        setDoc(
          doc(s17a, 'content', 'post-s17b-1', 'comments', 'comment-blocked-2'),
          validComment('comment-blocked-2', 's17a', 'Step17 Alpha', 's17a_handle', 'hi')
        )
      );
    });

    // --- ALLOW: A unblocks B, ordinary interaction works again ---
    await check('ALLOW: A unblocks B', async () => {
      await assertSucceeds(deleteDoc(doc(s17a, 'blocks', blockId('s17a', 's17b'))));
    });

    await check('ALLOW: B can like A\'s post after being unblocked', async () => {
      await assertSucceeds(setDoc(doc(s17b, 'content', 'post-s17a-1', 'likes', 's17b'), validLike('s17b')));
    });

    // --- BLOCK TEST — FOLLOW: pre-existing edges removed, counts correct ---
    await check('setup: D follows A, A follows D (pre-existing follow edges for block-removal test)', async () => {
      await assertSucceeds(setDoc(doc(s17d, 'follows', 's17d_s17a'), validFollow('s17d', 's17a')));
      await assertSucceeds(setDoc(doc(s17a, 'follows', 's17a_s17d'), validFollow('s17a', 's17d')));
    });

    // Regression: these follow edges were seeded directly above (no paired
    // notification, unlike the real followUser() flow) — deliberately
    // mirroring a follow edge that predates the notifications feature (or
    // one created by any other means without its notification). blockUser()
    // needs to check "does a notification exist for this edge?" for edges
    // exactly like this, and that check must succeed (return "not found"),
    // not error.
    await check('ALLOW: checking a nonexistent notification for existence does not error', async () => {
      const snapshot = await assertSucceeds(getDoc(doc(s17a, 'notifications', 'follow_s17d_s17a')));
      assert.equal(snapshot.exists(), false);
    });

    await check('ALLOW: A blocks D, atomically removing BOTH pre-existing follow edges', async () => {
      const batch = writeBatch(s17a);
      batch.set(doc(s17a, 'blocks', blockId('s17a', 's17d')), validBlock('s17a', 's17d'));
      batch.delete(doc(s17a, 'follows', 's17a_s17d')); // A's own follow of D
      batch.delete(doc(s17a, 'follows', 's17d_s17a')); // D's inbound follow of A — needs the block-aware branch
      await assertSucceeds(batch.commit());

      const followerCount = await getCountFromServer(query(collection(s17a, 'follows'), where('followingUid', '==', 's17a')));
      const followingCount = await getCountFromServer(query(collection(s17a, 'follows'), where('followerUid', '==', 's17a')));
      assert.equal(followerCount.data().count, 0);
      assert.equal(followingCount.data().count, 0);
    });

    await check('DENY: A deletes an inbound follow with no accompanying block ("block must be the reason")', async () => {
      await assertSucceeds(setDoc(doc(s17c, 'follows', 's17c_s17a'), validFollow('s17c', 's17a')));
      await assertFails(deleteDoc(doc(s17a, 'follows', 's17c_s17a')));
      // cleanup this one properly (as the real follower) so it doesn't
      // pollute the ordering/aggregation assumptions of any later check.
      await assertSucceeds(deleteDoc(doc(s17c, 'follows', 's17c_s17a')));
    });

    // --- BLOCK TEST — FIRST MESSAGE: neither side can start a conversation ---
    await check('DENY: B cannot create a first conversation with A while blocked', async () => {
      await assertSucceeds(setDoc(doc(s17a, 'blocks', blockId('s17a', 's17b')), validBlock('s17a', 's17b'))); // re-block for this test
      const convId = conversationId('s17a', 's17b');
      const batch = writeBatch(s17b);
      batch.set(doc(s17b, 'conversations', convId, 'messages', 'msg-blocked-1'), validMessage('msg-blocked-1', 's17b', 'hi'));
      batch.set(doc(s17b, 'conversations', convId), validConversation('s17a', 's17b', 's17b', 'msg-blocked-1', 'hi'));
      await assertFails(batch.commit());
    });

    await check('DENY: A cannot create a first conversation with B while blocking B', async () => {
      const convId = conversationId('s17a', 's17b');
      const batch = writeBatch(s17a);
      batch.set(doc(s17a, 'conversations', convId, 'messages', 'msg-blocked-2'), validMessage('msg-blocked-2', 's17a', 'hi'));
      batch.set(doc(s17a, 'conversations', convId), validConversation('s17a', 's17b', 's17a', 'msg-blocked-2', 'hi'));
      await assertFails(batch.commit());
    });

    // --- BLOCK TEST — EXISTING CONVERSATION: blocked mid-thread, then unblocked ---
    await check('setup: A creates a conversation with D (existing-conversation block test)', async () => {
      const convId = conversationId('s17a', 's17d');
      const batch = writeBatch(s17a);
      batch.set(doc(s17a, 'conversations', convId, 'messages', 'msg-ad-1'), validMessage('msg-ad-1', 's17a', 'Hi D'));
      batch.set(doc(s17a, 'conversations', convId), validConversation('s17a', 's17d', 's17a', 'msg-ad-1', 'Hi D'));
      await assertSucceeds(batch.commit());
    });

    await check('DENY: A sends to D after blocking D (A already blocks D from the follow-removal test above)', async () => {
      const convId = conversationId('s17a', 's17d');
      const batch = writeBatch(s17a);
      batch.set(doc(s17a, 'conversations', convId, 'messages', 'msg-ad-2'), validMessage('msg-ad-2', 's17a', 'still there?'));
      batch.update(doc(s17a, 'conversations', convId), {
        lastMessageId: 'msg-ad-2',
        lastMessageText: 'still there?',
        lastMessageSenderUid: 's17a',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.s17a': 0,
        'unreadCounts.s17d': 1,
      });
      await assertFails(batch.commit());
    });

    await check('DENY: D sends to A while blocked', async () => {
      const convId = conversationId('s17a', 's17d');
      const batch = writeBatch(s17d);
      batch.set(doc(s17d, 'conversations', convId, 'messages', 'msg-ad-3'), validMessage('msg-ad-3', 's17d', 'hello?'));
      batch.update(doc(s17d, 'conversations', convId), {
        lastMessageId: 'msg-ad-3',
        lastMessageText: 'hello?',
        lastMessageSenderUid: 's17d',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.s17d': 0,
        'unreadCounts.s17a': 1,
      });
      await assertFails(batch.commit());
    });

    await check('ALLOW: both A and D can still read the existing conversation history while blocked', async () => {
      const convId = conversationId('s17a', 's17d');
      await assertSucceeds(getDoc(doc(s17a, 'conversations', convId)));
      await assertSucceeds(getDoc(doc(s17d, 'conversations', convId)));
      await assertSucceeds(getDocs(collection(s17a, 'conversations', convId, 'messages')));
      await assertSucceeds(getDocs(collection(s17d, 'conversations', convId, 'messages')));
    });

    await check('ALLOW: A unblocks D', async () => {
      await assertSucceeds(deleteDoc(doc(s17a, 'blocks', blockId('s17a', 's17d'))));
    });

    await check('ALLOW: A can send to D again after unblocking', async () => {
      const convId = conversationId('s17a', 's17d');
      const batch = writeBatch(s17a);
      batch.set(doc(s17a, 'conversations', convId, 'messages', 'msg-ad-4'), validMessage('msg-ad-4', 's17a', 'back now'));
      batch.update(doc(s17a, 'conversations', convId), {
        lastMessageId: 'msg-ad-4',
        lastMessageText: 'back now',
        lastMessageSenderUid: 's17a',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.s17a': 0,
        'unreadCounts.s17d': 1,
      });
      await assertSucceeds(batch.commit());
    });

    // =========================================================================
    // Message privacy — fresh pairs per scenario so the "existing
    // conversation exception" from one test never leaks into another.
    // =========================================================================
    await seedProfile(testEnv, 'prva', 'prva_handle', { displayName: 'Privacy Alpha' });
    await seedProfile(testEnv, 'prvb', 'prvb_handle', { displayName: 'Privacy Bravo' });
    await seedProfile(testEnv, 'prvc', 'prvc_handle', { displayName: 'Privacy Charlie' });
    await seedProfile(testEnv, 'prvd', 'prvd_handle', { displayName: 'Privacy Delta' });
    await seedProfile(testEnv, 'prve', 'prve_handle', { displayName: 'Privacy Echo' });
    await seedProfile(testEnv, 'prvf', 'prvf_handle', { displayName: 'Privacy Foxtrot' });
    await seedProfile(testEnv, 'prvg', 'prvg_handle', { displayName: 'Privacy Golf' });

    const prvA = testEnv.authenticatedContext('prva').firestore();
    const prvB = testEnv.authenticatedContext('prvb').firestore();
    const prvC = testEnv.authenticatedContext('prvc').firestore();
    const prvD = testEnv.authenticatedContext('prvd').firestore();
    const prvE = testEnv.authenticatedContext('prve').firestore();
    const prvF = testEnv.authenticatedContext('prvf').firestore();
    const prvG = testEnv.authenticatedContext('prvg').firestore();

    await check('setup: privacy test users create matching public profiles', async () => {
      await assertSucceeds(setDoc(doc(prvA, 'publicProfiles', 'prva'), validPublicProfile('prva', 'Privacy Alpha', 'prva_handle')));
      await assertSucceeds(setDoc(doc(prvB, 'publicProfiles', 'prvb'), validPublicProfile('prvb', 'Privacy Bravo', 'prvb_handle')));
      await assertSucceeds(setDoc(doc(prvC, 'publicProfiles', 'prvc'), validPublicProfile('prvc', 'Privacy Charlie', 'prvc_handle')));
      await assertSucceeds(setDoc(doc(prvD, 'publicProfiles', 'prvd'), validPublicProfile('prvd', 'Privacy Delta', 'prvd_handle')));
      await assertSucceeds(setDoc(doc(prvE, 'publicProfiles', 'prve'), validPublicProfile('prve', 'Privacy Echo', 'prve_handle')));
      await assertSucceeds(setDoc(doc(prvF, 'publicProfiles', 'prvf'), validPublicProfile('prvf', 'Privacy Foxtrot', 'prvf_handle')));
      await assertSucceeds(setDoc(doc(prvG, 'publicProfiles', 'prvg'), validPublicProfile('prvg', 'Privacy Golf', 'prvg_handle')));
    });

    // --- PRIVACY TEST — everyone (no doc / default) ---
    await check('ALLOW: B starts a conversation with A, who has no privacy doc (defaults to everyone)', async () => {
      const convId = conversationId('prva', 'prvb');
      const batch = writeBatch(prvB);
      batch.set(doc(prvB, 'conversations', convId, 'messages', 'msg-priv-1'), validMessage('msg-priv-1', 'prvb', 'hi A'));
      batch.set(doc(prvB, 'conversations', convId), validConversation('prva', 'prvb', 'prvb', 'msg-priv-1', 'hi A'));
      await assertSucceeds(batch.commit());
    });

    // --- PRIVACY TEST — people_i_follow ---
    await check('ALLOW: C sets message privacy to people_i_follow', async () => {
      await assertSucceeds(setDoc(doc(prvC, 'privacySettings', 'prvc'), validPrivacySettings('prvc', 'people_i_follow')));
    });

    await check('DENY: D cannot start a conversation with C (C does not follow D)', async () => {
      const convId = conversationId('prvc', 'prvd');
      const batch = writeBatch(prvD);
      batch.set(doc(prvD, 'conversations', convId, 'messages', 'msg-priv-2'), validMessage('msg-priv-2', 'prvd', 'hi C'));
      batch.set(doc(prvD, 'conversations', convId), validConversation('prvc', 'prvd', 'prvd', 'msg-priv-2', 'hi C'));
      await assertFails(batch.commit());
    });

    await check('setup: C follows D', async () => {
      await assertSucceeds(setDoc(doc(prvC, 'follows', 'prvc_prvd'), validFollow('prvc', 'prvd')));
    });

    await check('ALLOW: D can now start a conversation with C (C follows D)', async () => {
      const convId = conversationId('prvc', 'prvd');
      const batch = writeBatch(prvD);
      batch.set(doc(prvD, 'conversations', convId, 'messages', 'msg-priv-3'), validMessage('msg-priv-3', 'prvd', 'hi C, take 2'));
      batch.set(doc(prvD, 'conversations', convId), validConversation('prvc', 'prvd', 'prvd', 'msg-priv-3', 'hi C, take 2'));
      await assertSucceeds(batch.commit());
    });

    // --- PRIVACY TEST — nobody, with the existing-conversation exception ---
    await check('setup: E and F start a conversation while E has no privacy doc yet', async () => {
      const convId = conversationId('prve', 'prvf');
      const batch = writeBatch(prvF);
      batch.set(doc(prvF, 'conversations', convId, 'messages', 'msg-priv-4'), validMessage('msg-priv-4', 'prvf', 'hi E'));
      batch.set(doc(prvF, 'conversations', convId), validConversation('prve', 'prvf', 'prvf', 'msg-priv-4', 'hi E'));
      await assertSucceeds(batch.commit());
    });

    await check('ALLOW: E sets message privacy to nobody', async () => {
      await assertSucceeds(setDoc(doc(prvE, 'privacySettings', 'prve'), validPrivacySettings('prve', 'nobody')));
    });

    await check('DENY: a brand-new conversation cannot be started with E now that E is set to nobody', async () => {
      const convId = conversationId('prve', 'prvg');
      const batch = writeBatch(prvG);
      batch.set(doc(prvG, 'conversations', convId, 'messages', 'msg-priv-5'), validMessage('msg-priv-5', 'prvg', 'hi E'));
      batch.set(doc(prvG, 'conversations', convId), validConversation('prve', 'prvg', 'prvg', 'msg-priv-5', 'hi E'));
      await assertFails(batch.commit());
    });

    await check('ALLOW: the EXISTING E<->F conversation still works after E sets nobody', async () => {
      const convId = conversationId('prve', 'prvf');
      const batch = writeBatch(prvF);
      batch.set(doc(prvF, 'conversations', convId, 'messages', 'msg-priv-6'), validMessage('msg-priv-6', 'prvf', 'still there?'));
      batch.update(doc(prvF, 'conversations', convId), {
        lastMessageId: 'msg-priv-6',
        lastMessageText: 'still there?',
        lastMessageSenderUid: 'prvf',
        lastMessageAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        'unreadCounts.prvf': 0,
        'unreadCounts.prve': 2,
      });
      await assertSucceeds(batch.commit());
    });

    // --- privacySettings/{uid} rules ---
    await check('ALLOW: owner creates privacySettings', async () => {
      await assertSucceeds(setDoc(doc(prvA, 'privacySettings', 'prva'), validPrivacySettings('prva', 'everyone')));
    });

    await check('ALLOW: owner reads own privacySettings', async () => {
      await assertSucceeds(getDoc(doc(prvA, 'privacySettings', 'prva')));
    });

    await check('ALLOW: owner changes everyone -> people_i_follow -> nobody', async () => {
      await assertSucceeds(updateDoc(doc(prvA, 'privacySettings', 'prva'), { newMessagesFrom: 'people_i_follow', updatedAt: serverTimestamp() }));
      await assertSucceeds(updateDoc(doc(prvA, 'privacySettings', 'prva'), { newMessagesFrom: 'nobody', updatedAt: serverTimestamp() }));
    });

    await check('DENY: another user writes someone else\'s privacySettings', async () => {
      await assertFails(setDoc(doc(prvB, 'privacySettings', 'prva'), validPrivacySettings('prva', 'nobody')));
      await assertFails(updateDoc(doc(prvB, 'privacySettings', 'prva'), { newMessagesFrom: 'everyone' }));
    });

    await check('DENY: invalid newMessagesFrom enum value', async () => {
      await assertFails(setDoc(doc(prvB, 'privacySettings', 'prvb'), validPrivacySettings('prvb', 'literally_anyone')));
    });

    await check('DENY: changing uid on update', async () => {
      await assertFails(updateDoc(doc(prvA, 'privacySettings', 'prva'), { uid: 'prvb', updatedAt: serverTimestamp() }));
    });

    await check('DENY: changing createdAt on update', async () => {
      await assertFails(updateDoc(doc(prvA, 'privacySettings', 'prva'), { createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    });

    await check('DENY: extra field on privacySettings create', async () => {
      await assertFails(setDoc(doc(prvB, 'privacySettings', 'prvb'), { ...validPrivacySettings('prvb', 'everyone'), note: 'x' }));
    });

    await check('DENY: delete privacySettings', async () => {
      await assertFails(deleteDoc(doc(prvA, 'privacySettings', 'prva')));
    });

    // =========================================================================
    // Reports — reusing the Step 17 block-test users/content/conversation
    // (s17a/s17b/s17c/s17d, post-s17a-1, and the A<->D conversation).
    // =========================================================================

    // Regression: reportUser/reportContent/reportMessage's own
    // duplicate-report pre-check reads a report that, for a first-time
    // report (the common case), legitimately doesn't exist yet — that
    // read must succeed (return "not found"), not error.
    await check('ALLOW: checking a nonexistent report for existence does not error', async () => {
      const snapshot = await assertSucceeds(getDoc(doc(s17c, 'reports', userReportId('s17c', 's17a'))));
      assert.equal(snapshot.exists(), false);
    });

    await check('ALLOW: valid user report', async () => {
      const reportId = userReportId('s17c', 's17a');
      await assertSucceeds(setDoc(doc(s17c, 'reports', reportId), validReport(reportId, 's17c', 'user', { targetUid: 's17a' })));
    });

    await check('ALLOW: valid published-content report', async () => {
      const reportId = contentReportId('s17c', 'post-s17a-1');
      await assertSucceeds(
        setDoc(doc(s17c, 'reports', reportId), validReport(reportId, 's17c', 'content', { contentId: 'post-s17a-1', targetUid: 's17a' }))
      );
    });

    await check('ALLOW: valid received-message report', async () => {
      const convId = conversationId('s17a', 's17d');
      const reportId = messageReportId('s17d', 'msg-ad-1');
      await assertSucceeds(
        setDoc(
          doc(s17d, 'reports', reportId),
          validReport(reportId, 's17d', 'message', { conversationId: convId, messageId: 'msg-ad-1', targetUid: 's17a' })
        )
      );
    });

    await check('DENY: unauthenticated report', async () => {
      const reportId = userReportId('ghost', 's17a');
      await assertFails(setDoc(doc(anon, 'reports', reportId), validReport(reportId, 'ghost', 'user', { targetUid: 's17a' })));
    });

    await check('DENY: reporterUid spoofing', async () => {
      const reportId = userReportId('s17b', 's17c');
      await assertFails(setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17c', 'user', { targetUid: 's17c' })));
    });

    await check('DENY: report a nonexistent user', async () => {
      const reportId = userReportId('s17b', 'ghost-user');
      await assertFails(setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'user', { targetUid: 'ghost-user' })));
    });

    await check('DENY: self user report', async () => {
      const reportId = userReportId('s17b', 's17b');
      await assertFails(setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'user', { targetUid: 's17b' })));
    });

    await check('DENY: report nonexistent content', async () => {
      const reportId = contentReportId('s17b', 'does-not-exist');
      await assertFails(
        setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'content', { contentId: 'does-not-exist', targetUid: 's17a' }))
      );
    });

    await check('DENY: report content with spoofed targetUid', async () => {
      const reportId = contentReportId('s17b', 'post-s17a-1');
      await assertFails(
        setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'content', { contentId: 'post-s17a-1', targetUid: 's17b' }))
      );
    });

    // Step 39.1: isValidContentReport now independently enforces
    // targetUid != request.auth.uid, matching isValidUserReport and
    // isValidReelReport — this was the one report type that previously let
    // an author report their own published Post/Activity/Event.
    await check('DENY: self content report', async () => {
      const reportId = contentReportId('s17b', 'post-s17b-1');
      await assertFails(
        setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'content', { contentId: 'post-s17b-1', targetUid: 's17b' }))
      );
    });

    await check('DENY: third user reports a private message they cannot access', async () => {
      const convId = conversationId('s17a', 's17d');
      const reportId = messageReportId('s17c', 'msg-ad-1');
      await assertFails(
        setDoc(
          doc(s17c, 'reports', reportId),
          validReport(reportId, 's17c', 'message', { conversationId: convId, messageId: 'msg-ad-1', targetUid: 's17a' })
        )
      );
    });

    await check('DENY: report own message', async () => {
      const convId = conversationId('s17a', 's17d');
      const reportId = messageReportId('s17a', 'msg-ad-1');
      await assertFails(
        setDoc(
          doc(s17a, 'reports', reportId),
          validReport(reportId, 's17a', 'message', { conversationId: convId, messageId: 'msg-ad-1', targetUid: 's17a' })
        )
      );
    });

    await check('DENY: invalid report reason', async () => {
      const reportId = userReportId('s17b', 's17a');
      await assertFails(setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'user', { targetUid: 's17a', reason: 'not-a-reason' })));
    });

    await check('DENY: oversized report details', async () => {
      const reportId = userReportId('s17b', 's17a');
      await assertFails(
        setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'user', { targetUid: 's17a', details: 'x'.repeat(1001) }))
      );
    });

    await check('DENY: arbitrary extra field on report', async () => {
      const reportId = userReportId('s17b', 's17a');
      await assertFails(setDoc(doc(s17b, 'reports', reportId), { ...validReport(reportId, 's17b', 'user', { targetUid: 's17a' }), extra: 'nope' }));
    });

    // Step 39.1: a client may only ever create a report in the canonical
    // initial moderation state — it can never pre-seed dismissed/resolved,
    // a moderatedAt, or a moderatedByUid to fake a prior review.
    await check('DENY: report create with non-open status', async () => {
      const reportId = userReportId('s17b', 's17a');
      await assertFails(
        setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'user', { targetUid: 's17a', status: 'dismissed' }))
      );
    });

    await check('DENY: report create with non-null moderatedAt', async () => {
      const reportId = userReportId('s17b', 's17a');
      await assertFails(
        setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'user', { targetUid: 's17a', moderatedAt: serverTimestamp() }))
      );
    });

    await check('DENY: report create with non-null moderatedByUid', async () => {
      const reportId = userReportId('s17b', 's17a');
      await assertFails(
        setDoc(doc(s17b, 'reports', reportId), validReport(reportId, 's17b', 'user', { targetUid: 's17a', moderatedByUid: 's17b' }))
      );
    });

    await check('DENY: update a report', async () => {
      await assertFails(updateDoc(doc(s17c, 'reports', userReportId('s17c', 's17a')), { reason: 'other' }));
    });

    await check('DENY: delete a report', async () => {
      await assertFails(deleteDoc(doc(s17c, 'reports', userReportId('s17c', 's17a'))));
    });

    await check('DENY: reported user reads the report about them', async () => {
      await assertFails(getDoc(doc(s17a, 'reports', userReportId('s17c', 's17a'))));
    });

    await check('DENY: unrelated authenticated user reads someone else\'s report', async () => {
      await assertFails(getDoc(doc(s17b, 'reports', userReportId('s17c', 's17a'))));
    });

    // ==========================================================
    // Step 18 — reels/{reelId} (see firestore.rules and
    // src/services/reels.ts's two-phase uploading -> published lifecycle)
    // ==========================================================

    await seedProfile(testEnv, 'r18a', 'r18a_handle', { displayName: 'Reel Author' });
    await seedProfile(testEnv, 'r18b', 'r18b_handle', { displayName: 'Reel Viewer' });

    const r18a = testEnv.authenticatedContext('r18a').firestore();
    const r18b = testEnv.authenticatedContext('r18b').firestore();

    await check('DENY: unauthenticated Reel create', async () => {
      await assertFails(setDoc(doc(anon, 'reels', 'reel-1'), validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1')));
    });

    await check('DENY: Reel create with spoofed authorUid', async () => {
      await assertFails(setDoc(doc(r18b, 'reels', 'reel-1'), validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1')));
    });

    await check('DENY: Reel create with spoofed authorDisplayName', async () => {
      await assertFails(
        setDoc(doc(r18a, 'reels', 'reel-1'), validReel('r18a', 'Fake Name', 'r18a_handle', 'reel-1'))
      );
    });

    await check('DENY: Reel create with spoofed authorUsername', async () => {
      await assertFails(
        setDoc(doc(r18a, 'reels', 'reel-1'), validReel('r18a', 'Reel Author', 'fake_handle', 'reel-1'))
      );
    });

    await check('DENY: Reel create with spoofed city', async () => {
      await assertFails(
        setDoc(
          doc(r18a, 'reels', 'reel-1'),
          validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1', { cityName: 'Stockholm', cityKey: 'se:stockholm' })
        )
      );
    });

    await check('DENY: Reel create with empty category', async () => {
      await assertFails(
        setDoc(doc(r18a, 'reels', 'reel-1'), validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1', { categoryId: '' }))
      );
    });

    await check('DENY: Reel create with storagePath not matching authorUid/reelId', async () => {
      await assertFails(
        setDoc(
          doc(r18a, 'reels', 'reel-1'),
          validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1', { storagePath: reelStoragePath('r18a', 'some-other-reel') })
        )
      );
    });

    await check('DENY: Reel create with non-video contentType', async () => {
      await assertFails(
        setDoc(
          doc(r18a, 'reels', 'reel-1'),
          validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1', { storageContentType: 'image/png' })
        )
      );
    });

    await check('DENY: Reel create with declared file size over 50 MB', async () => {
      await assertFails(
        setDoc(
          doc(r18a, 'reels', 'reel-1'),
          validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1', { fileSizeBytes: 52428801 })
        )
      );
    });

    await check('DENY: Reel create with declared duration over 60 seconds', async () => {
      await assertFails(
        setDoc(
          doc(r18a, 'reels', 'reel-1'),
          validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1', { durationMs: 60001 })
        )
      );
    });

    await check('DENY: Reel created directly as published', async () => {
      await assertFails(
        setDoc(
          doc(r18a, 'reels', 'reel-1'),
          validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1', { status: 'published', publishedAt: serverTimestamp() })
        )
      );
    });

    await check('ALLOW: completed user creates a valid uploading Reel', async () => {
      await assertSucceeds(setDoc(doc(r18a, 'reels', 'reel-1'), validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-1')));
    });

    await check('ALLOW: author reads their own uploading Reel', async () => {
      const snapshot = await assertSucceeds(getDoc(doc(r18a, 'reels', 'reel-1')));
      assert.equal(snapshot.data().status, 'uploading');
    });

    await check('DENY: a different user reads someone else\'s uploading Reel', async () => {
      await assertFails(getDoc(doc(r18b, 'reels', 'reel-1')));
    });

    await check('DENY: a different user publishes someone else\'s draft', async () => {
      await assertFails(
        updateDoc(doc(r18b, 'reels', 'reel-1'), { status: 'published', publishedAt: serverTimestamp(), updatedAt: serverTimestamp() })
      );
    });

    await check('DENY: publish while changing the caption', async () => {
      await assertFails(
        updateDoc(doc(r18a, 'reels', 'reel-1'), {
          status: 'published',
          publishedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          caption: 'sneaky edit',
        })
      );
    });

    await check('DENY: publish while changing the city', async () => {
      await assertFails(
        updateDoc(doc(r18a, 'reels', 'reel-1'), {
          status: 'published',
          publishedAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          cityKey: 'se:stockholm',
        })
      );
    });

    await check('ALLOW: author publishes their own Reel (uploading -> published)', async () => {
      await assertSucceeds(
        updateDoc(doc(r18a, 'reels', 'reel-1'), { status: 'published', publishedAt: serverTimestamp(), updatedAt: serverTimestamp() })
      );
    });

    await check('DENY: update a published Reel', async () => {
      await assertFails(updateDoc(doc(r18a, 'reels', 'reel-1'), { caption: 'edit after publish' }));
    });

    await check('DENY: delete a published Reel', async () => {
      await assertFails(deleteDoc(doc(r18a, 'reels', 'reel-1')));
    });

    await check('ALLOW: any authenticated user reads a published Reel', async () => {
      const snapshot = await assertSucceeds(getDoc(doc(r18b, 'reels', 'reel-1')));
      assert.equal(snapshot.data().status, 'published');
    });

    await check('ALLOW: city Reel feed query returns the published Reel', async () => {
      const snapshot = await assertSucceeds(
        getDocs(
          query(
            collection(r18b, 'reels'),
            where('cityKey', '==', 'se:karlstad'),
            where('status', '==', 'published'),
            orderBy('publishedAt', 'desc')
          )
        )
      );
      assert.ok(snapshot.docs.some((d) => d.id === 'reel-1'));
    });

    await check('setup: a second draft for delete/other-user-delete tests', async () => {
      await assertSucceeds(setDoc(doc(r18a, 'reels', 'reel-2'), validReel('r18a', 'Reel Author', 'r18a_handle', 'reel-2')));
    });

    await check('DENY: a different user deletes someone else\'s uploading draft', async () => {
      await assertFails(deleteDoc(doc(r18b, 'reels', 'reel-2')));
    });

    await check('ALLOW: author deletes their own still-uploading draft', async () => {
      await assertSucceeds(deleteDoc(doc(r18a, 'reels', 'reel-2')));
    });

    // --- Reel reports (reports/{reportId} targetType == 'reel') ---

    await check('ALLOW: valid published-Reel report', async () => {
      const reportId = reelReportId('r18b', 'reel-1');
      await assertSucceeds(
        setDoc(doc(r18b, 'reports', reportId), validReport(reportId, 'r18b', 'reel', { reelId: 'reel-1', targetUid: 'r18a' }))
      );
    });

    await check('DENY: Reel report with spoofed targetUid', async () => {
      const reportId = reelReportId('r18b', 'reel-1');
      await assertFails(
        setDoc(doc(r18b, 'reports', reportId), validReport(reportId, 'r18b', 'reel', { reelId: 'reel-1', targetUid: 'r18b' }))
      );
    });

    await check('DENY: self Reel report', async () => {
      const reportId = reelReportId('r18a', 'reel-1');
      await assertFails(
        setDoc(doc(r18a, 'reports', reportId), validReport(reportId, 'r18a', 'reel', { reelId: 'reel-1', targetUid: 'r18a' }))
      );
    });

    await check('DENY: report a nonexistent Reel', async () => {
      const reportId = reelReportId('r18b', 'does-not-exist');
      await assertFails(
        setDoc(doc(r18b, 'reports', reportId), validReport(reportId, 'r18b', 'reel', { reelId: 'does-not-exist', targetUid: 'r18a' }))
      );
    });

    await check('DENY: reported Reel author reads the report about them', async () => {
      await assertFails(getDoc(doc(r18a, 'reports', reelReportId('r18b', 'reel-1'))));
    });

    // ==========================================================
    // Step 19 — Reel engagement: reels/{reelId}/likes,
    // reels/{reelId}/comments, and reel_like/reel_comment
    // notifications. Fresh users, independent of everything above.
    // ==========================================================

    await seedProfile(testEnv, 's19a', 's19a_handle', { displayName: 'Step19 Alpha' });
    await seedProfile(testEnv, 's19b', 's19b_handle', { displayName: 'Step19 Bravo' });
    await seedProfile(testEnv, 's19c', 's19c_handle', { displayName: 'Step19 Charlie' });

    const s19a = testEnv.authenticatedContext('s19a').firestore();
    const s19b = testEnv.authenticatedContext('s19b').firestore();
    const s19c = testEnv.authenticatedContext('s19c').firestore();

    await seedReel(testEnv, 's19a', 'Step19 Alpha', 's19a_handle', 'reel-19-1');
    await seedReel(testEnv, 's19a', 'Step19 Alpha', 's19a_handle', 'reel-19-draft', { status: 'uploading', publishedAt: null });

    // --- Reel Likes: create ---

    await check('DENY: unauthenticated Reel like', async () => {
      await assertFails(setDoc(doc(anon, 'reels', 'reel-19-1', 'likes', 's19c'), validLike('s19c')));
    });

    await check('DENY: Reel Like doc ID does not match auth uid', async () => {
      await assertFails(setDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19c'), validLike('s19c')));
    });

    await check('DENY: Reel Like uid field spoofed (doc id matches auth, field does not)', async () => {
      await assertFails(setDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b'), validLike('s19c')));
    });

    await check('DENY: like an unpublished (uploading) Reel', async () => {
      await assertFails(setDoc(doc(s19b, 'reels', 'reel-19-draft', 'likes', 's19b'), validLike('s19b')));
    });

    await check('DENY: like a nonexistent Reel', async () => {
      await assertFails(setDoc(doc(s19b, 'reels', 'does-not-exist', 'likes', 's19b'), validLike('s19b')));
    });

    await check('ALLOW: B likes A\'s published Reel', async () => {
      await assertSucceeds(setDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b'), validLike('s19b')));
    });

    await check('ALLOW: self-like (A likes own Reel) — same product behavior as content Likes', async () => {
      await assertSucceeds(setDoc(doc(s19a, 'reels', 'reel-19-1', 'likes', 's19a'), validLike('s19a')));
    });

    await check('DENY: update a Reel Like (re-liking must go through create, not update)', async () => {
      await assertFails(updateDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b'), { createdAt: serverTimestamp() }));
    });

    await check('ALLOW: C (any authenticated user) reads a Like on a published Reel', async () => {
      await assertSucceeds(getDoc(doc(s19c, 'reels', 'reel-19-1', 'likes', 's19b')));
    });

    await check('DENY: C deletes B\'s Reel Like', async () => {
      await assertFails(deleteDoc(doc(s19c, 'reels', 'reel-19-1', 'likes', 's19b')));
    });

    await check('ALLOW: B unlikes (deletes their own Reel Like)', async () => {
      await assertSucceeds(deleteDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b')));
    });

    await check('ALLOW: A removes their own self-like', async () => {
      await assertSucceeds(deleteDoc(doc(s19a, 'reels', 'reel-19-1', 'likes', 's19a')));
    });

    // --- Reel Comments: create/read/update/delete ---

    await check('DENY: unauthenticated Reel comment', async () => {
      await assertFails(
        setDoc(doc(anon, 'reels', 'reel-19-1', 'comments', 'reel-comment-x'), validComment('reel-comment-x', 's19b', 'Step19 Bravo', 's19b_handle', 'hi'))
      );
    });

    await check('DENY: spoofed authorUid on Reel comment', async () => {
      await assertFails(
        setDoc(doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'), validComment('reel-comment-1', 's19c', 'Step19 Bravo', 's19b_handle', 'hi'))
      );
    });

    await check('DENY: spoofed authorDisplayName on Reel comment', async () => {
      await assertFails(
        setDoc(doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'), validComment('reel-comment-1', 's19b', 'Fake Name', 's19b_handle', 'hi'))
      );
    });

    await check('DENY: spoofed authorUsername on Reel comment', async () => {
      await assertFails(
        setDoc(doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'), validComment('reel-comment-1', 's19b', 'Step19 Bravo', 'fake_handle', 'hi'))
      );
    });

    await check('DENY: comment on an unpublished Reel', async () => {
      await assertFails(
        setDoc(
          doc(s19b, 'reels', 'reel-19-draft', 'comments', 'reel-comment-1'),
          validComment('reel-comment-1', 's19b', 'Step19 Bravo', 's19b_handle', 'hi')
        )
      );
    });

    await check('DENY: comment on a nonexistent Reel', async () => {
      await assertFails(
        setDoc(
          doc(s19b, 'reels', 'does-not-exist', 'comments', 'reel-comment-1'),
          validComment('reel-comment-1', 's19b', 'Step19 Bravo', 's19b_handle', 'hi')
        )
      );
    });

    await check('DENY: empty Reel comment body', async () => {
      await assertFails(
        setDoc(doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'), validComment('reel-comment-1', 's19b', 'Step19 Bravo', 's19b_handle', ''))
      );
    });

    await check('DENY: Reel comment body over 500 characters', async () => {
      await assertFails(
        setDoc(
          doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'),
          validComment('reel-comment-1', 's19b', 'Step19 Bravo', 's19b_handle', 'x'.repeat(501))
        )
      );
    });

    await check('DENY: wrong commentId field on Reel comment', async () => {
      await assertFails(
        setDoc(doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'), validComment('wrong-id', 's19b', 'Step19 Bravo', 's19b_handle', 'hi'))
      );
    });

    await check('ALLOW: B comments on A\'s Reel', async () => {
      await assertSucceeds(
        setDoc(
          doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'),
          validComment('reel-comment-1', 's19b', 'Step19 Bravo', 's19b_handle', 'Looks fun!')
        )
      );
    });

    await check('ALLOW: self-comment (A comments on own Reel) — same as content Comments', async () => {
      await assertSucceeds(
        setDoc(
          doc(s19a, 'reels', 'reel-19-1', 'comments', 'reel-comment-self'),
          validComment('reel-comment-self', 's19a', 'Step19 Alpha', 's19a_handle', 'my own reel!')
        )
      );
    });

    await check('ALLOW: C (any authenticated user) reads a comment on a published Reel', async () => {
      await assertSucceeds(getDoc(doc(s19c, 'reels', 'reel-19-1', 'comments', 'reel-comment-1')));
    });

    await check('DENY: update a Reel comment (no edit in Step 19)', async () => {
      await assertFails(updateDoc(doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1'), { body: 'edited' }));
    });

    await check('DENY: C deletes B\'s Reel comment', async () => {
      await assertFails(deleteDoc(doc(s19c, 'reels', 'reel-19-1', 'comments', 'reel-comment-1')));
    });

    await check('ALLOW: B deletes their own Reel comment', async () => {
      await assertSucceeds(deleteDoc(doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-1')));
    });

    await check('ALLOW: A deletes their own self-comment', async () => {
      await assertSucceeds(deleteDoc(doc(s19a, 'reels', 'reel-19-1', 'comments', 'reel-comment-self')));
    });

    // --- reel_like / reel_comment notifications (atomic pairing) ---

    await seedReel(testEnv, 's19a', 'Step19 Alpha', 's19a_handle', 'reel-notif-1');

    await check('ALLOW: B likes A\'s Reel + reel_like notification created atomically', async () => {
      const notificationId = reelLikeNotificationId('reel-notif-1', 's19b');
      const batch = writeBatch(s19b);
      batch.set(doc(s19b, 'reels', 'reel-notif-1', 'likes', 's19b'), validLike('s19b'));
      batch.set(
        doc(s19b, 'notifications', notificationId),
        validNotification(notificationId, 's19a', 's19b', 'Step19 Bravo', 's19b_handle', 'reel_like', { reelId: 'reel-notif-1' })
      );
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(s19a, 'notifications', notificationId));
      assert.equal(snapshot.exists(), true);
      assert.equal(snapshot.data().reelId, 'reel-notif-1');
      assert.equal(snapshot.data().contentId, null);
    });

    await check('DENY: self reel_like notification (A likes own Reel, notification targets self)', async () => {
      const notificationId = reelLikeNotificationId('reel-notif-1', 's19a');
      const batch = writeBatch(s19a);
      batch.set(doc(s19a, 'reels', 'reel-notif-1', 'likes', 's19a'), validLike('s19a'));
      batch.set(
        doc(s19a, 'notifications', notificationId),
        validNotification(notificationId, 's19a', 's19a', 'Step19 Alpha', 's19a_handle', 'reel_like', { reelId: 'reel-notif-1' })
      );
      await assertFails(batch.commit());
    });

    await check('DENY: fake reel_like notification with no matching Like', async () => {
      const notificationId = reelLikeNotificationId('reel-notif-1', 's19c');
      await assertFails(
        setDoc(
          doc(s19c, 'notifications', notificationId),
          validNotification(notificationId, 's19a', 's19c', 'Step19 Charlie', 's19c_handle', 'reel_like', { reelId: 'reel-notif-1' })
        )
      );
    });

    await check('DENY: reel_like notification with spoofed actorUid', async () => {
      const notificationId = reelLikeNotificationId('reel-notif-1', 's19a');
      await assertFails(
        setDoc(
          doc(s19c, 'notifications', notificationId),
          validNotification(notificationId, 's19a', 's19a', 'Step19 Alpha', 's19a_handle', 'reel_like', { reelId: 'reel-notif-1' })
        )
      );
    });

    await check('DENY: reel_like notification with wrong reelId', async () => {
      const notificationId = reelLikeNotificationId('reel-19-1', 's19c');
      const batch = writeBatch(s19c);
      batch.set(doc(s19c, 'reels', 'reel-notif-1', 'likes', 's19c'), validLike('s19c'));
      batch.set(
        doc(s19c, 'notifications', notificationId),
        validNotification(notificationId, 's19a', 's19c', 'Step19 Charlie', 's19c_handle', 'reel_like', { reelId: 'reel-19-1' })
      );
      await assertFails(batch.commit());
    });

    await check('ALLOW: B comments on A\'s Reel + reel_comment notification created atomically', async () => {
      const notificationId = reelCommentNotificationId('reel-notif-comment-1');
      const batch = writeBatch(s19b);
      batch.set(
        doc(s19b, 'reels', 'reel-notif-1', 'comments', 'reel-notif-comment-1'),
        validComment('reel-notif-comment-1', 's19b', 'Step19 Bravo', 's19b_handle', 'Looks fun!')
      );
      batch.set(
        doc(s19b, 'notifications', notificationId),
        validNotification(notificationId, 's19a', 's19b', 'Step19 Bravo', 's19b_handle', 'reel_comment', {
          reelId: 'reel-notif-1',
          commentId: 'reel-notif-comment-1',
          previewText: 'Looks fun!',
        })
      );
      await assertSucceeds(batch.commit());

      const snapshot = await getDoc(doc(s19a, 'notifications', notificationId));
      assert.equal(snapshot.exists(), true);
      assert.equal(snapshot.data().previewText, 'Looks fun!');
    });

    await check('DENY: fake reel_comment notification with no matching Comment', async () => {
      const notificationId = reelCommentNotificationId('reel-comment-fake-1');
      await assertFails(
        setDoc(
          doc(s19c, 'notifications', notificationId),
          validNotification(notificationId, 's19a', 's19c', 'Step19 Charlie', 's19c_handle', 'reel_comment', {
            reelId: 'reel-notif-1',
            commentId: 'reel-comment-fake-1',
          })
        )
      );
    });

    await check('DENY: wrong deterministic notification ID for a real Reel comment', async () => {
      const batch = writeBatch(s19c);
      batch.set(
        doc(s19c, 'reels', 'reel-notif-1', 'comments', 'reel-notif-comment-2'),
        validComment('reel-notif-comment-2', 's19c', 'Step19 Charlie', 's19c_handle', 'hi')
      );
      batch.set(
        doc(s19c, 'notifications', reelCommentNotificationId('some-other-comment-id')),
        validNotification(reelCommentNotificationId('some-other-comment-id'), 's19a', 's19c', 'Step19 Charlie', 's19c_handle', 'reel_comment', {
          reelId: 'reel-notif-1',
          commentId: 'reel-notif-comment-2',
        })
      );
      await assertFails(batch.commit());
    });

    await check('ALLOW: A (recipient) reads their own reel_like notification', async () => {
      await assertSucceeds(getDoc(doc(s19a, 'notifications', reelLikeNotificationId('reel-notif-1', 's19b'))));
    });

    await check('DENY: B reads A\'s reel_like notification', async () => {
      await assertFails(getDoc(doc(s19b, 'notifications', reelLikeNotificationId('reel-notif-1', 's19b'))));
    });

    await check('DENY: B marks A\'s reel_like notification read', async () => {
      await assertFails(
        updateDoc(doc(s19b, 'notifications', reelLikeNotificationId('reel-notif-1', 's19b')), { read: true, updatedAt: serverTimestamp() })
      );
    });

    await check('ALLOW: A marks their own reel_like notification read', async () => {
      await assertSucceeds(
        updateDoc(doc(s19a, 'notifications', reelLikeNotificationId('reel-notif-1', 's19b')), { read: true, updatedAt: serverTimestamp() })
      );
    });

    await check('ALLOW: A still reads an old pre-Step-19 like notification lacking a reelId field', async () => {
      // Regression for backward compatibility — a notification created
      // before Step 19 predates the reelId field entirely. isValidNotificationUpdate
      // reads it via .get('reelId', null), not plain dot access, specifically
      // so mark-as-read keeps working for these. Simulate one directly
      // (bypassing rules, since a real client can no longer write a
      // notification missing the field) and confirm update still succeeds.
      await testEnv.withSecurityRulesDisabled(async (adminContext) => {
        await setDoc(doc(adminContext.firestore(), 'notifications', 'legacy-notif-1'), {
          notificationId: 'legacy-notif-1',
          recipientUid: 's19a',
          actorUid: 's19b',
          actorDisplayName: 'Step19 Bravo',
          actorUsername: 's19b_handle',
          type: 'like',
          contentId: 'some-old-content-id',
          commentId: null,
          previewText: null,
          read: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          // reelId intentionally omitted — simulating a pre-Step-19 doc.
        });
      });
      await assertSucceeds(updateDoc(doc(s19a, 'notifications', 'legacy-notif-1'), { read: true, updatedAt: serverTimestamp() }));
    });

    await check('DENY: B deletes their own reel_like notification without removing the underlying Like', async () => {
      await assertFails(deleteDoc(doc(s19b, 'notifications', reelLikeNotificationId('reel-notif-1', 's19b'))));
    });

    await check('ALLOW: B unlikes + deletes the paired reel_like notification atomically', async () => {
      const batch = writeBatch(s19b);
      batch.delete(doc(s19b, 'reels', 'reel-notif-1', 'likes', 's19b'));
      batch.delete(doc(s19b, 'notifications', reelLikeNotificationId('reel-notif-1', 's19b')));
      await assertSucceeds(batch.commit());
    });

    await check('ALLOW: B deletes their Reel comment + the paired reel_comment notification atomically', async () => {
      const batch = writeBatch(s19b);
      batch.delete(doc(s19b, 'reels', 'reel-notif-1', 'comments', 'reel-notif-comment-1'));
      batch.delete(doc(s19b, 'notifications', reelCommentNotificationId('reel-notif-comment-1')));
      await assertSucceeds(batch.commit());
    });

    // --- Block integration: A blocks B, both directions denied ---

    await seedReel(testEnv, 's19b', 'Step19 Bravo', 's19b_handle', 'reel-19-2');

    await check('setup: B likes A\'s Reel before any block exists', async () => {
      await assertSucceeds(setDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b'), validLike('s19b')));
    });

    await check('setup: A blocks B for Reel engagement block tests', async () => {
      await assertSucceeds(setDoc(doc(s19a, 'blocks', blockId('s19a', 's19b')), validBlock('s19a', 's19b')));
    });

    await check('ALLOW: B can still unlike a pre-existing Like even after being blocked', async () => {
      // Explicit Step 19 requirement: a Block only stops NEW interaction —
      // it must never trap a stale Like the unliker can no longer remove.
      await assertSucceeds(deleteDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b')));
    });

    await check('DENY: B likes A\'s Reel while blocked', async () => {
      await assertFails(setDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b'), validLike('s19b')));
    });

    await check('DENY: B comments on A\'s Reel while blocked', async () => {
      await assertFails(
        setDoc(
          doc(s19b, 'reels', 'reel-19-1', 'comments', 'reel-comment-blocked-1'),
          validComment('reel-comment-blocked-1', 's19b', 'Step19 Bravo', 's19b_handle', 'hi')
        )
      );
    });

    await check('DENY: A likes B\'s Reel while blocking B', async () => {
      await assertFails(setDoc(doc(s19a, 'reels', 'reel-19-2', 'likes', 's19a'), validLike('s19a')));
    });

    await check('DENY: A comments on B\'s Reel while blocking B', async () => {
      await assertFails(
        setDoc(
          doc(s19a, 'reels', 'reel-19-2', 'comments', 'reel-comment-blocked-2'),
          validComment('reel-comment-blocked-2', 's19a', 'Step19 Alpha', 's19a_handle', 'hi')
        )
      );
    });

    await check('ALLOW: A unblocks B, ordinary Reel interaction works again', async () => {
      await assertSucceeds(deleteDoc(doc(s19a, 'blocks', blockId('s19a', 's19b'))));
      await assertSucceeds(setDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b'), validLike('s19b')));
      await assertSucceeds(deleteDoc(doc(s19b, 'reels', 'reel-19-1', 'likes', 's19b')));
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
