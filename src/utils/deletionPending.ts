/**
 * Local, per-uid marker for an in-progress account deletion — NOT a
 * security boundary (the backend still derives everything from
 * request.auth.uid). Its only job is UX/routing: if the app is closed or
 * crashes between reauthentication and the final Firebase Auth deletion,
 * the deleting user's users/{uid} document may already be gone while their
 * Auth session still exists. Without this marker, RootNavigator would read
 * that as "needs onboarding" and route them there instead of into a
 * deletion-recovery flow — see src/app/_layout.tsx.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

function keyForUid(uid: string): string {
  return `aroundme.deletionPending.${uid}`;
}

export async function setDeletionPending(uid: string): Promise<void> {
  await AsyncStorage.setItem(keyForUid(uid), '1');
}

export async function clearDeletionPending(uid: string): Promise<void> {
  await AsyncStorage.removeItem(keyForUid(uid));
}

export async function isDeletionPending(uid: string): Promise<boolean> {
  const value = await AsyncStorage.getItem(keyForUid(uid));
  return value === '1';
}
