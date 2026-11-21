import {
  createUserWithEmailAndPassword,
  deleteUser,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { auth } from '@/services/auth';
import { clearPushTokenSessionTracking, syncPushTokenForAuthenticatedSession } from '@/services/pushTokens';
import { getAuthErrorMessage } from '@/utils/authErrors';

type AuthContextValue = {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  signUp: (email: string, password: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Step 33 — deliberately throws the raw Firebase error (not wrapped into
   * a friendly message here) so the Forgot Password screen can special-
   * case `auth/user-not-found` for enumeration safety (Section 29) — every
   * other caller keeps using getAuthErrorMessage() the normal way.
   */
  resetPassword: (email: string) => Promise<void>;
  /**
   * Step 34.3 — required immediately before account deletion. Throws the
   * raw Firebase error (not wrapped) so the Delete Account screen can
   * distinguish a wrong password from a network problem and react
   * differently to each; never logs or persists the password itself.
   */
  reauthenticateWithPassword: (password: string) => Promise<void>;
  /**
   * Step 34.3 — deletes the Firebase Auth user itself. Must only ever be
   * called AFTER the trusted backend (deleteMyAccountData) has already
   * completed and immediately after a successful reauthentication, so
   * Firebase's "recent login" requirement is satisfied — see
   * src/components/DeleteAccountFlow.tsx for the enforced ordering.
   */
  deleteCurrentUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  // True only while we're actually waiting on Firebase to report the
  // restored (or absent) session; if there's no auth instance there's
  // nothing to wait for, so start already resolved.
  const [isLoading, setIsLoading] = useState(() => auth !== undefined);

  useEffect(() => {
    if (!auth) {
      return;
    }

    return onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      setIsLoading(false);
      // Step 3C/3E — resolves a logout's own interrupted push-token
      // cleanup, then silently registers this device IF AND ONLY IF OS
      // notification permission was ALREADY granted (e.g. via the
      // Settings screen in an earlier session) — NEVER shows a
      // permission prompt here, see
      // syncPushTokenForAuthenticatedSession's own doc comment
      // (src/services/pushTokens.ts) for the full behavior, including
      // the stale-registration-after-quick-logout race this guards
      // against. A no-op for the overwhelming majority of sessions
      // (nothing pending, permission never granted, or the token
      // hasn't changed), in which case this is one cheap AsyncStorage
      // read plus one Firestore read and nothing else.
      if (firebaseUser) {
        syncPushTokenForAuthenticatedSession(firebaseUser.uid).catch(() => {});
      } else {
        clearPushTokenSessionTracking();
      }
    });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isLoading,
      isAuthenticated: user !== null,
      signUp: async (email, password) => {
        if (!auth) {
          throw new Error('Firebase Auth is not available.');
        }
        try {
          await createUserWithEmailAndPassword(auth, email, password);
        } catch (error) {
          throw new Error(getAuthErrorMessage(error));
        }
      },
      signIn: async (email, password) => {
        if (!auth) {
          throw new Error('Firebase Auth is not available.');
        }
        try {
          await signInWithEmailAndPassword(auth, email, password);
        } catch (error) {
          throw new Error(getAuthErrorMessage(error));
        }
      },
      signOut: async () => {
        if (!auth) {
          return;
        }
        await firebaseSignOut(auth);
      },
      resetPassword: async (email) => {
        if (!auth) {
          throw new Error('Firebase Auth is not available.');
        }
        await sendPasswordResetEmail(auth, email);
      },
      reauthenticateWithPassword: async (password) => {
        if (!auth || !auth.currentUser || !auth.currentUser.email) {
          throw new Error('No authenticated user with an email is available.');
        }
        const credential = EmailAuthProvider.credential(auth.currentUser.email, password);
        await reauthenticateWithCredential(auth.currentUser, credential);
      },
      deleteCurrentUser: async () => {
        if (!auth || !auth.currentUser) {
          throw new Error('No authenticated user is available.');
        }
        await deleteUser(auth.currentUser);
      },
    }),
    [user, isLoading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuthContext(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within an AuthProvider');
  }
  return context;
}
