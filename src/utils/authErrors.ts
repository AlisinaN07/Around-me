import { FirebaseError } from 'firebase/app';

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  'auth/invalid-email': 'Invalid email address.',
  'auth/email-already-in-use': 'Email already registered.',
  'auth/weak-password': 'Password is too weak.',
  // Newer projects merge wrong-password/user-not-found into invalid-credential
  // to avoid revealing which part of a login attempt was wrong.
  'auth/invalid-credential': 'Incorrect email or password.',
  'auth/wrong-password': 'Incorrect email or password.',
  'auth/user-not-found': 'Incorrect email or password.',
  'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
  'auth/network-request-failed': 'Network problem. Check your connection and try again.',
};

/** Maps a Firebase Auth error to a friendly, user-facing message. Never surfaces raw error codes. */
export function getAuthErrorMessage(error: unknown): string {
  if (error instanceof FirebaseError) {
    return AUTH_ERROR_MESSAGES[error.code] ?? 'Something went wrong.';
  }
  return 'Something went wrong.';
}
