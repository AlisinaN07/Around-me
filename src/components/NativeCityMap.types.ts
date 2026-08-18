import type { Place } from '@/types/place';
import type { MapCamera } from '@/utils/mapCamera';

/**
 * Shared, platform-agnostic prop/handle contract for NativeCityMap — kept
 * in its own file so NativeCityMap.web.tsx and .android.tsx never need to
 * import anything from NativeCityMap.ios.tsx (which imports `expo-maps`,
 * a native-only package that must never be pulled into a web or Android
 * bundle).
 */
export type NativeCityMapHandle = {
  /** Imperative camera move — used by the "My location" control, which centers on a coordinate that isn't a Place. */
  centerOn: (coordinates: { latitude: number; longitude: number }, zoom?: number) => void;
};

export type NativeCityMapProps = {
  /** Already filtered by search/category — the SAME list rendered below the map (see MapPlaceExplorer/PlaceList). */
  places: Place[];
  selectedPlaceId?: string | null;
  onSelectPlace?: (placeId: string) => void;
  /** Computed once from the loaded city Places (src/utils/mapCamera.ts) — never from user GPS. */
  initialCamera: MapCamera | null;
};
