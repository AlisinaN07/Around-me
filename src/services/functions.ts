/**
 * Firebase Cloud Functions client — initialized from the existing Firebase
 * App, same pattern as ./auth.ts and ./firestore.ts. Must target
 * europe-north1: that's the only region the deployed callables (see
 * functions/src/index.ts) actually live in — the SDK default region
 * (us-central1) would 404 against this project's functions.
 */

import { type Functions, getFunctions } from 'firebase/functions';

import { firebaseApp } from './firebase';

const FUNCTIONS_REGION = 'europe-north1';

let functions: Functions | undefined;

if (firebaseApp) {
  functions = getFunctions(firebaseApp, FUNCTIONS_REGION);
} else if (__DEV__) {
  console.warn('[functions] Firebase app is not initialized — check EXPO_PUBLIC_FIREBASE_* env vars.');
}

/** The initialized Cloud Functions client (europe-north1), or undefined if the Firebase app isn't configured. */
export { functions };
