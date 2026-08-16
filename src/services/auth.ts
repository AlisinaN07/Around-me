/**
 * Firebase Auth instance — persisted across app restarts via AsyncStorage.
 * Uses the same Firebase App exported from ./firebase (never creates another).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { type Auth, getAuth, getReactNativePersistence, initializeAuth } from 'firebase/auth';

import { firebaseApp } from './firebase';

let auth: Auth | undefined;

if (firebaseApp) {
  try {
    auth = initializeAuth(firebaseApp, {
      persistence: getReactNativePersistence(AsyncStorage),
    });
  } catch {
    // initializeAuth throws if already called for this app (e.g. Fast Refresh) —
    // fall back to the existing instance instead of creating a new one.
    auth = getAuth(firebaseApp);
  }
} else if (__DEV__) {
  console.warn('[auth] Firebase app is not initialized — check EXPO_PUBLIC_FIREBASE_* env vars.');
}

/** The initialized Firebase Auth instance, or undefined if the Firebase app isn't configured. */
export { auth };
