/**
 * A one-shot, non-per-uid flag: "the account that was just signed in here
 * was deleted." Set immediately before the final Firebase Auth deletion
 * call, so it survives the session-ending re-render that throws the user
 * back into the (auth) stack. Login reads and clears it once on mount to
 * show a neutral confirmation — see src/app/(auth)/login.tsx.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'aroundme.accountJustDeleted';

export async function setPostDeletionNotice(): Promise<void> {
  await AsyncStorage.setItem(KEY, '1');
}

/** Reads and clears the flag in one call — the notice only ever shows once. */
export async function consumePostDeletionNotice(): Promise<boolean> {
  const value = await AsyncStorage.getItem(KEY);
  if (value === '1') {
    await AsyncStorage.removeItem(KEY);
    return true;
  }
  return false;
}
