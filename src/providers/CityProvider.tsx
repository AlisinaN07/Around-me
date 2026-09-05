/**
 * City Context (Step 21) — the single source for which city Around/
 * Following/Reels/Happening Now currently show.
 *
 * Two distinct concepts:
 * - **Home City** — the user's permanent social identity, derived read-only
 *   from their completed profile (`users/{uid}.cityKey`/`cityName`/
 *   `countryCode`). This context never writes to that profile; browsing
 *   another city never touches `users/{uid}` or `publicProfiles/{uid}`.
 * - **Active City** — a temporary, local-only browsing context. Starts
 *   equal to Home City and can be changed via `setActiveCity` (the city
 *   switcher, see `/cities`). Never sent to Firestore, never affects what
 *   city new content/Reels are authored under — see
 *   src/services/reels.ts/content.ts, which always derive a created
 *   document's city server-side from the caller's own `users/{uid}`
 *   profile regardless of what's being browsed.
 *
 * Persisted **per signed-in uid** (`aroundme.activeCity.{uid}` in
 * AsyncStorage — the same persistence mechanism Firebase Auth itself
 * already uses in this app, see src/services/auth.ts) specifically so a
 * shared device/browser can't leak one account's browsing city into
 * another account's session. A stored value that no longer resolves to a
 * real catalog city (e.g. the catalog changes later) falls back to Home
 * City rather than erroring.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { COUNTRIES } from '@/constants/countries';
import { findCityByKey, type City } from '@/constants/cities';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { formatCityDisplayName } from '@/utils/cityDisplay';

function storageKeyForUid(uid: string): string {
  return `aroundme.activeCity.${uid}`;
}

/** Removes one uid's stored Active City preference — used by account deletion to clean up exactly the deleted user's local state, never anyone else's. */
export async function clearStoredActiveCityForUid(uid: string): Promise<void> {
  await AsyncStorage.removeItem(storageKeyForUid(uid));
}

type CityContextValue = {
  /** The user's permanent profile city, or null before their profile has loaded. */
  homeCity: City | null;
  /** The city discovery surfaces should query — defaults to Home City. */
  activeCity: City | null;
  isExploringAnotherCity: boolean;
  /** True once the stored Active City (if any) has been read — avoids querying with a not-yet-resolved city. */
  isReady: boolean;
  setActiveCity: (city: City) => void;
  resetToHomeCity: () => void;
};

const CityContext = createContext<CityContextValue | undefined>(undefined);

export function CityProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [activeCity, setActiveCityState] = useState<City | null>(null);
  const [isReady, setIsReady] = useState(false);

  const homeCity: City | null = useMemo(() => {
    if (!profile) return null;
    const countryName = COUNTRIES.find((country) => country.code === profile.countryCode)?.name ?? profile.countryCode;
    return {
      cityKey: profile.cityKey,
      // Display-formatted once here so every consumer gets a presentable
      // name without remembering to call formatCityDisplayName itself —
      // catalog cities (Karlstad, Stockholm, ...) are already properly
      // cased and pass through unchanged; this only matters for a Home
      // City that came from onboarding's free-text manual entry.
      cityName: formatCityDisplayName(profile.cityName),
      countryCode: profile.countryCode,
      countryName,
    };
  }, [profile]);

  const uid = user?.uid ?? null;

  // Resolves Active City fresh whenever the signed-in uid or their Home
  // City changes: reads that uid's own stored key (never another
  // account's — see the per-uid key above), and falls back to Home City
  // if nothing is stored or the stored cityKey no longer matches a real
  // catalog city. Guarded by `cancelled` since this is an async read
  // racing against the user signing out/switching again quickly.
  useEffect(() => {
    if (!uid || !homeCity) {
      // Signed out (or profile not loaded yet) — nothing to browse.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveCityState(null);
      setIsReady(!uid);
      return;
    }

    let cancelled = false;
    setIsReady(false);

    AsyncStorage.getItem(storageKeyForUid(uid))
      .then((storedKey) => {
        if (cancelled) return;
        const storedCity = storedKey ? findCityByKey(storedKey) : null;
        setActiveCityState(storedCity ?? homeCity);
        setIsReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveCityState(homeCity);
        setIsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [uid, homeCity]);

  const setActiveCity = useCallback(
    (city: City) => {
      setActiveCityState(city);
      if (uid) {
        AsyncStorage.setItem(storageKeyForUid(uid), city.cityKey).catch(() => {});
      }
    },
    [uid]
  );

  const resetToHomeCity = useCallback(() => {
    if (!homeCity) return;
    setActiveCityState(homeCity);
    if (uid) {
      AsyncStorage.removeItem(storageKeyForUid(uid)).catch(() => {});
    }
  }, [uid, homeCity]);

  const isExploringAnotherCity = !!homeCity && !!activeCity && activeCity.cityKey !== homeCity.cityKey;

  const value = useMemo<CityContextValue>(
    () => ({ homeCity, activeCity, isExploringAnotherCity, isReady, setActiveCity, resetToHomeCity }),
    [homeCity, activeCity, isExploringAnotherCity, isReady, setActiveCity, resetToHomeCity]
  );

  return <CityContext.Provider value={value}>{children}</CityContext.Provider>;
}

export function useCity(): CityContextValue {
  const context = useContext(CityContext);
  if (!context) {
    throw new Error('useCity must be used within a CityProvider');
  }
  return context;
}
