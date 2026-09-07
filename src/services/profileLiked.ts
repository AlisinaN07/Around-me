/**
 * Lifetime "Liked" Profile stat — Step 41.2H.4. The client never queries
 * `postLikes` directly (it stays completely unreadable by any client, see
 * firestore.rules) and never derives this number from loaded Posts/Reels,
 * Reposts, Saved, or Activities — it is always the trusted
 * `fetchLifetimeLikedCount` callable's own server-side aggregate, exactly
 * `COUNT(postLikes where targetAuthorUid == profileUid)`
 * (functions/src/index.ts).
 *
 * `ready: false` means the H.3 migration-completion gate hasn't (yet)
 * certified the count as authoritative — never a fake 0. A callable
 * failure of any kind (network, permission, not-found, internal) is
 * caught here and ALSO folded into `{ ready: false }` rather than thrown:
 * a failed Liked fetch must not turn into a lying "0 Liked", but it also
 * must not fail the whole Profile load the way fetchProfilePostCount/
 * fetchFollowerCount/fetchFollowingCount intentionally do (see profile.tsx
 * and user/[uid]/index.tsx — those three are load-bearing for the rest of
 * the screen; Liked is the one addition that is allowed to simply be
 * absent for a given load).
 */

import { httpsCallable } from 'firebase/functions';

import { functions } from './functions';

export type LifetimeLikedResult = { ready: true; likedCount: number } | { ready: false };

type RawFetchLifetimeLikedCountResponse = { ready: true; likedCount: number } | { ready: false };

/**
 * Callable for ANY profileUid (own or someone else's) — Liked is a public
 * Profile stat exactly like Posts/Following/Followers, resolved the same
 * way regardless of whose Profile is loading it.
 */
export async function fetchLifetimeLikedCount(profileUid: string): Promise<LifetimeLikedResult> {
  if (!functions) return { ready: false };

  try {
    const call = httpsCallable<{ profileUid: string }, RawFetchLifetimeLikedCountResponse>(functions, 'fetchLifetimeLikedCount');
    const result = await call({ profileUid });
    return result.data.ready ? { ready: true, likedCount: result.data.likedCount } : { ready: false };
  } catch {
    return { ready: false };
  }
}
