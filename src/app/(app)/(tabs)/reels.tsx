import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ReelFeedItem } from '@/components/ReelFeedItem';
import { ReportModal } from '@/components/ReportModal';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { blockUser, fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchCityReels } from '@/services/reels';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import type { Reel } from '@/types/reel';

type LoadStatus = 'loading' | 'loaded' | 'error';

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 90 };

export default function ReelsScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [reels, setReels] = useState<Reel[]>([]);
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const [optionsReel, setOptionsReel] = useState<Reel | null>(null);
  const [reportReel, setReportReel] = useState<Reel | null>(null);
  const [blockTarget, setBlockTarget] = useState<Reel | null>(null);
  const [isBlockSubmitting, setIsBlockSubmitting] = useState(false);

  const cityKey = profile?.cityKey;
  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : 'your city';

  const load = useCallback(async () => {
    if (!cityKey || !user) return;
    setStatus('loading');
    try {
      const [cityReels, blockedUids] = await Promise.all([fetchCityReels(cityKey), fetchMyBlockedUserIds(user.uid)]);
      const blockedSet = new Set(blockedUids);
      // Client-side only — see the Step 17/18 MVP block boundary: this
      // hides a blocked author's Reels from the feed, it does not make
      // their published media cryptographically unreadable.
      setReels(blockedSet.size > 0 ? cityReels.filter((reel) => !blockedSet.has(reel.authorUid)) : cityReels);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [cityKey, user]);

  useFocusEffect(
    useCallback(() => {
      setActiveIndex(0);
      load();
    }, [load])
  );

  // setActiveIndex is stable across renders, so this callback never needs
  // to change — no ref needed to keep FlatList's onViewableItemsChanged
  // reference stable (mutating a ref during render, which the old
  // `useRef(fn).current` pattern effectively did here, isn't allowed).
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVisible = viewableItems.find((item) => item.isViewable);
    if (firstVisible && typeof firstVisible.index === 'number') {
      setActiveIndex(firstVisible.index);
    }
  }, []);

  const handleOpenOptions = (reel: Reel) => setOptionsReel(reel);

  const optionsMenuOptions: OptionsMenuOption[] = optionsReel
    ? [
        { label: 'Report reel', onPress: () => setReportReel(optionsReel) },
        { label: `Block ${optionsReel.authorDisplayName}`, onPress: () => setBlockTarget(optionsReel), destructive: true },
      ]
    : [];

  const handleConfirmBlock = async () => {
    if (!blockTarget || !user || isBlockSubmitting) return;
    setIsBlockSubmitting(true);
    const result = await blockUser(user.uid, blockTarget.authorUid);
    setIsBlockSubmitting(false);
    setBlockTarget(null);
    if (result.ok) {
      load();
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View
        style={styles.content}
        onLayout={(event) => {
          const { height } = event.nativeEvent.layout;
          if (height > 0 && height !== containerHeight) {
            setContainerHeight(height);
          }
        }}
      >
        {status === 'loading' && reels.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="play-circle-outline" size={48} color={Colors.textSecondary} />
          </View>
        ) : status === 'error' ? (
          <View style={styles.centered}>
            <Ionicons name="cloud-offline-outline" size={40} color={Colors.textSecondary} />
            <Text style={styles.emptyTitle}>Couldn&apos;t load Reels</Text>
            <Button label="Try again" onPress={load} />
          </View>
        ) : reels.length === 0 ? (
          <View style={styles.centered}>
            <Ionicons name="videocam-outline" size={48} color={Colors.textSecondary} />
            <Text style={styles.emptyTitle}>No Reels yet</Text>
            <Text style={styles.emptyBody}>Be the first to show what&apos;s happening in {cityLabel}.</Text>
            <Button label="Create Reel" onPress={() => router.push('/create/reel')} />
          </View>
        ) : containerHeight > 0 ? (
          <FlatList
            data={reels}
            keyExtractor={(item) => item.reelId}
            renderItem={({ item, index }) => (
              <ReelFeedItem
                reel={item}
                height={containerHeight}
                isActive={index === activeIndex}
                isOwnReel={item.authorUid === user?.uid}
                onOpenOptions={() => handleOpenOptions(item)}
              />
            )}
            pagingEnabled
            showsVerticalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={containerHeight}
            snapToAlignment="start"
            getItemLayout={(_, index) => ({ length: containerHeight, offset: containerHeight * index, index })}
            viewabilityConfig={VIEWABILITY_CONFIG}
            onViewableItemsChanged={onViewableItemsChanged}
            // Only a handful of Reels are ever in this list (see
            // fetchCityReels's explicit limit) — no windowing tuning
            // beyond React Native's own list defaults is needed.
          />
        ) : null}
      </View>

      <OptionsMenu visible={!!optionsReel} onClose={() => setOptionsReel(null)} options={optionsMenuOptions} />

      {reportReel && user && (
        <ReportModal
          visible={!!reportReel}
          onClose={() => setReportReel(null)}
          reporterUid={user.uid}
          target={{ type: 'reel', reelId: reportReel.reelId }}
        />
      )}

      <ConfirmDialog
        visible={!!blockTarget}
        title={blockTarget ? `Block ${blockTarget.authorDisplayName}?` : ''}
        message="They won't be able to follow, like or comment on your content, or message you while blocked."
        confirmLabel="Block"
        isSubmitting={isBlockSubmitting}
        onConfirm={handleConfirmBlock}
        onCancel={() => setBlockTarget(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
  emptyTitle: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyBody: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.sm,
  },
});
