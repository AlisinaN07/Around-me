import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { auth } from '@/services/auth';
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
