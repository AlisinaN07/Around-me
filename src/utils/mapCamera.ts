import type { Place } from '@/types/place';

export type MapCamera = {
  latitude: number;
  longitude: number;
  zoom: number;
};

/**
 * A sensible initial camera for a set of Places — average/central
 * coordinate, with a zoom level derived from how spread out they are.
 * Never depends on user GPS: this is purely a function of the Place data
 * already loaded for the city. Returns null for an empty list so callers
 * can render a safe empty state instead of a map centered on (0, 0).
 */
export function computeInitialCamera(places: Place[]): MapCamera | null {
  if (places.length === 0) {
    return null;
  }

  if (places.length === 1) {
    return { latitude: places[0].latitude, longitude: places[0].longitude, zoom: 15 };
  }

  let minLat = places[0].latitude;
  let maxLat = places[0].latitude;
  let minLng = places[0].longitude;
  let maxLng = places[0].longitude;
  let sumLat = 0;
  let sumLng = 0;

  for (const place of places) {
    minLat = Math.min(minLat, place.latitude);
    maxLat = Math.max(maxLat, place.latitude);
    minLng = Math.min(minLng, place.longitude);
    maxLng = Math.max(maxLng, place.longitude);
    sumLat += place.latitude;
    sumLng += place.longitude;
  }

  const span = Math.max(maxLat - minLat, maxLng - minLng);
  // A rough, deliberately simple bounding-box-to-zoom heuristic — good
  // enough for "frame the city," not a precise fit-to-bounds algorithm.
  let zoom = 15;
  if (span > 1) zoom = 7;
  else if (span > 0.2) zoom = 9;
  else if (span > 0.05) zoom = 11;
  else if (span > 0.01) zoom = 13;
  else if (span > 0.002) zoom = 14;

  return {
    latitude: sumLat / places.length,
    longitude: sumLng / places.length,
    zoom,
  };
}
