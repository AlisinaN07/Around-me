/**
 * Firestore instance — initialized from the existing Firebase App.
 */

import { type Firestore, getFirestore, initializeFirestore } from 'firebase/firestore';

import { firebaseApp } from './firebase';

let firestore: Firestore | undefined;

if (firebaseApp) {
  try {
    firestore = initializeFirestore(firebaseApp, {
      // React Native's fetch/streaming stack doesn't reliably support
      // Firestore's default transport; auto-detect falls back to long
      // polling only when the streaming transport actually fails.
      experimentalAutoDetectLongPolling: true,
    });
  } catch {
    // initializeFirestore throws if already called for this app (e.g. Fast Refresh) —
    // fall back to the existing instance instead of creating a new one.
    firestore = getFirestore(firebaseApp);
  }
} else if (__DEV__) {
  console.warn('[firestore] Firebase app is not initialized — check EXPO_PUBLIC_FIREBASE_* env vars.');
}

/** The initialized Firestore instance, or undefined if the Firebase app isn't configured. */
export { firestore };
