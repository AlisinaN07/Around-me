import type { Timestamp } from 'firebase/firestore';

/**
 * Who may START a new DM conversation with this user. Does NOT affect
 * existing conversations — those can only be stopped by a Block (see
 * src/types/block.ts). See src/services/messages.ts / firestore.rules for
 * where this is enforced (conversation CREATE only, never on a send to an
 * already-existing conversation).
 */
export type NewMessagesFrom = 'everyone' | 'people_i_follow' | 'nobody';

export const NEW_MESSAGES_FROM_OPTIONS: { id: NewMessagesFrom; label: string }[] = [
  { id: 'everyone', label: 'Everyone' },
  { id: 'people_i_follow', label: 'People I follow' },
  { id: 'nobody', label: 'Nobody' },
];

export const DEFAULT_NEW_MESSAGES_FROM: NewMessagesFrom = 'everyone';

/**
 * privacySettings/{uid} — a minimal, public-safe interaction preference,
 * readable by any signed-in user (a sender needs to know whether they may
 * start a conversation). If this document doesn't exist for a uid, treat
 * it as "everyone" — see fetchMyNewMessagesFrom in
 * src/services/privacySettings.ts. The document is only created the first
 * time a user changes the setting away from the default.
 */
export type PrivacySettings = {
  uid: string;
  newMessagesFrom: NewMessagesFrom;
  createdAt: Timestamp;
  updatedAt: Timestamp;
};
