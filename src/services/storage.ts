/**
 * Firebase Storage instance — initialized from the existing Firebase App
 * (see ./firebase.ts). No second app instance, no separate credentials.
 */

import { type FirebaseStorage, getStorage } from 'firebase/storage';

import { firebaseApp } from './firebase';

let storage: FirebaseStorage | undefined;

if (firebaseApp) {
  try {
    storage = getStorage(firebaseApp);
  } catch (error) {
    if (__DEV__) {
      console.error('[storage] Initialization failed:', error);
    }
  }
} else if (__DEV__) {
  console.warn('[storage] Firebase app is not initialized — check EXPO_PUBLIC_FIREBASE_* env vars.');
}

/** The initialized Storage instance, or undefined if the Firebase app isn't configured. */
export { storage };
