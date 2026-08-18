import type { Timestamp } from 'firebase/firestore';

export const MESSAGE_BODY_MAX_LENGTH = 1000;

/**
 * conversations/{conversationId} — a private 1:1 direct-message thread
 * between exactly two users (see src/services/messages.ts). conversationId
 * is the canonical `{lowerUid}_{higherUid}` pairing (lexicographic string
 * ordering, the same ordering Firestore Rules apply to strings), which is
 * what guarantees at most one conversation per user pair no matter who
 * starts it — enforced independently by Firestore rules, not just client
 * convention.
 *
 * lastMessage* fields are a private snapshot for the Inbox conversation
 * list, so it never has to query every conversation's Messages
 * subcollection just to render a preview. Visible only to the two
 * participants — see firestore.rules.
 *
 * Never store email/GPS/password/full copied user profiles here.
 */
export type Conversation = {
  conversationId: string;
  participantUids: [string, string];
  lastMessageId: string;
  lastMessageText: string;
  lastMessageSenderUid: string;
  lastMessageAt: Timestamp;
  unreadCounts: Record<string, number>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};

/**
 * conversations/{conversationId}/messages/{messageId} — text-only, create
 * + read only (no edit/delete in Step 16). Always created atomically with
 * a Conversation create/update — see sendMessage in src/services/messages.ts.
 */
export type Message = {
  messageId: string;
  senderUid: string;
  body: string;
  createdAt: Timestamp;
};
