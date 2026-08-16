import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type OnboardingDraft = {
  displayName: string;
  username: string;
  cityName: string;
  countryCode: string;
  interests: string[];
};

const EMPTY_DRAFT: OnboardingDraft = {
  displayName: '',
  username: '',
  cityName: '',
  countryCode: '',
  interests: [],
};

type OnboardingDraftContextValue = {
  draft: OnboardingDraft;
  setNameAndUsername: (displayName: string, username: string) => void;
  setCity: (cityName: string, countryCode: string) => void;
  setInterests: (interests: string[]) => void;
};

const OnboardingDraftContext = createContext<OnboardingDraftContextValue | undefined>(undefined);

/**
 * In-memory-only draft for the 3 onboarding screens. Intentionally not
 * persisted — if the app is killed mid-onboarding, the draft restarts.
 * Scoped to the (onboarding) group's layout, so it resets whenever a user
 * enters onboarding fresh.
 */
export function OnboardingDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<OnboardingDraft>(EMPTY_DRAFT);

  const value = useMemo<OnboardingDraftContextValue>(
    () => ({
      draft,
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
