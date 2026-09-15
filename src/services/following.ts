/**
 * The follow graph — follows/{followerUid}_{followingUid}. UI code should
 * only ever import from here, never talk to Firestore directly for follow
 * edges.
 */

import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  where,
  writeBatch,
  type WithFieldValue,
} from 'firebase/firestore';

import { fetchPublicProfile } from '@/services/publicProfile';
import type { Follow, PublicProfile } from '@/types/social';
import type { Notification } from '@/types/notification';

import { firestore } from './firestore';
import { buildNotificationId, notificationRef } from './notifications';
import { trackContentInteraction } from './recommendations/interactions';

/**
 * Fire-and-forget — a recommendation-signal write never blocks or fails
 * the real follow/unfollow action. No categoryId here (a follow is a
 * creator-affinity signal, not tied to one category) — applyInteractionToProfile
 * already skips updating a score for an empty key.
 *
 * Recommendation Engine — Step 3 — `targetCityKey`/`targetCountryCode`
 * (the FOLLOWED account's own home city, not the follower's) are new as
 * of this pass: `follow`/`unfollow` previously always passed an empty
 * cityKey, meaning the single most decisive real-world location signal
 * this app has — deliberately choosing to follow a specific place's
 * account — never touched `cityScores` AT ALL, despite `follow` already
 * having a defined (and, since this pass, a boosted — see
 * CITY_WEIGHT_OVERRIDES) city weight. See followUser/unfollowUser below
 * for where these are actually resolved from the target's own public
 * profile.
 */
function trackFollowSignal(
  uid: string,
  targetUid: string,
  action: 'follow' | 'unfollow',
  targetCityKey: string,
  targetCountryCode: string
): void {
  trackContentInteraction({
    userId: uid,
    contentId: targetUid,
    contentType: 'content',
    action,
    categoryId: '',
    creatorId: targetUid,
    cityKey: targetCityKey,
    countryCode: targetCountryCode,
  }).catch(() => {});
}

const FOLLOWS_COLLECTION = 'follows';
const DEFAULT_LIST_LIMIT = 30;

function followDocId(followerUid: string, followingUid: string): string {
  return `${followerUid}_${followingUid}`;
}

/** Exported for src/services/blocks.ts, which needs to remove both possible follow edges when a block is created. */
export function followRef(followerUid: string, followingUid: string) {
  return doc(firestore!, FOLLOWS_COLLECTION, followDocId(followerUid, followingUid));
}

export type FollowActionError = 'not-configured' | 'invalid-input' | 'unknown';
export type FollowActionResult = { ok: true } | { ok: false; error: FollowActionError; message: string };

export async function followUser(followerUid: string, targetUid: string): Promise<FollowActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  if (followerUid === targetUid) {
    return { ok: false, error: 'invalid-input', message: "You can't follow yourself." };
  }

  const existing = await getDoc(followRef(followerUid, targetUid));
  if (existing.exists()) {
    return { ok: true };
  }

  // The notification's actor snapshot comes from the follower's own PUBLIC
  // profile — exactly the public-safe info a notification should show,
  // and consistent with how the follow edge itself is validated.
  // targetProfile is fetched alongside it purely for the recommendation
  // signal below (see trackFollowSignal's own doc comment) — a missing
  // target profile still lets the real follow action proceed; the city
  // signal simply falls back to an empty string, same as before this
  // pass, rather than blocking the follow itself over it.
  const [actorProfile, targetProfile] = await Promise.all([fetchPublicProfile(followerUid), fetchPublicProfile(targetUid)]);
  if (!actorProfile) {
    return { ok: false, error: 'unknown', message: "Couldn't follow this user." };
  }

  try {
    // Follow + notification land atomically — see firestore.rules, which
    // requires the follow edge to exist (existsAfter) for the notification
    // create to be valid. Self-follow is already impossible (checked above).
    const notificationId = buildNotificationId('follow', { actorUid: followerUid, recipientUid: targetUid });
    const batch = writeBatch(firestore);
    batch.set(followRef(followerUid, targetUid), {
      followerUid,
      followingUid: targetUid,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<Follow>);
    batch.set(notificationRef(notificationId), {
      notificationId,
      recipientUid: targetUid,
      actorUid: followerUid,
      actorDisplayName: actorProfile.displayName,
      actorUsername: actorProfile.username,
      type: 'follow',
      contentId: null,
      reelId: null,
      commentId: null,
      previewText: null,
      responseStatus: null,
      read: false,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    } satisfies WithFieldValue<Notification>);
    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't follow this user." };
  }
  trackFollowSignal(followerUid, targetUid, 'follow', targetProfile?.cityKey ?? '', targetProfile?.countryCode ?? '');
  return { ok: true };
}

export async function unfollowUser(followerUid: string, targetUid: string): Promise<FollowActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  // Fetched purely for the recommendation signal below (same reasoning as
  // followUser's own targetProfile fetch) — a lookup failure still lets
  // the real unfollow proceed via the empty-string fallback.
  const targetProfile = await fetchPublicProfile(targetUid);
  try {
    // Removing the follow edge and its notification land in the same
    // batch, so a follow notification can never outlive the follow it was
    // for.
    const batch = writeBatch(firestore);
    batch.delete(followRef(followerUid, targetUid));
    batch.delete(notificationRef(buildNotificationId('follow', { actorUid: followerUid, recipientUid: targetUid })));
    await batch.commit();
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't unfollow this user." };
  }
  trackFollowSignal(followerUid, targetUid, 'unfollow', targetProfile?.cityKey ?? '', targetProfile?.countryCode ?? '');
  return { ok: true };
}

export async function isFollowing(followerUid: string, targetUid: string): Promise<boolean> {
  if (!firestore) return false;
  const snapshot = await getDoc(followRef(followerUid, targetUid));
  return snapshot.exists();
}

/** Server-side aggregation count — never fetches every follow document just to count them. */
export async function fetchFollowerCount(uid: string): Promise<number> {
  if (!firestore) return 0;
  const snapshot = await getCountFromServer(query(collection(firestore, FOLLOWS_COLLECTION), where('followingUid', '==', uid)));
  return snapshot.data().count;
}

export async function fetchFollowingCount(uid: string): Promise<number> {
  if (!firestore) return 0;
  const snapshot = await getCountFromServer(query(collection(firestore, FOLLOWS_COLLECTION), where('followerUid', '==', uid)));
  return snapshot.data().count;
}

async function resolveProfiles(uids: string[]): Promise<PublicProfile[]> {
  const profiles = await Promise.all(uids.map((uid) => fetchPublicProfile(uid)));
  return profiles.filter((profile): profile is PublicProfile => profile !== null);
}

/**
 * Explicitly limited, no orderBy — a where()-only equality query needs no
 * composite index, and list ordering isn't a Step 11 requirement. Never
 * fetches beyond `limitCount` follow edges.
 */
export async function fetchFollowers(uid: string, limitCount = DEFAULT_LIST_LIMIT): Promise<PublicProfile[]> {
  if (!firestore) return [];
  const snapshot = await getDocs(query(collection(firestore, FOLLOWS_COLLECTION), where('followingUid', '==', uid), limit(limitCount)));
  return resolveProfiles(snapshot.docs.map((docSnapshot) => (docSnapshot.data() as Follow).followerUid));
}

export async function fetchFollowing(uid: string, limitCount = DEFAULT_LIST_LIMIT): Promise<PublicProfile[]> {
  if (!firestore) return [];
  const snapshot = await getDocs(query(collection(firestore, FOLLOWS_COLLECTION), where('followerUid', '==', uid), limit(limitCount)));
  return resolveProfiles(snapshot.docs.map((docSnapshot) => (docSnapshot.data() as Follow).followingUid));
}

/**
 * Foundation for a future personalized "Following" feed — not wired to any
 * UI in Step 11 (Around Me stays city-first; see README). Returns the uids
 * a user follows, same limit/no-index approach as fetchFollowing. A real
 * feed will need to batch these into chunked Firestore `in` queries (30
 * values max per query on this SDK) or a different fan-out strategy once a
 * user follows more people than fit in one page — intentionally not
 * attempted here.
 */
export async function fetchFollowingUids(uid: string, limitCount = DEFAULT_LIST_LIMIT): Promise<string[]> {
  if (!firestore) return [];
  const snapshot = await getDocs(query(collection(firestore, FOLLOWS_COLLECTION), where('followerUid', '==', uid), limit(limitCount)));
  return snapshot.docs.map((docSnapshot) => (docSnapshot.data() as Follow).followingUid);
}
