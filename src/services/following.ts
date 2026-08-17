/**
 * The follow graph — follows/{followerUid}_{followingUid}. UI code should
 * only ever import from here, never talk to Firestore directly for follow
 * edges.
 */

import {
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  setDoc,
  where,
  type WithFieldValue,
} from 'firebase/firestore';

import { fetchPublicProfile } from '@/services/publicProfile';
import type { Follow, PublicProfile } from '@/types/social';

import { firestore } from './firestore';

const FOLLOWS_COLLECTION = 'follows';
const DEFAULT_LIST_LIMIT = 30;

function followDocId(followerUid: string, followingUid: string): string {
  return `${followerUid}_${followingUid}`;
}

function followRef(followerUid: string, followingUid: string) {
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

  try {
    await setDoc(followRef(followerUid, targetUid), {
      followerUid,
      followingUid: targetUid,
      createdAt: serverTimestamp(),
    } satisfies WithFieldValue<Follow>);
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't follow this user." };
  }
  return { ok: true };
}

export async function unfollowUser(followerUid: string, targetUid: string): Promise<FollowActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await deleteDoc(followRef(followerUid, targetUid));
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't unfollow this user." };
  }
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
