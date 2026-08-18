/**
 * Private 1:1 direct messages — conversations/{conversationId} and
 * conversations/{conversationId}/messages/{messageId}. UI code should only
 * ever import from here, never talk to Firestore directly for messaging.
 *
 * Text-only, no edit/delete, no group chats — see src/types/message.ts.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
  type Unsubscribe,
  type WithFieldValue,
} from 'firebase/firestore';

import { fetchPublicProfile } from '@/services/publicProfile';
import { MESSAGE_BODY_MAX_LENGTH, type Conversation, type Message } from '@/types/message';

import { firestore } from './firestore';

const CONVERSATIONS_COLLECTION = 'conversations';
const MESSAGES_SUBCOLLECTION = 'messages';
const DEFAULT_CONVERSATIONS_LIMIT = 30;
const DEFAULT_MESSAGES_LIMIT = 50;

/**
 * Canonical, order-independent conversation ID for a user pair —
 * lexicographic string comparison, the same ordering Firestore Rules apply
 * to strings (verified via the rules test suite, not assumed). This is
 * what guarantees exactly one 1:1 conversation per pair, regardless of who
 * starts it.
 */
export function getConversationId(uidA: string, uidB: string): string {
  return uidA < uidB ? `${uidA}_${uidB}` : `${uidB}_${uidA}`;
}

function sortedPair(uidA: string, uidB: string): [string, string] {
  return uidA < uidB ? [uidA, uidB] : [uidB, uidA];
}

export function otherParticipantUid(conversation: Conversation, uid: string): string {
  return conversation.participantUids[0] === uid ? conversation.participantUids[1] : conversation.participantUids[0];
}

function conversationRef(conversationId: string) {
  return doc(firestore!, CONVERSATIONS_COLLECTION, conversationId);
}

function messagesCollection(conversationId: string) {
  return collection(firestore!, CONVERSATIONS_COLLECTION, conversationId, MESSAGES_SUBCOLLECTION);
}

export async function fetchConversation(conversationId: string): Promise<Conversation | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(conversationRef(conversationId));
  return snapshot.exists() ? (snapshot.data() as Conversation) : null;
}

/** Newest-first, explicitly limited, one-shot read — no realtime listener. */
export async function fetchConversations(uid: string, limitCount = DEFAULT_CONVERSATIONS_LIMIT): Promise<Conversation[]> {
  if (!firestore) return [];
  const conversationsQuery = query(
    collection(firestore, CONVERSATIONS_COLLECTION),
    where('participantUids', 'array-contains', uid),
    orderBy('lastMessageAt', 'desc'),
    limit(limitCount)
  );
  const snapshot = await getDocs(conversationsQuery);
  return snapshot.docs.map((docSnapshot) => docSnapshot.data() as Conversation);
}

function toChronological(messages: Message[]): Message[] {
  return [...messages].reverse();
}

/** Latest DEFAULT_MESSAGES_LIMIT messages, oldest-first for chat UI — one-shot, no pagination yet. */
export async function fetchMessages(conversationId: string, limitCount = DEFAULT_MESSAGES_LIMIT): Promise<Message[]> {
  if (!firestore) return [];
  const messagesQuery = query(messagesCollection(conversationId), orderBy('createdAt', 'desc'), limit(limitCount));
  const snapshot = await getDocs(messagesQuery);
  return toChronological(snapshot.docs.map((docSnapshot) => docSnapshot.data() as Message));
}

/**
 * The one realtime listener in this app — scoped to a single
 * conversation's latest messages, mounted only while a Chat screen is
 * open. Fires immediately with the current snapshot (acting as the
 * initial load) and again on every subsequent change. Caller MUST call
 * the returned unsubscribe function on unmount.
 */
export function subscribeToMessages(
  conversationId: string,
  onChange: (messages: Message[]) => void,
  limitCount = DEFAULT_MESSAGES_LIMIT
): Unsubscribe {
  if (!firestore) return () => {};
  const messagesQuery = query(messagesCollection(conversationId), orderBy('createdAt', 'desc'), limit(limitCount));
  return onSnapshot(messagesQuery, (snapshot) => {
    onChange(toChronological(snapshot.docs.map((docSnapshot) => docSnapshot.data() as Message)));
  });
}

export type SendMessageError = 'not-configured' | 'invalid-input' | 'no-profile' | 'unknown';
export type SendMessageResult = { ok: true; conversationId: string } | { ok: false; error: SendMessageError; message: string };

/**
 * Sends a message, creating the Conversation on the first send if it
 * doesn't exist yet. Always atomic (runTransaction): the Message document
 * and the Conversation's lastMessage/unreadCounts fields land together or
 * not at all — see firestore.rules, which independently re-validates that
 * pairing on every create/update.
 */
export async function sendMessage(currentUid: string, targetUid: string, rawBody: string): Promise<SendMessageResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  if (currentUid === targetUid) {
    return { ok: false, error: 'invalid-input', message: "You can't message yourself." };
  }
  const body = rawBody.trim();
  if (body.length === 0) {
    return { ok: false, error: 'invalid-input', message: 'Message cannot be empty.' };
  }
  if (body.length > MESSAGE_BODY_MAX_LENGTH) {
    return { ok: false, error: 'invalid-input', message: 'Message is too long.' };
  }

  const targetProfile = await fetchPublicProfile(targetUid);
  if (!targetProfile) {
    return { ok: false, error: 'no-profile', message: "This user isn't available to message." };
  }

  const conversationId = getConversationId(currentUid, targetUid);
  const convRef = conversationRef(conversationId);
  const newMessageRef = doc(messagesCollection(conversationId));

  try {
    await runTransaction(firestore, async (tx) => {
      const convSnapshot = await tx.get(convRef);

      tx.set(newMessageRef, {
        messageId: newMessageRef.id,
        senderUid: currentUid,
        body,
        createdAt: serverTimestamp(),
      } satisfies WithFieldValue<Message>);

      if (!convSnapshot.exists()) {
        const [uidLow, uidHigh] = sortedPair(currentUid, targetUid);
        tx.set(convRef, {
          conversationId,
          participantUids: [uidLow, uidHigh],
          lastMessageId: newMessageRef.id,
          lastMessageText: body,
          lastMessageSenderUid: currentUid,
          lastMessageAt: serverTimestamp(),
          unreadCounts: { [currentUid]: 0, [targetUid]: 1 },
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        } satisfies WithFieldValue<Conversation>);
      } else {
        const existing = convSnapshot.data() as Conversation;
        const otherUid = otherParticipantUid(existing, currentUid);
        tx.update(convRef, {
          lastMessageId: newMessageRef.id,
          lastMessageText: body,
          lastMessageSenderUid: currentUid,
          lastMessageAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
          [`unreadCounts.${currentUid}`]: 0,
          [`unreadCounts.${otherUid}`]: (existing.unreadCounts[otherUid] ?? 0) + 1,
        });
      }
    });
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't send that message." };
  }
  return { ok: true, conversationId };
}

/**
 * Resets the caller's own unread count to 0 — reads first so an
 * already-zero count never triggers an unnecessary write. This matters
 * specifically because the Chat screen re-calls this on every incoming
 * realtime message (see src/app/(app)/chat/[uid].tsx): without the guard,
 * every new message while Chat is open would cost a second write on top
 * of the sender's own.
 */
export async function markConversationRead(conversationId: string, uid: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!firestore) return { ok: false, message: 'Firestore is not available.' };
  try {
    const snapshot = await getDoc(conversationRef(conversationId));
    if (!snapshot.exists()) {
      // No conversation yet (e.g. opening Chat before the first message) — nothing to mark.
      return { ok: true };
    }
    const conversation = snapshot.data() as Conversation;
    if ((conversation.unreadCounts[uid] ?? 0) === 0) {
      return { ok: true };
    }
    await updateDoc(conversationRef(conversationId), { [`unreadCounts.${uid}`]: 0 });
  } catch {
    return { ok: false, message: "Couldn't update this conversation." };
  }
  return { ok: true };
}
