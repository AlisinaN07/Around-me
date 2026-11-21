/**
 * DETERMINISTIC MIRROR of firestore.rules' own `users/{uid}/pushTokens/{deviceId}`
 * rules (isValidPushTokenShape + the create/update/ownership logic built
 * on it), reimplemented here as plain JS predicates and tested against
 * fixtures — same reasoning and same real-emulator-unavailability caveat
 * as test-event-cover-storage-rules.cjs/test-reel-rules-predicates.cjs's
 * own top doc comments (a `fetch failed`/`ECONNRESET` at the TCP level
 * against every emulator REST endpoint beyond its trivial health check —
 * a sandbox/environment limitation).
 *
 * THIS FILE IS NOT A SUBSTITUTE for a real emulator run — it only proves
 * the PREDICATE LOGIC itself is correct, never that Firestore's real
 * rules engine parses/evaluates the actual `.rules` syntax identically.
 * `isServerTimestamp`'s own `request.time` semantics are NOT mocked here
 * at all (there is nothing meaningful to mirror in plain JS for "was this
 * the literal server commit time") — every test below assumes that part
 * of the real rule already holds and focuses on the parts that ARE
 * meaningfully pure: shape, key allowlist, deviceId/createdAt pairing,
 * and ownership-by-path.
 */
const assert = require('node:assert/strict');

// Mirrors firestore.rules' own isOwner(uid) — ownership is by PATH, not
// by any field on the document itself (see that rule's own doc comment
// on why a push-token document has no recipientUid-style field at all).
function isOwner(requestAuthUid, pathUid) {
  return requestAuthUid != null && requestAuthUid === pathUid;
}

// Mirrors firestore.rules' own isValidExpoPushTokenFormat exactly — Step
// 3C: accepts BOTH documented Expo token variants, not one hardcoded
// prefix (same pattern as src/utils/expoPushTokenFormat.ts's own
// isLikelyExpoPushToken, the client-side mirror of this same check).
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[.+\]$/;
function isValidExpoPushTokenFormat(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 400 && EXPO_PUSH_TOKEN_PATTERN.test(value);
}

// Mirrors firestore.rules' own isValidPushTokenShape exactly.
function isValidPushTokenShape(data) {
  if (typeof data.deviceId !== 'string' || data.deviceId.length === 0 || data.deviceId.length > 200) return false;
  if (!isValidExpoPushTokenFormat(data.expoPushToken)) return false;
  if (data.platform !== 'ios' && data.platform !== 'android') return false;
  const allowedKeys = ['deviceId', 'expoPushToken', 'platform', 'createdAt', 'updatedAt'];
  return Object.keys(data).every((key) => allowedKeys.includes(key));
}

// Mirrors firestore.rules' own isValidPushTokenOwnerShape exactly.
function isValidPushTokenOwnerShape(data) {
  if (typeof data.uid !== 'string' || data.uid.length === 0) return false;
  const allowedKeys = ['uid', 'updatedAt'];
  return Object.keys(data).every((key) => allowedKeys.includes(key));
}

// Mirrors the pushTokenOwners create/update rule — deliberately does NOT
// check `oldData` at all (see firestore.rules' own doc comment on why
// reassignment away from a PREVIOUS owner is the entire point of this
// collection, not a bug to guard against).
function isValidPushTokenOwnerWrite(requestAuthUid, data) {
  return requestAuthUid != null && data.uid === requestAuthUid && isValidPushTokenOwnerShape(data);
}

// Mirrors the pushTokenOwners delete rule exactly — a departing user may
// only release a claim that is STILL actually theirs.
function isValidPushTokenOwnerDelete(requestAuthUid, oldData) {
  return requestAuthUid != null && oldData.uid === requestAuthUid;
}

// Mirrors the create rule's own full condition (server-timestamp checks
// on createdAt/updatedAt omitted — see this file's own top doc comment).
function isValidPushTokenCreate(requestAuthUid, pathUid, deviceId, data) {
  return isOwner(requestAuthUid, pathUid) && data.deviceId === deviceId && isValidPushTokenShape(data);
}

// Mirrors the update rule's own full condition (server-timestamp check on
// updatedAt omitted — see this file's own top doc comment).
function isValidPushTokenUpdate(requestAuthUid, pathUid, deviceId, data, oldData) {
  return (
    isOwner(requestAuthUid, pathUid) &&
    data.deviceId === deviceId &&
    data.deviceId === oldData.deviceId &&
    data.createdAt === oldData.createdAt &&
    isValidPushTokenShape(data)
  );
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

const uid = 'u1';
const otherUid = 'u2';
const deviceId = 'device-abc123';
const createdAt = 'TIMESTAMP_A';

const validData = { deviceId, expoPushToken: 'ExponentPushToken[xyz]', platform: 'ios', createdAt, updatedAt: 'TIMESTAMP_A' };

// ---- Valid token registration -------------------------------------------

check('a well-formed create by the real owner is valid', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, validData), true);
});

check('android platform is also accepted', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, platform: 'android' }), true);
});

// ---- Unauthorized / cross-user access -----------------------------------

check('SECURITY — unauthorized access: no request.auth at all (null uid) is rejected', () => {
  assert.equal(isValidPushTokenCreate(null, uid, deviceId, validData), false);
});

check('SECURITY — cross-user access: a DIFFERENT authenticated uid writing into this uid\'s subtree is rejected', () => {
  assert.equal(isValidPushTokenCreate(otherUid, uid, deviceId, validData), false);
});

check('SECURITY — the real owner cannot be fooled by data.deviceId disagreeing with the path\'s own deviceId', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, deviceId: 'a-different-device-id' }), false);
});

// ---- Invalid token formats -----------------------------------------------

check('an unrecognized platform value is rejected', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, platform: 'web' }), false);
});

check('a non-string expoPushToken is rejected', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, expoPushToken: 12345 }), false);
});

check('an empty-string expoPushToken is rejected', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, expoPushToken: '' }), false);
});

check('an oversized expoPushToken (> 400 chars) is rejected', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, expoPushToken: 'x'.repeat(401) }), false);
});

check('an extra, unrecognized key on the document is rejected', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, recipientUid: otherUid }), false);
});

check('a missing required field (expoPushToken) is rejected', () => {
  const { expoPushToken, ...rest } = validData;
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, rest), false);
});

// ---- Token rotation (update) ---------------------------------------------

check('token rotation: the SAME device updating its own expoPushToken is valid', () => {
  const rotated = { ...validData, expoPushToken: 'ExponentPushToken[new]', updatedAt: 'TIMESTAMP_B' };
  assert.equal(isValidPushTokenUpdate(uid, uid, deviceId, rotated, validData), true);
});

check('an update that tries to re-parent this document to a DIFFERENT deviceId is rejected', () => {
  const malicious = { ...validData, deviceId: 'different-device', updatedAt: 'TIMESTAMP_B' };
  assert.equal(isValidPushTokenUpdate(uid, uid, deviceId, malicious, validData), false);
});

check('an update that tries to fabricate a different createdAt is rejected', () => {
  const malicious = { ...validData, createdAt: 'TIMESTAMP_FAKE', updatedAt: 'TIMESTAMP_B' };
  assert.equal(isValidPushTokenUpdate(uid, uid, deviceId, malicious, validData), false);
});

check('SECURITY — cross-user update is rejected exactly like cross-user create', () => {
  const rotated = { ...validData, expoPushToken: 'ExponentPushToken[new]', updatedAt: 'TIMESTAMP_B' };
  assert.equal(isValidPushTokenUpdate(otherUid, uid, deviceId, rotated, validData), false);
});

// ---- Repeated registration (idempotent create-equivalent) ----------------

check('repeated registration with IDENTICAL data is still a valid update (no-op in effect)', () => {
  assert.equal(isValidPushTokenUpdate(uid, uid, deviceId, validData, validData), true);
});

// ---- Invalid token formats — Step 3C: both Expo variants ----------------

check('the OTHER documented Expo token variant, ExpoPushToken[...], is ALSO accepted on create', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, expoPushToken: 'ExpoPushToken[xyz]' }), true);
});

check('a value with no recognizable Expo token shape at all is rejected', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, expoPushToken: 'not-a-real-token' }), false);
});

check('an FCM/APNs-shaped raw device token (no Expo wrapper) is rejected', () => {
  assert.equal(isValidPushTokenCreate(uid, uid, deviceId, { ...validData, expoPushToken: 'dQw4w9WgXcQ:APA91bF' }), false);
});

// ---- pushTokenOwners — the actual cross-account privacy registry --------

check('a well-formed ownership claim by a real signed-in user for THEIR OWN uid is valid', () => {
  assert.equal(isValidPushTokenOwnerWrite(uid, { uid, updatedAt: 'TIMESTAMP_A' }), true);
});

check('SECURITY — unauthorized: no request.auth at all is rejected', () => {
  assert.equal(isValidPushTokenOwnerWrite(null, { uid, updatedAt: 'TIMESTAMP_A' }), false);
});

check('SECURITY — a signed-in user cannot claim ownership FOR a different uid value than their own', () => {
  assert.equal(isValidPushTokenOwnerWrite(uid, { uid: otherUid, updatedAt: 'TIMESTAMP_A' }), false);
});

check('an extra, unrecognized key is rejected', () => {
  assert.equal(isValidPushTokenOwnerWrite(uid, { uid, updatedAt: 'TIMESTAMP_A', recipientUid: otherUid }), false);
});

check(
  'SHARED-DEVICE RE-REGISTRATION — User B claiming a token PREVIOUSLY owned by User A is a VALID write (reassignment is the entire point)',
  () => {
    // oldData (owned by A) is deliberately never consulted by the real
    // rule — this test exists to confirm that explicitly, not just by
    // omission.
    assert.equal(isValidPushTokenOwnerWrite(otherUid, { uid: otherUid, updatedAt: 'TIMESTAMP_B' }), true);
  }
);

check('release-on-logout: the real current owner CAN delete their own claim', () => {
  assert.equal(isValidPushTokenOwnerDelete(uid, { uid, updatedAt: 'TIMESTAMP_A' }), true);
});

check('SECURITY — unauthorized cross-user deletion: a user CANNOT delete a claim that belongs to someone else', () => {
  assert.equal(isValidPushTokenOwnerDelete(otherUid, { uid, updatedAt: 'TIMESTAMP_A' }), false);
});

check('SECURITY — a departing user cannot delete a claim that a NEWER registration already reassigned away from them', () => {
  // Models exactly removeCurrentDevicePushToken's own release attempt
  // arriving AFTER a different user already re-registered that same
  // physical token — the delete must be denied, and
  // attemptPushTokenCleanup's own try/catch around just this call is
  // what keeps that denial from affecting the (always-safe, separate)
  // deletion of the user's own per-user pushTokens document.
  assert.equal(isValidPushTokenOwnerDelete(uid, { uid: otherUid, updatedAt: 'TIMESTAMP_B' }), false);
});

console.log('\n=== functions/ Push token rules predicate mirror test results ===');
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
