import { forwardRef } from 'react';

import type { NativeCityMapHandle, NativeCityMapProps } from './NativeCityMap.types';

/**
 * Default/Android stub. Android intentionally has no native map yet (Step
 * 14 is iOS-first — Google Maps API keys/credentials are a deliberate
 * later step); the Map tab renders the Step 13 Place explorer/list on
 * Android instead of this component, so this is not expected to actually
 * render. It exists so `@/components/NativeCityMap` resolves both for
 * TypeScript (which needs a non-suffixed base file to resolve a bare
 * import) and for Metro on any platform without its own override — see
 * NativeCityMap.ios.tsx (the real map) and NativeCityMap.web.tsx.
 */
export const NativeCityMap = forwardRef<NativeCityMapHandle, NativeCityMapProps>(function NativeCityMap() {
  return null;
});
