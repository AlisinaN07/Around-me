/**
 * Pure decisions behind the authenticated-lifecycle integration in
 * src/services/pushTokens.ts's own syncPushTokenForAuthenticatedSession —
 * extracted here, same reasoning as every other pure-logic split in this
 * codebase, so these are directly unit-testable under plain tsx.
 *
 * Step 3E — these two decisions exist to close a REAL race discovered
 * during this step's own investigation: if a user signs out VERY
 * quickly after signing in (fast enough that an in-flight registration
 * write hasn't resolved yet), that write can land in Firestore AFTER
 * the logout's own cleanup already ran — silently resurrecting a
 * just-deleted `users/{uid}/pushTokens/{deviceId}` document for an
 * account that is no longer signed in. Firestore Rules alone cannot
 * prevent this (the write is still a legitimate, owner-authenticated
 * write at the moment it lands) — it has to be caught client-side, by
 * tracking which uid is actually CURRENT and compensating if a
 * registration resolves for a uid that is no longer it.
 */

/**
 * Should a NEW registration attempt actually start for `uid`, or is one
 * already in flight for this exact uid? Prevents duplicate concurrent
 * registration calls (e.g. onAuthStateChanged firing more than once for
 * the same uid in quick succession — a token refresh, a Fast Refresh in
 * development, etc.) without blocking a registration for a genuinely
 * DIFFERENT uid.
 */
export function shouldStartRegistrationAttempt(inFlightUid: string | null, uid: string): boolean {
  return inFlightUid !== uid;
}

/**
 * Once a registration attempt for `attemptedUid` resolves, is the
 * session it was attempted for still the CURRENT one? `currentUid` is
 * whatever the auth provider's own latest onAuthStateChanged callback
 * last observed — if it no longer matches `attemptedUid`, the write
 * that registration attempt may have just performed is stale and must
 * be compensated for (see syncPushTokenForAuthenticatedSession's own
 * doc comment for exactly how).
 */
export function isRegistrationResultStale(currentUid: string | null, attemptedUid: string): boolean {
  return currentUid !== attemptedUid;
}
