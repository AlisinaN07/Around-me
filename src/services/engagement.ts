/**
 * Activity participation (join/leave) and Event responses (interested/going).
 * UI code should only ever import from here, never talk to Firestore
 * directly for engagement data.
 */

import {
  collection,
  doc,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  where,
  type WithFieldValue,
} from 'firebase/firestore';

import type { ActivityContent, ActivityParticipant, ActivityStats, EventContent, EventResponse, EventResponseStatus } from '@/types/content';
import type { Notification } from '@/types/notification';

import { firestore } from './firestore';
import { buildNotificationId, notificationRef } from './notifications';
import { trackContentInteraction } from './recommendations/interactions';
import { fetchUserProfile } from './userProfile';

/** Fire-and-forget — a recommendation-signal write never blocks or fails the real event-response action. */
function trackEventResponseSignal(uid: string, event: EventContent, status: EventResponseStatus): void {
  trackContentInteraction({
    userId: uid,
    contentId: event.contentId,
    contentType: 'content',
    action: status === 'going' ? 'event_going' : 'event_interested',
    categoryId: event.categoryId,
    creatorId: event.authorUid,
    cityKey: event.cityKey,
    countryCode: event.countryCode,
  }).catch(() => {});
}

const CONTENT_COLLECTION = 'content';
const DEFAULT_PARTICIPANT_LIMIT = 10;

export type EngagementError =
  | 'not-configured'
  | 'no-profile'
  | 'not-found'
  | 'ended'
  | 'full'
  | 'invalid-input'
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
export type TrustedFieldsResult = { ok: true; fields: TrustedParticipantFields } | { ok: false; error: EngagementError; message: string };

/**
 * Public-safe snapshot always comes from the caller's own completed profile
 * — never from UI input. Exported so src/services/socialEngagement.ts (likes,
 * comments) can reuse the exact same "does this uid have a completed
 * profile" gate instead of duplicating it.
 */
export async function resolveTrustedFields(uid: string): Promise<TrustedFieldsResult> {
  const profile = await fetchUserProfile(uid);
  if (!profile || !profile.onboardingCompleted) {
    return { ok: false, error: 'no-profile', message: 'Complete your profile first.' };
  }
  return { ok: true, fields: { displayName: profile.displayName, username: profile.username } };
}

/** Exported so socialEngagement.ts can check the same content doc without a second constant. */
export function contentDocRef(contentId: string) {
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

      // Notification lands in the same transaction as the participant +
      // counter writes — Firestore rules require the participant doc to
      // existAfter() for this create to validate (see firestore.rules), so
      // "notification exists" can never be true without a real join having
      // landed. Never notify yourself for your own Activity. This branch
      // only ever runs on a genuinely first-time join (the alreadyJoined
      // early-return above already handled re-joins), so the notification
      // is guaranteed not to already exist — a plain create, never an
      // update.
      if (uid !== activity.authorUid) {
        const notificationId = buildNotificationId('activity_join', { contentId: activityId, actorUid: uid });
        tx.set(notificationRef(notificationId), {
          notificationId,
          recipientUid: activity.authorUid,
          actorUid: uid,
          actorDisplayName: trusted.fields.displayName,
          actorUsername: trusted.fields.username,
          type: 'activity_join',
          contentId: activityId,
          reelId: null,
          commentId: null,
          previewText: null,
          responseStatus: null,
          read: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } satisfies WithFieldValue<Notification>);
      }

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
      const [activitySnap, participantSnap, statsSnap] = await Promise.all([
        tx.get(contentDocRef(activityId)),
        tx.get(participantRef(activityId, uid)),
        tx.get(statsRef(activityId)),
      ]);

      const currentCount = statsSnap.exists() ? (statsSnap.data() as ActivityStats).participantCount : 0;

      if (!participantSnap.exists()) {
        return { wasJoined: false, participantCount: currentCount };
      }

      // All reads (including the notification pre-check below) must happen
      // before any writes in a Firestore transaction — this is why the
      // notification lookup is resolved here, ahead of the participant/
      // stats deletes further down, rather than interleaved with them.
      // Never look up (or delete) a notification for your own Activity —
      // joining your own Activity never created one. A plain, unconditional
      // delete would risk Firestore Rules evaluating a null `resource` for
      // a genuinely nonexistent notification (the exact class of bug this
      // app hit once before with block-related deletes — see
      // src/services/blocks.ts) — so existence is checked first.
      const activity = activitySnap.exists() ? (activitySnap.data() as ActivityContent) : null;
      const notificationId =
        activity && uid !== activity.authorUid ? buildNotificationId('activity_join', { contentId: activityId, actorUid: uid }) : null;
      const notificationSnap = notificationId ? await tx.get(notificationRef(notificationId)) : null;

      const nextCount = Math.max(0, currentCount - 1);
      tx.delete(participantRef(activityId, uid));
      tx.set(statsRef(activityId), {
        participantCount: nextCount,
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<ActivityStats>);

      if (notificationId && notificationSnap?.exists()) {
        tx.delete(notificationRef(notificationId));
      }

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
  const db = firestore;

  const trusted = await resolveTrustedFields(uid);
  if (!trusted.ok) return trusted;

  // Captured inside the transaction below, used for tracking only after
  // it commits successfully.
  let trackedEvent: EventContent | null = null;

  try {
    await runTransaction(db, async (tx) => {
      const eventSnap = await tx.get(contentDocRef(eventId));
      if (!eventSnap.exists() || eventSnap.data().type !== 'event' || eventSnap.data().status !== 'published') {
        throw new TransactionAbort('not-found', "Couldn't update your response.");
      }
      const event = eventSnap.data() as EventContent;
      if (event.endsAt.toMillis() <= Date.now()) {
        throw new TransactionAbort('ended', 'Event has ended.');
      }
      trackedEvent = event;

      const existingSnap = await tx.get(responseRef(eventId, uid));
      const currentStatus = existingSnap.exists() ? (existingSnap.data() as EventResponse).status : null;

      // ONE logical notification per (actor, event) representing the
      // actor's CURRENT response (see src/types/notification.ts) — never
      // notify yourself. Reading it here, before any writes below, keeps
      // every tx.get() ahead of every tx.set()/tx.delete(), which Firestore
      // transactions require.
      const isSelf = uid === event.authorUid;
      const notificationId = isSelf ? null : buildNotificationId('event_response', { contentId: eventId, actorUid: uid });
      const notificationSnap = notificationId ? await tx.get(notificationRef(notificationId)) : null;

      // Response write — create or update, exactly as before Step 38.
      if (existingSnap.exists()) {
        tx.update(responseRef(eventId, uid), { status, updatedAt: serverTimestamp() });
      } else {
        tx.set(responseRef(eventId, uid), {
          uid,
          displayName: trusted.fields.displayName,
          username: trusted.fields.username,
          status,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } satisfies WithFieldValue<EventResponse>);
      }

      // Only touch the notification when the response is actually new or
      // its status is actually changing — tapping/selecting the same
      // status again must stay a true no-op (Step 38 Section 13), and must
      // never spuriously reset an already-read notification back to
      // unread. Interested <-> Going updates the SAME document (never a
      // second one) and deliberately bumps createdAt to a fresh
      // serverTimestamp alongside read:false — the Event creator should
      // see this as a new Activity update, sorted to the top of their
      // Inbox, not a stale entry sitting wherever the original Interested
      // notification first landed (see firestore.rules' narrow update
      // rule for this exact transition).
      if (notificationId && currentStatus !== status) {
        const notificationData = {
          notificationId,
          recipientUid: event.authorUid,
          actorUid: uid,
          actorDisplayName: trusted.fields.displayName,
          actorUsername: trusted.fields.username,
          type: 'event_response' as const,
          contentId: eventId,
          reelId: null,
          commentId: null,
          previewText: null,
          responseStatus: status,
          read: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } satisfies WithFieldValue<Notification>;

        if (notificationSnap?.exists()) {
          tx.update(notificationRef(notificationId), notificationData);
        } else {
          tx.set(notificationRef(notificationId), notificationData);
        }
      }
    });
  } catch (error) {
    if (error instanceof TransactionAbort) {
      return { ok: false, error: error.code, message: error.message };
    }
    return { ok: false, error: 'unknown', message: "Couldn't update your response." };
  }

  if (trackedEvent) {
    trackEventResponseSignal(uid, trackedEvent, status);
  }
  return { ok: true, status };
}

export async function removeEventResponse(
  eventId: string,
  uid: string
): Promise<{ ok: true } | { ok: false; error: EngagementError; message: string }> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  const db = firestore;

  // The notification ID is deterministic from (eventId, uid) alone — no
  // need to read the Event doc to find its author here. Existence is
  // checked before deleting (same reasoning as leaveActivity/blocks.ts):
  // an unconditional delete of a genuinely nonexistent notification risks
  // Firestore Rules evaluating a null `resource`. A self-response never
  // has a paired notification, so this is naturally a no-op for that case.
  const notificationId = buildNotificationId('event_response', { contentId: eventId, actorUid: uid });
  try {
    await runTransaction(db, async (tx) => {
      const notificationSnap = await tx.get(notificationRef(notificationId));
      tx.delete(responseRef(eventId, uid));
      if (notificationSnap.exists()) {
        tx.delete(notificationRef(notificationId));
      }
    });
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
