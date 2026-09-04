import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

import type { AccountType } from '@/types/user';

export type OnboardingDraft = {
  /** Chosen on the very first onboarding screen (Step 30) — null until then, and required before continuing past it. */
  accountType: AccountType | null;
  displayName: string;
  username: string;
  cityName: string;
  countryCode: string;
  interests: string[];
};

const EMPTY_DRAFT: OnboardingDraft = {
  accountType: null,
  displayName: '',
  username: '',
  cityName: '',
  countryCode: '',
  interests: [],
};

type OnboardingDraftContextValue = {
  draft: OnboardingDraft;
  setAccountType: (accountType: AccountType) => void;
  setNameAndUsername: (displayName: string, username: string) => void;
  setCity: (cityName: string, countryCode: string) => void;
  setInterests: (interests: string[]) => void;
};

const OnboardingDraftContext = createContext<OnboardingDraftContextValue | undefined>(undefined);

/**
 * In-memory-only draft for the 4 onboarding screens (account type, name/
 * username, city, interests — Step 30 added account type as the new first
 * step). Intentionally not persisted — if the app is killed mid-
 * onboarding, the draft restarts. Scoped to the (onboarding) group's
 * layout, so it resets whenever a user enters onboarding fresh.
 */
export function OnboardingDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);

  const value = useMemo<OnboardingDraftContextValue>(
    () => ({
      draft,
      setAccountType: (accountType) => setDraft((prev) => ({ ...prev, accountType })),
      setNameAndUsername: (displayName, username) => setDraft((prev) => ({ ...prev, displayName, username })),
      setCity: (cityName, countryCode) => setDraft((prev) => ({ ...prev, cityName, countryCode })),
      setInterests: (interests) => setDraft((prev) => ({ ...prev, interests })),
    }),
    [draft]
  );

  return <OnboardingDraftContext.Provider value={value}>{children}</OnboardingDraftContext.Provider>;
}

export function useOnboardingDraft(): OnboardingDraftContextValue {
  const context = useContext(OnboardingDraftContext);
  if (!context) {
    throw new Error('useOnboardingDraft must be used within an OnboardingDraftProvider');
  }
  return context;
}
