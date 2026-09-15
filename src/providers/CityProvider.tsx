/**
 * City/Country/World Context (Step 21, extended) — the single source for
 * how broadly Around/Following/Reels/Happening Now currently browse.
 *
 * Two distinct concepts:
 * - **Home City** — the user's permanent social identity, derived read-only
 *   from their completed profile (`users/{uid}.cityKey`/`cityName`/
 *   `countryCode`). This context never writes to that profile; browsing
 *   another city/country/worldwide never touches `users/{uid}` or
 *   `publicProfiles/{uid}`.
 * - **Active Scope** — a temporary, local-only browsing context: one City,
 *   one whole Country, or Worldwide (see src/types/browseScope.ts). Starts
 *   equal to Home City and can be changed via `setActiveCity`/
 *   `setActiveCountry`/`setActiveWorld` (the City Explorer, see
 *   `/cities`). Never sent to Firestore, never affects what city/country
 *   new content/Reels are authored under — see
 *   src/services/reels.ts/content.ts, which always derive a created
 *   document's city/country server-validated fields from the caller's own
 *   `users/{uid}` profile regardless of what's being browsed.
 *
 * Persisted **per signed-in uid** (`aroundme.activeCity.{uid}` in
 * AsyncStorage — the same persistence mechanism Firebase Auth itself
 * already uses in this app, see src/services/auth.ts) specifically so a
 * shared device/browser can't leak one account's browsing scope into
 * another account's session. The stored value is a small JSON-encoded
 * BrowseScope; a legacy stored value from before Country/World existed
 * (a bare cityKey string) is still read correctly (see parseStoredScope).
 * A stored scope that no longer resolves to anything real (e.g. a city
 * the catalog has since removed) falls back to Home City rather than
 * erroring.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { COUNTRIES, type Country } from '@/constants/countries';
import { findCityByKey, type City } from '@/constants/cities';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import type { BrowseScope } from '@/types/browseScope';
import { formatCityDisplayName } from '@/utils/cityDisplay';

function storageKeyForUid(uid: string): string {
  return `aroundme.activeCity.${uid}`;
}

/** Removes one uid's stored Active Scope preference — used by account deletion to clean up exactly the deleted user's local state, never anyone else's. */
export async function clearStoredActiveCityForUid(uid: string): Promise<void> {
  await AsyncStorage.removeItem(storageKeyForUid(uid));
}

/** Reads a stored preference string as a BrowseScope — a legacy pre-Country/World value is a bare cityKey (e.g. "se:karlstad"), never JSON, so a JSON.parse failure falls back to treating the whole string as one. Returns null for anything that resolves to neither a real scope nor a real catalog city. */
function parseStoredScope(stored: string): BrowseScope | null {
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
      const candidate = parsed as { kind?: unknown; cityKey?: unknown; cityKeys?: unknown; countryCode?: unknown };
      if (candidate.kind === 'world') return { kind: 'world' };
      if (candidate.kind === 'country' && typeof candidate.countryCode === 'string') {
        return { kind: 'country', countryCode: candidate.countryCode };
      }
      if (candidate.kind === 'city' && typeof candidate.cityKey === 'string') {
        return findCityByKey(candidate.cityKey) ? { kind: 'city', cityKey: candidate.cityKey } : null;
      }
      if (candidate.kind === 'cities' && Array.isArray(candidate.cityKeys)) {
        const validKeys = candidate.cityKeys.filter((key): key is string => typeof key === 'string' && !!findCityByKey(key));
        return validKeys.length > 0 ? { kind: 'cities', cityKeys: validKeys } : null;
      }
    }
    return null;
  } catch {
    // Legacy format — a bare cityKey string, not JSON.
    return findCityByKey(stored) ? { kind: 'city', cityKey: stored } : null;
  }
}

function scopeToStorageValue(scope: BrowseScope): string {
  return JSON.stringify(scope);
}

type CityContextValue = {
  /** The user's permanent profile city, or null before their profile has loaded. */
  homeCity: City | null;
  /** How discovery surfaces should currently query — defaults to Home City. */
  activeScope: BrowseScope;
  /** A single display-ready label for the active scope: a city name, a country name, or "Worldwide". */
  activeScopeLabel: string;
  /** True whenever the active scope isn't exactly Home City (a browsed city, a country, or worldwide). */
  isExploringElsewhere: boolean;
  /** True once the stored Active Scope (if any) has been read — avoids querying with a not-yet-resolved scope. */
  isReady: boolean;
  setActiveCity: (city: City) => void;
  /** Several hand-picked cities at once (see the drill-down screen at /cities/[countryCode]) — never an empty array; pass a single city via setActiveCity instead. */
  setActiveCities: (cityKeys: string[]) => void;
  setActiveCountry: (country: Country) => void;
  setActiveWorld: () => void;
  resetToHomeCity: () => void;
};

const CityContext = createContext<CityContextValue | undefined>(undefined);

export function CityProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [activeScope, setActiveScopeState] = useState<BrowseScope | null>(null);
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

  // Resolves Active Scope fresh whenever the signed-in uid or their Home
  // City changes: reads that uid's own stored value (never another
  // account's — see the per-uid key above), and falls back to Home City
  // if nothing is stored or the stored value no longer resolves. Guarded
  // by `cancelled` since this is an async read racing against the user
  // signing out/switching again quickly.
  useEffect(() => {
    if (!uid || !homeCity) {
      // Signed out (or profile not loaded yet) — nothing to browse.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveScopeState(null);
      setIsReady(!uid);
      return;
    }

    let cancelled = false;
    setIsReady(false);

    AsyncStorage.getItem(storageKeyForUid(uid))
      .then((stored) => {
        if (cancelled) return;
        const storedScope = stored ? parseStoredScope(stored) : null;
        setActiveScopeState(storedScope ?? { kind: 'city', cityKey: homeCity.cityKey });
        setIsReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setActiveScopeState({ kind: 'city', cityKey: homeCity.cityKey });
        setIsReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [uid, homeCity]);

  const persistScope = useCallback(
    (scope: BrowseScope) => {
      setActiveScopeState(scope);
      if (uid) {
        AsyncStorage.setItem(storageKeyForUid(uid), scopeToStorageValue(scope)).catch(() => {});
      }
    },
    [uid]
  );

  const setActiveCity = useCallback((city: City) => persistScope({ kind: 'city', cityKey: city.cityKey }), [persistScope]);
  const setActiveCities = useCallback(
    (cityKeys: string[]) => {
      if (cityKeys.length === 0) return;
      // A single city collapses to plain 'city' scope — same shape
      // setActiveCity itself would have produced, so activeScopeLabel/
      // isExploringElsewhere never need to special-case a one-element array.
      persistScope(cityKeys.length === 1 ? { kind: 'city', cityKey: cityKeys[0] } : { kind: 'cities', cityKeys });
    },
    [persistScope]
  );
  const setActiveCountry = useCallback((country: Country) => persistScope({ kind: 'country', countryCode: country.code }), [persistScope]);
  const setActiveWorld = useCallback(() => persistScope({ kind: 'world' }), [persistScope]);

  const resetToHomeCity = useCallback(() => {
    if (!homeCity) return;
    setActiveScopeState({ kind: 'city', cityKey: homeCity.cityKey });
    if (uid) {
      AsyncStorage.removeItem(storageKeyForUid(uid)).catch(() => {});
    }
  }, [uid, homeCity]);

  const resolvedScope: BrowseScope = activeScope ?? { kind: 'city', cityKey: homeCity?.cityKey ?? '' };

  const activeScopeLabel = useMemo(() => {
    if (resolvedScope.kind === 'world') return 'Worldwide';
    if (resolvedScope.kind === 'country') {
      return COUNTRIES.find((country) => country.code === resolvedScope.countryCode)?.name ?? resolvedScope.countryCode;
    }
    if (resolvedScope.kind === 'cities') {
      const names = resolvedScope.cityKeys.map((key) => findCityByKey(key)?.cityName).filter((name): name is string => !!name);
      if (names.length === 0) return 'your cities';
      // Always "First +N" once there's more than one — never both names
      // joined, even for exactly two, since that can run long enough to
      // crowd the header (city names aren't length-bounded).
      if (names.length === 1) return names[0];
      return `${names[0]} +${names.length - 1}`;
    }
    if (resolvedScope.cityKey === homeCity?.cityKey) return homeCity.cityName;
    return findCityByKey(resolvedScope.cityKey)?.cityName ?? 'your city';
  }, [resolvedScope, homeCity]);

  const isExploringElsewhere = resolvedScope.kind !== 'city' || resolvedScope.cityKey !== homeCity?.cityKey;

  const value = useMemo<CityContextValue>(
    () => ({
      homeCity,
      activeScope: resolvedScope,
      activeScopeLabel,
      isExploringElsewhere,
      isReady,
      setActiveCity,
      setActiveCities,
      setActiveCountry,
      setActiveWorld,
      resetToHomeCity,
    }),
    [
      homeCity,
      resolvedScope,
      activeScopeLabel,
      isExploringElsewhere,
      isReady,
      setActiveCity,
      setActiveCities,
      setActiveCountry,
      setActiveWorld,
      resetToHomeCity,
    ]
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
