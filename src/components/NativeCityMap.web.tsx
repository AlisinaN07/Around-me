import { forwardRef } from 'react';

import type { NativeCityMapHandle, NativeCityMapProps } from './NativeCityMap.types';

/**
 * Web never renders a native map (see the Map tab, which shows the Step 13
 * Place explorer/list on web instead) and must never import `expo-maps` —
 * that package is native-only and would break web bundling. This stub
 * exists only so `@/components/NativeCityMap` resolves cleanly for every
 * platform Metro bundles; it is not expected to actually be rendered.
 */
export const NativeCityMap = forwardRef<NativeCityMapHandle, NativeCityMapProps>(function NativeCityMap() {
  return null;
});
