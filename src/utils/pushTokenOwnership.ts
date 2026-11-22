/**
 * Pure decision behind the ACTUAL cross-account privacy guarantee this
 * whole mechanism exists for: "given the current, server-maintained
 * record of who legitimately owns a physical push token right now,
 * should a notification meant for `recipientUid` ever be sent to it?"
 *
 * This is deliberately separate from, and does NOT depend on, whether
 * any PER-USER `users/{uid}/pushTokens/{deviceId}` document still
 * exists — a stale document surviving a failed logout is explicitly
 * NOT what this check looks at. It looks ONLY at the current value of
 * `pushTokenOwners/{token}` (see pushTokens.ts's own doc comment),
 * which is reassigned to the new user on every real registration,
 * regardless of whether the previous user's own cleanup ever ran.
 *
 * NOTE: this file only implements the DECISION. There is no send-side
 * implementation in this codebase yet (explicitly out of scope — see
 * this step's own restrictions) — a future send implementation MUST
 * call this (or the equivalent server-side check) before ever
 * delivering to a token; this file alone does not enforce anything by
 * existing. See the final report's own "server-side enforcement and its
 * limitations" section for why that distinction matters.
 */
export type PushTokenOwnershipRecord = { uid: string } | null;

/**
 * `null` ownership record means either the token was never registered,
 * or its owner released it (e.g. a clean logout) without a new owner
 * having claimed it yet — in both cases, nothing should ever be sent,
 * since there is no currently-confirmed legitimate recipient for it.
 */
export function isTokenCurrentlyOwnedBy(ownership: PushTokenOwnershipRecord, recipientUid: string): boolean {
  return ownership !== null && ownership.uid === recipientUid;
}
