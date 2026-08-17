/**
 * Activity participation (join/leave) and Event responses (interested/going).
 * UI code should only ever import from here, never talk to Firestore
 * directly for engagement data.
 */

import {
  collection,
  deleteDoc,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type WithFieldValue,
} from 'firebase/firestore';

import type { ActivityContent, ActivityParticipant, ActivityStats, EventContent, EventResponse, EventResponseStatus } from '@/types/content';

import { firestore } from './firestore';
import { fetchUserProfile } from './userProfile';

const CONTENT_COLLECTION = 'content';
const DEFAULT_PARTICIPANT_LIMIT = 10;

export type EngagementError =
  | 'not-configured'
  | 'no-profile'
  | 'not-found'
  | 'ended'
  | 'full'
  | 'unknown';

export type EngagementResult<T> = { ok: true } & T | { ok: false; error: EngagementError; message: string };

class TransactionAbort extends Error {
  constructor(
    public code: EngagementError,
    message: string
  ) {
    super(message);
  }
}

type TrustedParticipantFields = { displayName: string; username: string };
type TrustedResult = { ok: true; fields: TrustedParticipantFields } | { ok: false; error: EngagementError; message: string };

/** Public-safe snapshot always comes from the caller's own completed profile — never from UI input. */
async function resolveTrustedFields(uid: string): Promise<TrustedResult> {
  const profile = await fetchUserProfile(uid);
  if (!profile || !profile.onboardingCompleted) {
    return { ok: false, error: 'no-profile', message: 'Complete your profile first.' };
  }
  return { ok: true, fields: { displayName: profile.displayName, username: profile.username } };
}

function contentDocRef(contentId: string) {
  return doc(firestore!, CONTENT_COLLECTION, contentId);
}
function participantRef(activityId: string, uid: string) {
  return doc(firestore!, CONTENT_COLLECTION, activityId, 'participants', uid);
}
function statsRef(activityId: string) {
  return doc(firestore!, CONTENT_COLLECTION, activityId, 'stats', 'activity');
}
function responseRef(eventId: string, uid: string) {
  return doc(firestore!, CONTENT_COLLECTION, eventId, 'responses', uid);
}

// ---------------------------------------------------------------------------
// Activities — join / leave
// ---------------------------------------------------------------------------

export type JoinActivityResult = EngagementResult<{ alreadyJoined: boolean; participantCount: number }>;

export async function joinActivity(activityId: string, uid: string): Promise<JoinActivityResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  try {
    const outcome = await runTransaction(firestore, async (tx) => {
      const [activitySnap, participantSnap, statsSnap] = await Promise.all([
        tx.get(contentDocRef(activityId)),
        tx.get(participantRef(activityId, uid)),
        tx.get(statsRef(activityId)),
      ]);

      if (!activitySnap.exists() || activitySnap.data().type !== 'activity' || activitySnap.data().status !== 'published') {
        throw new TransactionAbort('not-found', "Couldn't join activity.");
      }
      const activity = activitySnap.data() as ActivityContent;
      if (activity.endsAt.toMillis() <= Date.now()) {
        throw new TransactionAbort('ended', 'Activity has ended.');
      }

      const currentCount = statsSnap.exists() ? (statsSnap.data() as ActivityStats).participantCount : 0;

      if (participantSnap.exists()) {
        return { alreadyJoined: true, participantCount: currentCount };
      }

      if (activity.maxParticipants !== undefined && currentCount >= activity.maxParticipants) {
        throw new TransactionAbort('full', 'Activity is full.');
      }

      const nextCount = currentCount + 1;
      tx.set(participantRef(activityId, uid), {
        uid,
        displayName: trusted.fields.displayName,
        username: trusted.fields.username,
        joinedAt: serverTimestamp(),
      } satisfies WithFieldValue<ActivityParticipant>);
      tx.set(statsRef(activityId), {
        participantCount: nextCount,
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<ActivityStats>);

      return { alreadyJoined: false, participantCount: nextCount };
    });

    return { ok: true, ...outcome };
  } catch (error) {
    if (error instanceof TransactionAbort) {
      return { ok: false, error: error.code, message: error.message };
    }
    return { ok: false, error: 'unknown', message: "Couldn't join activity." };
  }
}

export type LeaveActivityResult = EngagementResult<{ wasJoined: boolean; participantCount: number }>;

export async function leaveActivity(activityId: string, uid: string): Promise<LeaveActivityResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  try {
    const outcome = await runTransaction(firestore, async (tx) => {
      const [participantSnap, statsSnap] = await Promise.all([tx.get(participantRef(activityId, uid)), tx.get(statsRef(activityId))]);

      const currentCount = statsSnap.exists() ? (statsSnap.data() as ActivityStats).participantCount : 0;

      if (!participantSnap.exists()) {
        return { wasJoined: false, participantCount: currentCount };
      }

      const nextCount = Math.max(0, currentCount - 1);
      tx.delete(participantRef(activityId, uid));
      tx.set(statsRef(activityId), {
        participantCount: nextCount,
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<ActivityStats>);

      return { wasJoined: true, participantCount: nextCount };
    });

    return { ok: true, ...outcome };
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't leave activity." };
  }
}

/** One-shot read (not a transaction) of the caller's own join state + the current count. */
export async function getActivityParticipation(
  activityId: string,
  uid: string | null
): Promise<{ isJoined: boolean; participantCount: number }> {
  if (!firestore) return { isJoined: false, participantCount: 0 };

  const statsSnap = await getDoc(statsRef(activityId));
  const participantCount = statsSnap.exists() ? (statsSnap.data() as ActivityStats).participantCount : 0;

  if (!uid) return { isJoined: false, participantCount };

  const participantSnap = await getDoc(participantRef(activityId, uid));
  return { isJoined: participantSnap.exists(), participantCount };
}

/** Oldest-joined-first preview list, explicitly limited — never an unbounded fetch. */
export async function fetchActivityParticipants(
  activityId: string,
  limitCount = DEFAULT_PARTICIPANT_LIMIT
): Promise<ActivityParticipant[]> {
  if (!firestore) return [];
  const participantsQuery = query(
    collection(firestore, CONTENT_COLLECTION, activityId, 'participants'),
    orderBy('joinedAt', 'asc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(participantsQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as ActivityParticipant);
}

// ---------------------------------------------------------------------------
// Events — interested / going
// ---------------------------------------------------------------------------

export type SetEventResponseResult = EngagementResult<{ status: EventResponseStatus }>;

export async function setEventResponse(eventId: string, uid: string, status: EventResponseStatus): Promise<SetEventResponseResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  const eventSnap = await getDoc(contentDocRef(eventId));
  if (!eventSnap.exists() || eventSnap.data().type !== 'event' || eventSnap.data().status !== 'published') {
    return { ok: false, error: 'not-found', message: "Couldn't update your response." };
  }
  const event = eventSnap.data() as EventContent;
  if (event.endsAt.toMillis() <= Date.now()) {
    return { ok: false, error: 'ended', message: 'Event has ended.' };
  }

  try {
    const existingSnap = await getDoc(responseRef(eventId, uid));
    if (existingSnap.exists()) {
      await updateDoc(responseRef(eventId, uid), { status, updatedAt: serverTimestamp() });
    } else {
      await setDoc(responseRef(eventId, uid), {
        uid,
        displayName: trusted.fields.displayName,
        username: trusted.fields.username,
        status,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<EventResponse>);
    }
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't update your response." };
  }

  return { ok: true, status };
}

export async function removeEventResponse(
  eventId: string,
  uid: string
): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    await deleteDoc(responseRef(eventId, uid));
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't update your response." };
  }
  return { ok: true };
}

export async function fetchMyEventResponse(eventId: string, uid: string): Promise<EventResponse | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(responseRef(eventId, uid));
  return snapshot.exists() ? (snapshot.data() as EventResponse) : null;
}

export type EventResponseCounts = { interestedCount: number; goingCount: number };

/** Server-side aggregation counts — never fetches every response document just to count them. */
export async function fetchEventResponseCounts(eventId: string): Promise<EventResponseCounts> {
  if (!firestore) return { interestedCount: 0, goingCount: 0 };

  const responsesCollection = collection(firestore, CONTENT_COLLECTION, eventId, 'responses');
  const [interestedSnap, goingSnap] = await Promise.all([
    getCountFromServer(query(responsesCollection, where('status', '==', 'interested'))),
    getCountFromServer(query(responsesCollection, where('status', '==', 'going'))),
  ]);

  return {
    interestedCount: interestedSnap.data().count,
    goingCount: goingSnap.data().count,
  };
}
