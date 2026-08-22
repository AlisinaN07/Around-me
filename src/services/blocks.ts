/**
 * User blocks — blocks/{blockerUid}_{blockedUid}. UI code should only
 * ever import from here, never talk to Firestore directly for blocks.
 *
 * A block prevents NEW direct interaction (follow, like, comment,
 * message) between the two users in both directions — enforced by
 * Firestore rules on those collections, not just here. It does not erase
 * existing history: prior likes/comments/messages/notifications remain
 * (see firestore.rules and the Step 17 spec for the exact MVP boundary —
 * dynamically filtering all published content between blocked users out
 * of city-wide feed queries is out of scope; only NEW interactions are
 * security-enforced, and Home does its own best-effort client-side
 * filtering of authored content from users the viewer has blocked).
 */

import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type WithFieldValue,
} from 'firebase/firestore';

import { buildNotificationId, notificationRef } from '@/services/notifications';
import { fetchPublicProfile } from '@/services/publicProfile';
import type { Block } from '@/types/block';

import { firestore } from './firestore';
import { followRef } from './following';

const BLOCKS_COLLECTION = 'blocks';
const DEFAULT_BLOCKED_LIST_LIMIT = 50;

function blockDocId(blockerUid: string, blockedUid: string): string {
  return `${blockerUid}_${blockedUid}`;
}

function blockRef(blockerUid: string, blockedUid: string) {
  return doc(firestore!, BLOCKS_COLLECTION, blockDocId(blockerUid, blockedUid));
}

export type BlockActionError = 'not-configured' | 'invalid-input' | 'unknown';
export type BlockActionResult = { ok: true } | { ok: false; error: BlockActionError; message: string };

/**
 * Only the blocker can ever read their own block doc (see
 * firestore.rules) — this only ever makes sense called with the caller's
 * OWN uid as `blockerUid`. There is deliberately no way to check "has the
 * other person blocked me" — see the Step 17 no-information-leak rule.
 */
export async function isUserBlocked(blockerUid: string, blockedUid: string): Promise<boolean> {
  if (!firestore) return false;
  const snapshot = await getDoc(blockRef(blockerUid, blockedUid));
  return snapshot.exists();
}

/** The caller's own outgoing blocks only — never another user's. Explicitly capped, resolved via publicProfiles only. */
export async function fetchMyBlockedUserIds(uid: string, limitCount = DEFAULT_BLOCKED_LIST_LIMIT): Promise<string[]> {
  if (!firestore) return [];
  const snapshot = await getDocs(
    query(collection(firestore, BLOCKS_COLLECTION), where('blockerUid', '==', uid), limit(limitCount))
  );
  return snapshot.docs.map((docSnapshot) => (docSnapshot.data() as Block).blockedUid);
}

/**
 * Blocking removes BOTH follow edges (if they exist), atomically with the
 * block itself, so Following counts/feeds never keep a stale relationship
 * with someone you've just blocked. Likes, comments, and messages are
 * deliberately left alone — blocking only stops NEW interaction, it
 * doesn't erase history.
 *
 * Existence of each follow edge is checked BEFORE building the batch
 * (rather than unconditionally including its delete) — a delete targeting
 * a genuinely nonexistent document can make Firestore Rules evaluate a
 * null `resource`, which denies the whole batch; this app has hit that
 * exact class of bug before (see Step 16's conversation read-rule fix),
 * so every conditional delete here is deliberately pre-verified to exist
 * first.
 *
 * Only the BACKWARD follow notification (target followed blocker, so the
 * blocker is the recipient) is ever touched — notifications are readable
 * and deletable only by their recipient (see firestore.rules), so the
 * blocker has no permission to read or delete the FORWARD notification
 * (blocker followed target — the target is its recipient). That one is
 * simply left in place; this matches the spec's "if easily/safely
 * possible" qualifier and the rule that historical notifications aren't
 * wiped wholesale.
 */
export async function blockUser(blockerUid: string, targetUid: string): Promise<BlockActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  if (blockerUid === targetUid) {
    return { ok: false, error: 'invalid-input', message: "You can't block yourself." };
  }

  const existingBlock = await getDoc(blockRef(blockerUid, targetUid));
  if (existingBlock.exists()) {
    return { ok: true };
  }

  const targetProfile = await fetchPublicProfile(targetUid);
  if (!targetProfile) {
    return { ok: false, error: 'unknown', message: "Couldn't block this user." };
  }

  const [forwardFollow, backwardFollow] = await Promise.all([
    getDoc(followRef(blockerUid, targetUid)),
    getDoc(followRef(targetUid, blockerUid)),
  ]);
  const backwardNotificationId = buildNotificationId('follow', { actorUid: targetUid, recipientUid: blockerUid });
  const backwardNotification = backwardFollow.exists()
    ? await getDoc(notificationRef(backwardNotificationId))
    : null;

  try {
    const batch = writeBatch(firestore);
    batch.set(blockRef(blockerUid, targetUid), {
      blockId: blockDocId(blockerUid, targetUid),
      blockerUid,
      blockedUid: targetUid,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<Block>);

    if (forwardFollow.exists()) {
      batch.delete(followRef(blockerUid, targetUid));
    }
    if (backwardFollow.exists()) {
      batch.delete(followRef(targetUid, blockerUid));
      if (backwardNotification?.exists()) {
        batch.delete(notificationRef(backwardNotificationId));
      }
    }

    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't block this user." };
  }
  return { ok: true };
}

export async function unblockUser(blockerUid: string, targetUid: string): Promise<BlockActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await deleteDoc(blockRef(blockerUid, targetUid));
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't unblock this user." };
  }
  return { ok: true };
}
