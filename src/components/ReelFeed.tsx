import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ErrorState } from '@/components/ErrorState';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ReelFeedItem } from '@/components/ReelFeedItem';
import { ReportModal } from '@/components/ReportModal';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { blockUser } from '@/services/blocks';
import { deleteMyReel } from '@/services/reels';
import { buildReelShareUrl, shareReel } from '@/utils/reelShare';
import type { Reel } from '@/types/reel';

type LoadStatus = 'loading' | 'loaded' | 'error';

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 90 };

type ReelFeedProps = {
  reels: Reel[];
  status: LoadStatus;
  errorTitle: string;
  emptyState: ReactNode;
  /** Called both to retry after an error and to refresh after a successful block. */
  onReload: () => void;
  /** Absolutely-positioned content over a subtle top scrim — city selector, tabs, filter, back button, etc. */
  topOverlay?: ReactNode;
};

/**
 * Shared vertical Reel feed (Step 25) — the one real implementation behind
 * both Home ("For You"/"Following") and the standalone `/reels` route, so
 * paging, playback, preload, and the options/report/block/share flow never
 * drift into two copies. Callers own data-fetching (city vs. following
 * scope) and pass the resulting `reels`/`status`; everything about
 * rendering and interacting with them lives here.
 */
export function ReelFeed({ reels, status, errorTitle, emptyState, onReload, topOverlay }: ReelFeedProps) {
  const { user } = useAuth();
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(0);

  const [optionsReel, setOptionsReel] = useState<Reel | null>(null);
  const [reportReel, setReportReel] = useState<Reel | null>(null);
  const [blockTarget, setBlockTarget] = useState<Reel | null>(null);
  const [isBlockSubmitting, setIsBlockSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Reel | null>(null);
  const [isDeleteSubmitting, setIsDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resets paging to the top whenever the underlying list is swapped out
  // for a different one (city switch, tab switch between For You/
  // Following) — otherwise activeIndex could point past the new list's end
  // and nothing would ever report itself as active.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex(0);
  }, [reels]);

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVisible = viewableItems.find((item) => item.isViewable);
    if (firstVisible && typeof firstVisible.index === 'number') {
      setActiveIndex(firstVisible.index);
    }
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const handleCopyLink = useCallback(
    async (reel: Reel) => {
      await Clipboard.setStringAsync(buildReelShareUrl(reel.reelId));
      showToast('Link copied');
    },
    [showToast]
  );

  const handleShare = useCallback(
    async (reel: Reel) => {
      const result = await shareReel(reel.reelId);
      if (!result.ok && !/cancel/i.test(result.message)) {
        await handleCopyLink(reel);
      }
    },
    [handleCopyLink]
  );

  const optionsMenuOptions: OptionsMenuOption[] = optionsReel
    ? optionsReel.authorUid === user?.uid
      ? [
          { label: 'Share Reel', onPress: () => handleShare(optionsReel) },
          { label: 'Copy link', onPress: () => handleCopyLink(optionsReel) },
          { label: 'Delete Reel', onPress: () => setDeleteTarget(optionsReel), destructive: true },
        ]
      : [
          { label: 'Share Reel', onPress: () => handleShare(optionsReel) },
          { label: 'Copy link', onPress: () => handleCopyLink(optionsReel) },
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
      onReload();
    }
  };

  // Permanent — no recycle bin, no restore (locked Step 40.1 policy).
  // Reusing the same onReload() the feed already calls after a successful
  // block is the smallest way to make a deleted Reel disappear from this
  // list — no separate local-state removal path needed.
  const handleConfirmDelete = async () => {
    if (!deleteTarget || isDeleteSubmitting) return;
    setIsDeleteSubmitting(true);
    setDeleteError(null);
    const result = await deleteMyReel(deleteTarget.reelId);
    setIsDeleteSubmitting(false);
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }
    setDeleteTarget(null);
    onReload();
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
            <ActivityIndicator color={Colors.textSecondary} />
          </View>
        ) : status === 'error' ? (
          <View style={styles.centered}>
            <ErrorState bare title={errorTitle} onRetry={onReload} />
          </View>
        ) : reels.length === 0 ? (
          <View style={styles.centered}>{emptyState}</View>
        ) : containerHeight > 0 ? (
          <FlatList
            data={reels}
            keyExtractor={(item) => item.reelId}
            renderItem={({ item, index }) => (
              <ReelFeedItem
                reel={item}
                height={containerHeight}
                isActive={index === activeIndex}
                shouldPrepare={Math.abs(index - activeIndex) <= 1}
                onOpenOptions={() => setOptionsReel(item)}
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
            // Conservative preload strategy (see ReelFeedItem's
            // shouldPrepare prop): only the active item plus one neighbor
            // on each side ever resolve a playback URL or hold a real
            // video player — everything else stays released. windowSize=3
            // keeps FlatList's own render window matched to that same
            // active-neighbor range, so distant items aren't even mounted,
            // let alone holding buffered video.
            windowSize={3}
            maxToRenderPerBatch={2}
          />
        ) : null}

        {topOverlay ? (
          <LinearGradient
            colors={['rgba(10, 10, 13, 0.85)', 'rgba(10, 10, 13, 0)']}
            style={styles.topOverlay}
            pointerEvents="box-none"
          >
            {topOverlay}
          </LinearGradient>
        ) : null}
      </View>

      {toastMessage ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}

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

      <ConfirmDialog
        visible={!!deleteTarget}
        title="Delete reel?"
        message={deleteError ?? "This can't be undone."}
        confirmLabel="Delete"
        isSubmitting={isDeleteSubmitting}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
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
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.lg,
    paddingHorizontal: Spacing.md,
  },
  toast: {
    position: 'absolute',
    bottom: Spacing.xxl * 2,
    alignSelf: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.9)',
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  toastText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
});
