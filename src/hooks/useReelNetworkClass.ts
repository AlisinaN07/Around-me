/**
 * Step 11D.1 — the one real network-state subscription for the whole Reel
 * feed. Lives here, not inside ReelFeedItem, so there is exactly ONE
 * `expo-network` listener per feed screen regardless of how many Reel
 * items are mounted (ReelFeed.tsx's own single call site) — never a
 * per-item subscription.
 *
 * Deliberately thin: all the actual classification logic lives in the
 * pure, independently-tested src/utils/reelNetworkClass.ts. This file's
 * only job is the native boundary — read the initial state without
 * blocking render, subscribe to live changes, and clean up correctly.
 *
 * Starts at reelPreparationPolicy's own `DEFAULT_NETWORK_CLASS`
 * ('unknown') — the same conservative value this app used everywhere
 * before this step — until the real state resolves, so a Reel screen's
 * first render is never blocked on a network read and never assumes a
 * best-case connection. `getNetworkStateAsync()`'s own failure (rejected
 * promise) is swallowed, not thrown: the default stays in place, which is
 * already the safe behavior this app had before this hook existed.
 */
import { useEffect, useRef, useState } from 'react';
import { addNetworkStateListener, getNetworkStateAsync } from 'expo-network';

import { mapExpoNetworkStateToReelNetworkClass } from '@/utils/reelNetworkClass';
import { DEFAULT_NETWORK_CLASS, type ReelNetworkClass } from '@/utils/reelPreparationPolicy';

export function useReelNetworkClass(): ReelNetworkClass {
  const [networkClass, setNetworkClass] = useState<ReelNetworkClass>(DEFAULT_NETWORK_CLASS);
  // Dev-only transition logging needs the LAST class, independent of
  // React's own render timing — a plain ref, never read by anything that
  // affects output, so it can't cause the "stale value inside a
  // rarely-resubscribed effect" bug this file's own sibling
  // (ReelFeedItem.tsx) documents elsewhere for a similar case.
  const lastLoggedClassRef = useRef<ReelNetworkClass>(DEFAULT_NETWORK_CLASS);

  useEffect(() => {
    // Guards BOTH the async initial read resolving after unmount AND a
    // live event that was already in flight the instant cleanup runs —
    // `subscription.remove()` alone only stops FUTURE events.
    let cancelled = false;

    const applyNetworkState = (state: Parameters<typeof mapExpoNetworkStateToReelNetworkClass>[0]) => {
      if (cancelled) return;
      const nextClass = mapExpoNetworkStateToReelNetworkClass(state);
      if (__DEV__ && nextClass !== lastLoggedClassRef.current) {
        // Never logs an IP, SSID, carrier name, or any other network
        // identifier — only the two small enum-like class values.
        // eslint-disable-next-line no-console
        console.log(`[reel-network] ${lastLoggedClassRef.current} -> ${nextClass}`);
      }
      lastLoggedClassRef.current = nextClass;
      setNetworkClass(nextClass);
    };

    getNetworkStateAsync()
      .then(applyNetworkState)
      .catch(() => {
        // Leave DEFAULT_NETWORK_CLASS in place — never throw out of a
        // feed screen just because one network read failed.
      });

    const subscription = addNetworkStateListener(applyNetworkState);

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  return networkClass;
}
