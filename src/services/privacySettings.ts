/**
 * Message privacy — privacySettings/{uid}. Controls who may START a new
 * DM conversation with this user; it never affects an existing
 * conversation (only a Block does — see src/services/blocks.ts). UI code
 * should only ever import from here, never talk to Firestore directly.
 */

import { doc, getDoc, serverTimestamp, setDoc, updateDoc, type WithFieldValue } from 'firebase/firestore';

import { DEFAULT_NEW_MESSAGES_FROM, type NewMessagesFrom, type PrivacySettings } from '@/types/privacy';

import { firestore } from './firestore';

const PRIVACY_SETTINGS_COLLECTION = 'privacySettings';

function privacySettingsRef(uid: string) {
  return doc(firestore!, PRIVACY_SETTINGS_COLLECTION, uid);
}

export async function fetchPrivacySettings(uid: string): Promise<PrivacySettings | null> {
  if (!firestore) return null;
  const snapshot = await getDoc(privacySettingsRef(uid));
  return snapshot.exists() ? (snapshot.data() as PrivacySettings) : null;
}

/** No privacySettings/{uid} doc means "everyone" — the backward-compatible default for every account created before this setting existed. */
export async function fetchMyNewMessagesFrom(uid: string): Promise<NewMessagesFrom> {
  const settings = await fetchPrivacySettings(uid);
  return settings?.newMessagesFrom ?? DEFAULT_NEW_MESSAGES_FROM;
}

export type PrivacySettingsActionResult = { ok: true } | { ok: false; error: 'not-configured' | 'unknown'; message: string };

/** Creates privacySettings/{uid} on the first change away from the default, updates it thereafter. */
export async function setNewMessagesFrom(uid: string, value: NewMessagesFrom): Promise<PrivacySettingsActionResult> {
  if (!firestore) return { ok: false, error: 'not-configured', message: 'Firestore is not available.' };
  try {
    const ref = privacySettingsRef(uid);
    const existing = await getDoc(ref);
    if (existing.exists()) {
      await updateDoc(ref, { newMessagesFrom: value, updatedAt: serverTimestamp() });
    } else {
      await setDoc(ref, {
        uid,
        newMessagesFrom: value,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      } satisfies WithFieldValue<PrivacySettings>);
    }
  } catch {
    return { ok: false, error: 'unknown', message: "Couldn't update your message privacy." };
  }
  return { ok: true };
}
