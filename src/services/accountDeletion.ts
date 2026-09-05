/**
 * Client wrapper around the deleteMyAccountData trusted backend (Step 34.2 —
 * functions/src/index.ts). Never sends any identity parameter — the
 * callable derives the target exclusively from the caller's own ID token.
 * UI code should only ever import from here for triggering backend
 * deletion, never call httpsCallable directly.
 */
import { httpsCallable } from 'firebase/functions';

import { functions } from './functions';

export type DeleteMyAccountDataResult = { ok: true } | { ok: false; message: string };

/**
 * Invokes the backend deletion callable. Safe to call more than once for
 * the same account — the backend is idempotent (see README "Trusted
 * account-deletion backend"), so a retry after a prior failure is expected
 * and correct, not a bug.
 */
export async function deleteMyAccountData(): Promise<DeleteMyAccountDataResult> {
  if (!functions) {
    return { ok: false, message: 'This feature is not available right now.' };
  }
  try {
    await httpsCallable(functions, 'deleteMyAccountData')({});
  } catch {
    return { ok: false, message: "We couldn't finish deleting your account." };
  }
  return { ok: true };
}
