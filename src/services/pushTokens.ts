/**
 * Device-token registration and lifecycle for Expo push notifications —
 * `users/{uid}/pushTokens/{deviceId}`, plus the cross-account ownership
 * registry `pushTokenOwners/{expoPushToken}` this file's own security
 * guarantee depends on. Still STEP 3B/3C: foundation only. Nothing in
 * this file ever sends a push notification, listens for one, or creates
 * a server-side trigger — it only establishes, keeps fresh, and tears
 * down the records a FUTURE send-side step would read.
 *
 * ============================================================
 * THE CROSS-ACCOUNT PRIVACY GUARANTEE — read this before changing
 * anything below.
 * ============================================================
 * A physical device's Expo push token is tied to the OS + app
 * installation, NOT to which app-level (Firebase) user is currently
 * signed in. If User A signs out and User B signs in on the SAME
 * device, a fresh `getExpoPushTokenAsync()` call returns the SAME
 * token value B now has. `users/{uid}/pushTokens/{deviceId}` alone
 * CANNOT prevent a future send-process from delivering a notification
 * meant for A to that physical device while B is using it — different
 * uids living at different Firestore paths is NOT cross-account
 * isolation, merely different bookkeeping. (The previous version of
 * this file claimed otherwise; that claim was wrong, and is the exact
 * reason this step exists.)
 *
 * The actual guarantee comes from `pushTokenOwners/{expoPushToken}` — a
 * SEPARATE collection, keyed by the token's own literal value, holding
 * ONLY `{ uid, updatedAt }`: the uid currently, legitimately entitled to
 * receive pushes at that exact token. Every real registration
 * (registerPushToken below) ATOMICALLY writes BOTH the per-user document
 * AND this ownership record together, in one batch — so the moment User
 * B registers the SAME physical token, the registry is immediately and
 * correctly reassigned to B, REGARDLESS of whether User A's own logout
 * cleanup ever ran or ever succeeds. A future send-process is required
 * to check `pushTokenOwners/{token}.uid === recipientUid` (see
 * src/utils/pushTokenOwnership.ts's own isTokenCurrentlyOwnedBy) before
 * ever delivering to a token — under that check, A's stale per-user
 * document (if cleanup failed) is harmless: the registry already says
 * "current owner: B," so a send meant for A is correctly skipped.
 *
 * Client-side logout cleanup (removeCurrentDevicePushToken) is therefore
 * DEFENSE IN DEPTH, not the mechanism the guarantee depends on — it
 * exists to close the window FASTER (before any new user even
 * registers) and to keep `users/{uid}/pushTokens` tidy, never because
 * the guarantee requires it to succeed.
 *
 * ============================================================
 * WHAT IS GUARANTEED BY THE CLIENT VS. WHAT REQUIRES SERVER-SIDE
 * ENFORCEMENT (see this change's own final report for the full version)
 * ============================================================
 * - The CLIENT can guarantee: registration always attempts to write the
 *   ownership record atomically with the per-user document; logout
 *   always attempts best-effort cleanup with bounded retry and a
 *   durable local marker for a later retry while still authenticated as
 *   the same uid.
 * - The CLIENT CANNOT guarantee: that cleanup ever succeeds, or that a
 *   departing user's session is ever available again to retry it.
 * - SERVER-SIDE ENFORCEMENT IS REQUIRED for the actual guarantee: a
 *   future send-process MUST consult `pushTokenOwners` before sending.
 *   This file provides the correctly-maintained DATA that check would
 *   need; it cannot itself complete the guarantee, because no send-side
 *   code exists yet (explicitly out of scope for this step).
 *
 * Both collections are written directly through Firestore Rules, not a
 * callable — see firestore.rules' own doc comments on `pushTokens` and
 * `pushTokenOwners` for why a callable adds no real security here (every
 * check Rules would need is already "does request.auth.uid match",
 * which Rules already enforce natively).
 */
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, writeBatch, type WithFieldValue } from 'firebase/firestore';

import { getOrCreateDeviceId } from '@/utils/deviceId';
import { hasPushTokenChanged, isTokenRotation, type StoredPushTokenRecord } from '@/utils/pushTokenChangeDetection';
import { shouldRequestPermissionPrompt, type PushPermissionStatus } from '@/utils/pushPermissionPolicy';
import { markPushTokenCleanupPending, clearPushTokenCleanupPending, isPushTokenCleanupPending } from '@/utils/pendingPushTokenCleanup';
import { shouldStartRegistrationAttempt, isRegistrationResultStale } from '@/utils/pushTokenSessionGuard';
import { resolvePushTokenPlatform, type PushTokenPlatform } from '@/utils/pushTokenPlatformSupport';

import { firestore } from './firestore';

type PushTokenDocument = {
  deviceId: string;
  expoPushToken: string;
  platform: PushTokenPlatform;
  createdAt: unknown;
  updatedAt: unknown;
};

type PushTokenOwnerDocument = {
  uid: string;
  updatedAt: unknown;
};

function pushTokenRef(uid: string, deviceId: string) {
  return doc(firestore!, 'users', uid, 'pushTokens', deviceId);
}

function pushTokenOwnerRef(expoPushToken: string) {
  return doc(firestore!, 'pushTokenOwners', expoPushToken);
}

/** `null` on web or any platform this app doesn't build push support for — see resolvePushTokenPlatform's own doc comment (the actual pure mapping, extracted there for direct testability). */
function currentPlatform(): PushTokenPlatform | null {
  return resolvePushTokenPlatform(Platform.OS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Best-effort release of `pushTokenOwners/{expoPushToken}`, independent
 * of anything else — relies entirely on firestore.rules' own delete
 * condition (`resource.data.uid == request.auth.uid`) to make this
 * correctly conditional server-side; no client-side read-then-compare is
 * needed, since Firestore evaluates that rule against the document's
 * CURRENT value at delete time regardless. A denial here (the token was
 * already reassigned to someone else — e.g. a race with a newer
 * registration on the same physical device) is swallowed on purpose,
 * never surfaced as a failure to either of this function's two callers
 * (logout cleanup, and releasing a now-superseded token on rotation —
 * see each call site's own doc comment).
 */
async function releasePushTokenOwnershipBestEffort(expoPushToken: string): Promise<void> {
  if (!firestore) return;
  try {
    await deleteDoc(pushTokenOwnerRef(expoPushToken));
  } catch {
    // Expected and harmless — see this function's own doc comment.
  }
}

export type PushPermissionCheckResult = { supported: true; status: PushPermissionStatus } | { supported: false };

/**
 * Reads the CURRENT OS permission status without ever showing a prompt —
 * safe to call at any time, including during initial app load, since
 * `getPermissionsAsync` never triggers OS UI by itself. `supported: false`
 * on web/any platform without push support here (see currentPlatform).
 */
export async function getNotificationPermissionStatus(): Promise<PushPermissionCheckResult> {
  if (!currentPlatform()) return { supported: false };
  const { status } = await Notifications.getPermissionsAsync();
  return { supported: true, status: status as PushPermissionStatus };
}

export type RegisterPushTokenResult =
  | { ok: true; action: 'registered' | 'updated' | 'unchanged' }
  | { ok: true; action: 'skipped'; reason: 'unsupported-platform' | 'permission-not-granted' }
  | { ok: false; error: 'not-configured' | 'unknown'; message: string };

/**
 * The actual Firestore read-compare-write — NEVER requests permission and
 * NEVER shows any OS UI. Only ever writes when permission is ALREADY
 * `granted` (checked fresh, not assumed from a caller-supplied flag).
 *
 * Avoids unnecessary writes via hasPushTokenChanged (reads the existing
 * document first; only writes when the token or platform actually
 * differs, or the document doesn't exist yet).
 *
 * When a write IS needed, it updates `users/{uid}/pushTokens/{deviceId}`
 * AND claims `pushTokenOwners/{expoPushToken}` for this uid in ONE
 * atomic batch — see this file's own top doc comment for why this
 * specific pairing is safe to batch (the ownership claim can never be
 * denied by Rules on the basis of who held it before; the LAST
 * legitimate registration always wins, which is exactly the intended
 * "whoever currently holds this physical token is its current owner"
 * semantics). If the batch fails, NEITHER write is applied — this
 * function reports failure and a later retry will attempt both again,
 * rather than ever leaving the per-user document written without the
 * matching ownership claim (which is the one inconsistency that would
 * actually weaken the privacy guarantee).
 */
export async function ensurePushTokenRegistered(uid: string): Promise<RegisterPushTokenResult> {
  const platform = currentPlatform();
  if (!platform) {
    return { ok: true, action: 'skipped', reason: 'unsupported-platform' };
  }
  if (!firestore) {
    return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  }

  const permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted') {
    return { ok: true, action: 'skipped', reason: 'permission-not-granted' };
  }

  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    if (!projectId) {
      return { ok: false, error: 'not-configured', message: 'No EAS project id is configured for push token acquisition.' };
    }

    const { data: expoPushToken } = await Notifications.getExpoPushTokenAsync({ projectId });
    const deviceId = await getOrCreateDeviceId();
    const tokenRef = pushTokenRef(uid, deviceId);

    const existingSnapshot = await getDoc(tokenRef);
    const existing = existingSnapshot.exists() ? (existingSnapshot.data() as PushTokenDocument) : null;
    const existingRecord: StoredPushTokenRecord | null = existing ? { expoPushToken: existing.expoPushToken, platform: existing.platform } : null;

    if (!hasPushTokenChanged(existingRecord, { expoPushToken, platform })) {
      return { ok: true, action: 'unchanged' };
    }

    const tokenData = {
      deviceId,
      expoPushToken,
      platform,
      // createdAt is intentionally only ever set here, never re-sent on an
      // update below — firestore.rules independently pins it unchanged
      // across updates too (defense in depth, same as every other
      // created-once timestamp elsewhere in this codebase).
      createdAt: existing ? existing.createdAt : serverTimestamp(),
      updatedAt: serverTimestamp(),
    } satisfies WithFieldValue<PushTokenDocument>;

    const ownerData = {
      uid,
      updatedAt: serverTimestamp(),
    } satisfies WithFieldValue<PushTokenOwnerDocument>;

    const batch = writeBatch(firestore);
    batch.set(tokenRef, tokenData);
    batch.set(pushTokenOwnerRef(expoPushToken), ownerData);
    await batch.commit();

    // Step 3D — token ROTATION (the OS issued a genuinely new token value
    // for this same device): the NEW token's ownership claim was just
    // written above, but the OLD token's own `pushTokenOwners` entry
    // still exists and still says `uid` too — a real, if low-severity,
    // hygiene gap (the old token is effectively dead, but its stale
    // ownership record would otherwise linger indefinitely). Released
    // AFTER the batch commits, as its own separate, independently-
    // failable best-effort step — never blocking the registration that
    // already succeeded above.
    if (isTokenRotation(existingRecord, { expoPushToken, platform })) {
      await releasePushTokenOwnershipBestEffort(existing!.expoPushToken);
    }

    return { ok: true, action: existing ? 'updated' : 'registered' };
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't register this device for notifications right now." };
  }
}

export type RequestPushPermissionResult =
  | { ok: true; status: 'granted'; registration: RegisterPushTokenResult }
  | { ok: true; status: 'denied' | 'undetermined' }
  | { ok: true; action: 'skipped'; reason: 'unsupported-platform' };

/**
 * The ONE function in this file that may show the OS permission prompt —
 * and even this only does so when shouldRequestPermissionPrompt says the
 * current status is 'undetermined' (never re-prompts after a real
 * denial).
 *
 * Deliberately NOT wired into any screen or app-lifecycle hook by this
 * step — see this change's own final report for the recommended
 * integration point. Call this ONLY from a deliberate, user-facing
 * moment — never automatically during initial load.
 */
export async function requestPushPermissionAndRegister(uid: string): Promise<RequestPushPermissionResult> {
  const platform = currentPlatform();
  if (!platform) {
    return { ok: true, action: 'skipped', reason: 'unsupported-platform' };
  }

  const current = await Notifications.getPermissionsAsync();
  const status = shouldRequestPermissionPrompt(current.status as PushPermissionStatus)
    ? (await Notifications.requestPermissionsAsync()).status
    : current.status;

  if (status !== 'granted') {
    return { ok: true, status: status as 'denied' | 'undetermined' };
  }

  return { ok: true, status: 'granted', registration: await ensurePushTokenRegistered(uid) };
}

export type RemovePushTokenResult =
  | { ok: true; attempted: boolean }
  | { ok: false; error: 'unknown'; message: string };

/**
 * ONE attempt (no retry here — retry policy lives in the exported
 * removeCurrentDevicePushToken below) at logout cleanup for `uid`:
 *
 * 1. Delete `users/{uid}/pushTokens/{deviceId}` — always safe,
 *    independent of anything else; this alone is the main cleanup.
 * 2. SEPARATELY (never in the same batch as #1 — see this file's own
 *    top doc comment on why registration and release have different
 *    batching safety) best-effort release `pushTokenOwners/{token}`,
 *    ONLY if it still points to this uid. This is deliberately allowed
 *    to fail silently and independently of #1: if some OTHER
 *    registration already reassigned that token (a race — e.g. a new
 *    user already signed in and registered before this logout's
 *    cleanup got a chance to run), firestore.rules' own delete
 *    condition (`resource.data.uid == request.auth.uid`) correctly
 *    denies this specific delete — and that MUST NOT be treated as this
 *    whole cleanup attempt failing, since the actual privacy property
 *    (current owner is already the new user) already holds regardless.
 *
 * Returns `attempted: false` (still `ok: true`) when there was nothing
 * to clean up at all — a device that never registered. Never throws.
 */
async function attemptPushTokenCleanup(uid: string): Promise<RemovePushTokenResult> {
  if (!firestore) return { ok: true, attempted: false };

  try {
    const deviceId = await getOrCreateDeviceId();
    const tokenRef = pushTokenRef(uid, deviceId);
    const snapshot = await getDoc(tokenRef);
    if (!snapshot.exists()) {
      return { ok: true, attempted: false };
    }
    const existing = snapshot.data() as PushTokenDocument;

    await deleteDoc(tokenRef);

    // Best-effort, independent of the delete above — see
    // releasePushTokenOwnershipBestEffort's own doc comment for why a
    // permission-denied here (token already reassigned to someone else)
    // is swallowed on purpose, never surfaced as this cleanup having
    // failed.
    await releasePushTokenOwnershipBestEffort(existing.expoPushToken);

    return { ok: true, attempted: true };
  } catch (error) {
    return { ok: false, error: 'unknown', message: error instanceof Error ? error.message : "Couldn't remove this device's notification registration." };
  }
}

/**
 * Logout cleanup for `uid`, with a SMALL, BOUNDED retry (at most one
 * retry, after a short fixed delay) — never an unlimited loop, never a
 * delay long enough to make signing out feel slow. Marks a durable local
 * "cleanup pending" flag BEFORE attempting (src/utils/pendingPushTokenCleanup.ts)
 * and clears it only on confirmed success, so an app restart while still
 * authenticated as the SAME uid (see retryPendingPushTokenCleanup below)
 * can finish the job later. A genuine failure after both attempts is
 * logged — never silently treated as success — but still never thrown,
 * so the caller (the sign-out flow) is never blocked by it.
 *
 * Must be called BEFORE Firebase sign-out completes, while
 * `request.auth.uid` still resolves to `uid`.
 */
export async function removeCurrentDevicePushToken(uid: string): Promise<RemovePushTokenResult> {
  await markPushTokenCleanupPending(uid);

  let result = await attemptPushTokenCleanup(uid);
  if (!result.ok) {
    await delay(500);
    result = await attemptPushTokenCleanup(uid);
  }

  if (result.ok) {
    await clearPushTokenCleanupPending(uid);
  } else {
    // eslint-disable-next-line no-console
    console.warn(`[pushTokens] Logout cleanup failed for uid "${uid}" after retry — will retry on next launch if still authenticated as this user:`, result.message);
  }

  return result;
}

/**
 * Call once, fire-and-forget, whenever a uid becomes the currently
 * authenticated user (see this change's own final report for the exact
 * integration point: AuthProvider's onAuthStateChanged). Resolves a
 * cleanup that was marked pending but never confirmed — the ONLY window
 * in which that's possible to do AS that uid is while that uid's own
 * session is still the active one (e.g. logout was interrupted before
 * signOut() itself completed, and the app relaunched with the same
 * session still intact). If `uid` has no pending marker, this is a
 * single cheap AsyncStorage read and nothing else.
 */
export async function retryPendingPushTokenCleanup(uid: string): Promise<void> {
  const pending = await isPushTokenCleanupPending(uid);
  if (!pending) return;
  await removeCurrentDevicePushToken(uid);
}

// Module-level session tracking for syncPushTokenForAuthenticatedSession
// below — deliberately NOT component state (AuthProvider has no reason
// to re-render on these), and deliberately NOT per-uid persisted state
// (this only ever needs to reflect what's true for THIS running app
// instance, right now).
let currentSessionUid: string | null = null;
let registrationInFlightForUid: string | null = null;

/**
 * Call once per auth-state change, for whichever uid is now the
 * authenticated user — the recommended integration point is
 * AuthProvider's own onAuthStateChanged (see this change's own final
 * report). Does TWO things, in order, for `uid`:
 *
 * 1. retryPendingPushTokenCleanup(uid) — resolves an interrupted
 *    logout's own cleanup, if one is still pending for this exact uid.
 * 2. ensurePushTokenRegistered(uid) — silently registers this device
 *    IF AND ONLY IF OS notification permission is already granted.
 *    NEVER shows a permission prompt — see ensurePushTokenRegistered's
 *    own doc comment. A user who has never granted (or who declined)
 *    simply gets skipped here, every time, with no UI effect at all.
 *
 * Guards against TWO real races surfaced by this step's own
 * investigation (see pushTokenSessionGuard.ts's own doc comment for the
 * full reasoning):
 *  - DUPLICATE calls for the same uid (e.g. onAuthStateChanged firing
 *    more than once in quick succession — a token refresh, a Fast
 *    Refresh in development) are collapsed to one in-flight attempt.
 *  - A STALE resolve — this uid is no longer the current session by the
 *    time registration finishes (e.g. the user signed out again before
 *    this write landed) — is compensated for immediately by re-running
 *    the exact same cleanup a normal logout would have performed,
 *    rather than silently leaving a freshly-written, now-stale
 *    registration behind for an account that is no longer signed in.
 *
 * Never throws. Call clearPushTokenSessionTracking() on sign-out so a
 * LATER stale resolve correctly detects "no longer current" rather than
 * comparing against a stale uid that was never cleared.
 */
export async function syncPushTokenForAuthenticatedSession(uid: string): Promise<void> {
  currentSessionUid = uid;

  await retryPendingPushTokenCleanup(uid).catch(() => {});

  if (!shouldStartRegistrationAttempt(registrationInFlightForUid, uid)) {
    return;
  }
  registrationInFlightForUid = uid;

  try {
    const result = await ensurePushTokenRegistered(uid);

    if (isRegistrationResultStale(currentSessionUid, uid)) {
      // See this function's own doc comment — compensate rather than
      // leave a stale registration behind.
      await removeCurrentDevicePushToken(uid).catch(() => {});
      return;
    }

    if (!result.ok) {
      // eslint-disable-next-line no-console
      console.warn(`[pushTokens] Authenticated-session registration failed for uid "${uid}":`, result.message);
    }
  } finally {
    if (registrationInFlightForUid === uid) {
      registrationInFlightForUid = null;
    }
  }
}

/**
 * Call on sign-out (e.g. AuthProvider's own onAuthStateChanged, the
 * `firebaseUser === null` branch) so a later-resolving, now-stale
 * registration attempt correctly detects it is no longer current — see
 * syncPushTokenForAuthenticatedSession's own doc comment.
 */
export function clearPushTokenSessionTracking(): void {
  currentSessionUid = null;
}
