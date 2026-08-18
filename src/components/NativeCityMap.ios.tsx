import { AppleMaps } from 'expo-maps';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';

import { Colors } from '@/constants/theme';

import type { NativeCityMapHandle, NativeCityMapProps } from './NativeCityMap.types';

/**
 * Real Apple Map for iOS (Step 14). Never fetches Firestore itself — see
 * the Step 13 boundary preserved in MapPlaceExplorer/useCityPlaces; this
 * component only ever converts an already-loaded, already-filtered
 * Place[] into map markers.
 *
 * Marker taps (`onMarkerClick`) are iOS 18.0+ only per the installed
 * expo-maps typings, so selection is driven by the `selectedPlaceId` prop
 * (settable by tapping a Place card, which works on every supported iOS
 * version) rather than requiring marker taps to work at all. Marker taps
 * are wired as a progressive enhancement on top of the same prop.
 */
export const NativeCityMap = forwardRef<NativeCityMapHandle, NativeCityMapProps>(function NativeCityMap(
  { places, selectedPlaceId, onSelectPlace, initialCamera },
  ref
) {
  const mapRef = useRef<AppleMaps.MapView>(null);

  useImperativeHandle(
    ref,
    () => ({
      centerOn: (coordinates, zoom = 15) => {
        mapRef.current?.setCameraPosition({ coordinates, zoom });
      },
    }),
    []
  );

  const markers = useMemo<AppleMaps.Marker[]>(
    () =>
      places.map((place) => ({
        id: place.placeId,
        coordinates: { latitude: place.latitude, longitude: place.longitude },
        title: place.name,
        tintColor: Colors.accent,
      })),
    [places]
  );

  // Selection is driven entirely by the controlled `selectedPlaceId` prop —
  // whether it came from a marker tap (18+) or a Place card tap (every
  // version) makes no difference here. `selectMarker` gives the native
  // highlight/callout as a best-effort touch on 18+ (a silent no-op
  // before that); `setCameraPosition` is what reliably centers the map on
  // every supported iOS version, so core navigation never depends on the
  // 18+-only API.
  useEffect(() => {
    mapRef.current?.selectMarker(selectedPlaceId ?? undefined, { moveCamera: false });
    if (!selectedPlaceId) return;
    const place = places.find((item) => item.placeId === selectedPlaceId);
    if (place) {
      mapRef.current?.setCameraPosition({ coordinates: { latitude: place.latitude, longitude: place.longitude }, zoom: 15 });
    }
  }, [selectedPlaceId, places]);

  if (!initialCamera) {
    return null;
  }

  return (
    <AppleMaps.View
      ref={mapRef}
      style={StyleSheet.absoluteFill}
      cameraPosition={{
        coordinates: { latitude: initialCamera.latitude, longitude: initialCamera.longitude },
        zoom: initialCamera.zoom,
      }}
      colorScheme={AppleMaps.MapColorScheme.DARK}
      markers={markers}
      uiSettings={{
        compassEnabled: true,
        scaleBarEnabled: true,
        myLocationButtonEnabled: false,
        togglePitchEnabled: false,
      }}
      properties={{
        // The app's own "My location" control (src/services/location.ts)
        // owns the one-time, explicit-tap location flow — never Apple's
        // own always-on blue dot, which would run outside that flow.
        isMyLocationEnabled: false,
        selectionEnabled: true,
      }}
      onMarkerClick={(marker) => {
        if (marker.id && onSelectPlace) {
          onSelectPlace(marker.id);
        }
      }}
    />
  );
});
