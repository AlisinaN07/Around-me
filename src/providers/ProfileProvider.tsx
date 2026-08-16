import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useAuth } from '@/hooks/useAuth';
import { fetchUserProfile } from '@/services/userProfile';
import type { UserProfile } from '@/types/user';

type ProfileResult = {
  /** The uid this profile/error corresponds to, or null if signed out. */
  uid: string | null;
  profile: UserProfile | null;
  error: string | null;
};

type ProfileContextValue = {
  profile: UserProfile | null;
  isProfileLoading: boolean;
  profileError: string | null;
  hasCompletedOnboarding: boolean;
  refreshProfile: () => Promise<void>;
};

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [result, setResult] = useState<ProfileResult>({ uid: null, profile: null, error: null });

  // No synchronous setState here — the async fetch below only ever sets
  // state after its first `await`, so calling this from an effect never
  // triggers a setState-during-effect-body render.
  const loadProfile = useCallback(async (uid: string) => {
    try {
      const profile = await fetchUserProfile(uid);
      setResult({ uid, profile, error: null });
    } catch (error) {
      setResult({ uid, profile: null, error: error instanceof Error ? error.message : 'Could not load your profile.' });
    }
  }, []);

  useEffect(() => {
    if (!user) {
      // Nothing to load — the render-time uid comparison below already
      // yields null profile/error for a signed-out user, even if `result`
      // still holds a previous session's stale data.
      return;
    }
    // loadProfile awaits before its first setState call, so nothing runs
    // synchronously during this effect's execution — but the lint rule
    // can't see past the function reference to confirm that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadProfile(user.uid);
  }, [user, loadProfile]);

  const refreshProfile = useCallback(async () => {
    if (!user) return;
    await loadProfile(user.uid);
  }, [user, loadProfile]);

  const currentUid = user?.uid ?? null;
  // If we don't yet have a resolved result for the *current* uid, we're
  // still loading — computed on every render so there's no one-tick gap
  // between the uid changing and this reflecting it.
  const isProfileLoading = currentUid !== null && result.uid !== currentUid;
  const profile = result.uid === currentUid ? result.profile : null;
  const profileError = result.uid === currentUid ? result.error : null;

  const value = useMemo<ProfileContextValue>(
    () => ({
      profile,
      isProfileLoading,
      profileError,
      hasCompletedOnboarding: profile?.onboardingCompleted === true,
      refreshProfile,
    }),
    [profile, isProfileLoading, profileError, refreshProfile]
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

export function useProfileContext(): ProfileContextValue {
  const context = useContext(ProfileContext);
  if (!context) {
    throw new Error('useProfileContext must be used within a ProfileProvider');
  }
  return context;
}
