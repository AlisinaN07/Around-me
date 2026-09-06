import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ReelFeed } from '@/components/ReelFeed';
import { Colors, Typography } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useCity } from '@/providers/CityProvider';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchCityReels } from '@/services/reels';
import type { Reel } from '@/types/reel';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Standalone Reel feed route (Step 25) — kept for direct navigation/
 * compatibility (e.g. Home's "Local Reels" See all link) after Home itself
 * became the primary Reel-first surface. Uses the exact same ReelFeed
 * component Home does, just with a back+city header instead of Home's
 * city+For You/Following+filter header — no divergent feed implementation.
 */
export default function ReelsScreen() {
  const { user } = useAuth();
  const { activeCity, homeCity, isExploringAnotherCity, isReady: isCityReady } = useCity();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [reels, setReels] = useState<Reel[]>([]);

  const cityLabel = activeCity?.cityName ?? 'your city';

  const load = useCallback(async () => {
    if (!activeCity || !user) return;
    setStatus('loading');
    setReels([]);
    try {
      const [cityReels, blockedUids] = await Promise.all([fetchCityReels(activeCity.cityKey), fetchMyBlockedUserIds(user.uid)]);
      const blockedSet = new Set(blockedUids);
      setReels(blockedSet.size > 0 ? cityReels.filter((reel) => !blockedSet.has(reel.authorUid)) : cityReels);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [activeCity, user]);

  useFocusEffect(
    useCallback(() => {
      if (!isCityReady) return;
      load();
    }, [load, isCityReady])
  );

  return (
    <ReelFeed
      reels={reels}
      status={status}
      errorTitle={`Couldn't load posts in ${cityLabel}`}
      onReload={load}
      topOverlay={
        <View style={styles.backRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={22} color={Colors.text} />
          </Pressable>
          <Pressable onPress={() => router.push('/cities')} style={styles.cityButton} accessibilityRole="button" accessibilityLabel="Change city">
            <Text style={styles.cityButtonText}>{cityLabel}</Text>
            <Ionicons name="chevron-down" size={16} color={Colors.text} />
          </Pressable>
        </View>
      }
      emptyState={
        <EmptyState
          bare
          icon="videocam-outline"
          title="No posts yet"
          body={`Be the first to show what's happening in ${cityLabel}.`}
          action={
            <>
              <Button label="Create post" onPress={() => router.push('/create/reel')} />
              {isExploringAnotherCity && homeCity ? (
                <Text style={styles.exploringHint}>Posts you create publish to your home city, {homeCity.cityName}.</Text>
              ) : null}
            </>
          }
        />
      }
    />
  );
}

const styles = StyleSheet.create({
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cityButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  cityButtonText: {
    color: Colors.text,
    ...Typography.cardTitle,
  },
  exploringHint: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
});
