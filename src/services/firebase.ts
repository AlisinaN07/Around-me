/**
 * Firebase App initialization only — no Auth, Firestore, Storage, etc. yet.
 * Config comes from EXPO_PUBLIC_FIREBASE_* env vars (see .env.example).
 */

import { type FirebaseApp, type FirebaseOptions, getApp, getApps, initializeApp } from 'firebase/app';

const ENV_TO_CONFIG_KEY = {
  EXPO_PUBLIC_FIREBASE_API_KEY: 'apiKey',
  EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: 'authDomain',
  EXPO_PUBLIC_FIREBASE_PROJECT_ID: 'projectId',
  EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: 'storageBucket',
  EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: 'messagingSenderId',
  EXPO_PUBLIC_FIREBASE_APP_ID: 'appId',
} as const;

type FirebaseEnvKey = keyof typeof ENV_TO_CONFIG_KEY;

const missingFirebaseEnvKeys = (Object.keys(ENV_TO_CONFIG_KEY) as FirebaseEnvKey[]).filter(
  (envKey) => !process.env[envKey]
);

let firebaseApp: FirebaseApp | undefined;

if (missingFirebaseEnvKeys.length === 0) {
  const config = Object.fromEntries(
    (Object.keys(ENV_TO_CONFIG_KEY) as FirebaseEnvKey[]).map((envKey) => [
      ENV_TO_CONFIG_KEY[envKey],
      process.env[envKey],
    ])
  ) as FirebaseOptions;

  try {
    // getApps() guard avoids re-initializing on Fast Refresh.
    firebaseApp = getApps().length > 0 ? getApp() : initializeApp(config);
  } catch (error) {
    if (__DEV__) {
      console.error('[firebase] Initialization failed:', error);
    }
  }
} else if (__DEV__) {
  console.warn(
    `[firebase] Not initialized — missing env var(s): ${missingFirebaseEnvKeys.join(', ')}. ` +
      'Copy .env.example to .env.local and fill in your Firebase web app config.'
  );
}

/** True only when the Firebase app actually initialized successfully. */
export const isFirebaseConfigured = firebaseApp !== undefined;

/** The initialized Firebase app, or undefined if config is missing/invalid. */
export { firebaseApp };
