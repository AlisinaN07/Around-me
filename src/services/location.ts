/**
 * One-time foreground city lookup — no background location, no tracking.
 * Coordinates only ever exist as local variables here; nothing persists them.
 */

import * as Location from 'expo-location';

export type DetectedCity = { cityName: string; countryCode: string };

export type DetectCityResult =
  | { ok: true; city: DetectedCity }
  | { ok: false; reason: 'permission-denied' | 'unavailable' | 'no-result' | 'unknown'; message: string };

export async function detectCurrentCity(): Promise<DetectCityResult> {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      return { ok: false, reason: 'permission-denied', message: 'Location permission was not granted.' };
    }

    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      return { ok: false, reason: 'unavailable', message: 'Location services are turned off.' };
    }

    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const [place] = await Location.reverseGeocodeAsync({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
    });

    const cityName = place?.city ?? place?.subregion ?? place?.district ?? undefined;
    const countryCode = place?.isoCountryCode ?? undefined;

    if (!cityName || !countryCode) {
      return { ok: false, reason: 'no-result', message: 'Could not determine your city from your location.' };
    }

    return { ok: true, city: { cityName, countryCode: countryCode.toUpperCase() } };
  } catch {
    return { ok: false, reason: 'unknown', message: 'Something went wrong finding your location.' };
  }
}
