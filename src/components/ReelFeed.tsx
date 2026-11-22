import * as Clipboard from 'expo-clipboard';
import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ErrorState } from '@/components/ErrorState';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ReelFeedItem } from '@/components/ReelFeedItem';
import { ReportModal } from '@/components/ReportModal';
import { SwipeBackEdge } from '@/components/SwipeBackEdge';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useReelNetworkClass } from '@/hooks/useReelNetworkClass';
import { blockUser } from '@/services/blocks';
import { trackContentInteraction } from '@/services/recommendations/interactions';
import { deleteMyReel, resolveReelThumbnailUrl, resolveReelVideoPlaybackUrl } from '@/services/reels';
import { isPostReposted, repostPost, undoRepost } from '@/services/reposts';
import { prefetchImageOnce } from '@/utils/imagePrefetch';
import {
  computeReelPreparationLevel,
  isWithinWarmWindow,
  shouldWarmThumbnailAndUrl,
} from '@/utils/reelPreparationPolicy';
import { buildReelShareUrl } from '@/utils/reelShare';
import type { Reel } from '@/types/reel';
import type { RankingAttribution } from '@/types/recommendation';

type LoadStatus = 'loading' | 'loaded' | 'error';

const VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 90 };

type ReelFeedProps = {
  reels: Reel[];
  /** Recommendation Engine — Step 6 — DEVELOPMENT/analytics-only per-reelId ranking metadata (Step 18/19), keyed by reelId. Omitted entirely by callers whose reels aren't ranked by this engine at all (Following mode, the standalone /reels route, a single-Reel detail view) — ReelFeedItem's own tracking calls simply omit attribution in that case, same as before this feature existed. */
  attributionByReelId?: Record<string, RankingAttribution>;
  /** Paired with attributionByReelId — omitted by the same non-ranked callers. */
  feedSessionId?: string;
  status: LoadStatus;
  errorTitle: string;
  emptyState: ReactNode;
  /** Called both to retry after an error and to refresh after a successful block. */
  onReload: () => void;
  /** Absolutely-positioned content over a subtle top scrim — city selector, tabs, filter, back button, etc. */
  topOverlay?: ReactNode;
  /**
   * Called instead of onReload right after a successful self-delete, only
   * when provided — Home/`/reels` don't pass this (removing the deleted
   * item from their own list via the normal onReload refetch is enough),
   * but a single-Reel detail view (src/app/(app)/reel/[reelId].tsx) has
   * nothing left to reload once its one Reel is gone, so it uses this to
   * navigate away instead.
   */
  onReelDeleted?: (reelId: string) => void;
  /**
   * Which index of the FIRST populated `reels` list to start scrolled to
   * and playing — Home/`/reels` never pass this (they always start at the
   * top). The single-Reel detail view passes the tapped Reel's position
   * within its author's own Post list, so opening one Post from a Profile
   * grid lands exactly there, with the rest of that profile's Posts
   * swipeable above/below it, same as this component's usual paging.
   * Applied only once, the first time `reels` becomes non-empty — a
   * LATER reels change (a block/reload) resets to the top as usual, same
   * as when this prop isn't provided at all.
   */
  initialIndex?: number;
  /**
   * Same handler `topOverlay`'s own back button calls (usually
   * `() => router.back()`) — when provided, a rightward swipe from the left
   * edge does the same thing (see SwipeBackEdge). Home doesn't pass this
   * (it has no back button — it's a root tab), so the gesture simply
   * doesn't exist there; `/reels` and the single-Reel detail view both do.
   */
  onSwipeBack?: () => void;
  /**
   * Called when the viewer scrolls near the end of the loaded list — the
   * caller's own cue to fetch and append the next page (Step 19's
   * pagination). Optional: Home's "For You" mode is the only caller that
   * passes this today; every other caller (Following, `/reels`, the
   * single-Reel detail view) still fetches one bounded page and never
   * appends more, same as before this existed.
   */
  onEndReached?: () => void;
};

/**
 * Shared vertical Reel feed (Step 25) — the one real implementation behind
 * both Home ("For You"/"Following") and the standalone `/reels` route, so
 * paging, playback, preload, and the options/report/block/share flow never
 * drift into two copies. Callers own data-fetching (city vs. following
 * scope) and pass the resulting `reels`/`status`; everything about
 * rendering and interacting with them lives here.
 */
export function ReelFeed({
  reels,
  attributionByReelId,
  feedSessionId,
  status,
  errorTitle,
  emptyState,
  onReload,
  topOverlay,
  onReelDeleted,
  initialIndex,
  onSwipeBack,
  onEndReached,
}: ReelFeedProps) {
  const { user } = useAuth();
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(initialIndex ?? 0);
  // Guards initialIndex so it's ever honored exactly once (the first time
  // `reels` populates) — see the prop's own doc comment.
  const hasAppliedInitialIndexRef = useRef(false);
  // Home and the standalone /reels screen are both persistent tab
  // screens — Expo Router keeps them mounted (just hidden) when the user
  // switches to a different tab, so scroll-position-based `activeIndex`
  // alone never changes when that happens. Without this, whichever Reel
  // was playing keeps playing — silently while it had no audio, now
  // audibly for a Reel with music merged in — in a tab the user can no
  // longer see. Folded into `isActive` below rather than a separate prop,
  // so ReelFeedItem's own play/pause effect needs no change at all.
  const isScreenFocused = useIsFocused();

  // Step 11D.1 — the one real network-state subscription for this whole
  // feed screen (see useReelNetworkClass's own doc comment for why it
  // lives here and not per-item). Starts at the same conservative
  // 'unknown'/cellular-equivalent default Step 11D always used, and
  // updates live as the device's actual connection changes.
  const networkClass = useReelNetworkClass();

  const [optionsReel, setOptionsReel] = useState<Reel | null>(null);
  const [isOptionsReelReposted, setIsOptionsReelReposted] = useState(false);
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
  // and nothing would ever report itself as active. The very first time
  // reels populates with a real initialIndex pending, that's honored
  // instead (see the prop's own doc comment) — every later reels change
  // still resets to the top as before.
  useEffect(() => {
    if (!hasAppliedInitialIndexRef.current && initialIndex != null && reels.length > 0) {
      hasAppliedInitialIndexRef.current = true;
      setActiveIndex(Math.min(Math.max(initialIndex, 0), reels.length - 1));
      return;
    }
    setActiveIndex(0);
  }, [reels, initialIndex]);

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVisible = viewableItems.find((item) => item.isViewable);
    if (firstVisible && typeof firstVisible.index === 'number') {
      setActiveIndex(firstVisible.index);
    }
  }, []);

  // Step 11D — LIGHT-tier warmup: thumbnail + playback-URL only, NEVER a
  // real video player and NEVER video bytes — see
  // src/utils/reelPreparationPolicy.ts for the full level/network-class
  // design this replaces the pre-11D, forward-only (`activeIndex + 2`
  // literal), thumbnail-only version with. `computeReelPreparationLevel`
  // is what now decides exactly which indices qualify, so this never
  // touches the ACTIVE/WARM range (shouldPrepare below) — avoiding the
  // original effect's own documented race (two concurrent
  // getDownloadURL calls for the same key) by construction, not by a
  // hand-picked offset. `maxReach` only bounds how far this loop SCANS;
  // the real per-network reach is whatever shouldWarmThumbnailAndUrl/
  // computeReelPreparationLevel actually decide for each index — scanning
  // a couple of extra, immediately-'cold' indices beyond the current
  // network class's own reach costs nothing (no fetch happens for a
  // 'cold' result).
  //
  // Step 11D.1 — `networkClass` is now the LIVE detected value (see
  // useReelNetworkClass above), not a hardcoded constant, so this effect
  // is also in the dependency array: a wifi->cellular transition shrinks
  // which indices qualify (next run simply finds fewer 'light' results —
  // nothing already resolved is evicted, see this step's own report for
  // why that's an acceptable, non-"sticky/growing" trade), and a
  // cellular->wifi transition immediately makes further indices eligible
  // for the SAME existing cache-backed resolvers, deduping exactly as it
  // already did before this step for repeat calls on an unchanged index.
  useEffect(() => {
    const maxReach = 3; // the widest LIGHT reach any network class uses today (wifi) — see LIGHT_WINDOW_BY_NETWORK.
    for (let offset = -maxReach; offset <= maxReach; offset += 1) {
      if (offset === 0) continue;
      const index = activeIndex + offset;
      const reel = reels[index];
      if (!reel || reel.mediaType === 'photo') continue;
      const level = computeReelPreparationLevel({ index, activeIndex, networkClass });
      if (!shouldWarmThumbnailAndUrl(level)) continue;
      // Step 9A cleanup — this was still calling resolveReelPlaybackUrl
      // directly against thumbnailStoragePath (a Step 5E gap this file was
      // missed for) — resolveReelThumbnailUrl is the provider-aware
      // version every other thumbnail call site already uses.
      resolveReelThumbnailUrl(reel).then((url) => {
        if (url) prefetchImageOnce(url);
      });
      // Step 11D — new: also warms the PLAYBACK URL itself (not just the
      // thumbnail), so the eventual transition into the WARM window
      // (when the user actually scrolls this far) starts from an
      // already-resolved URL instead of a fresh one. A complete no-op
      // for an R2 Reel (its URL is already persisted — see
      // resolveReelVideoPlaybackUrl's own doc comment, no network call
      // happens at all) and a cheap, cached-after-first-call Storage
      // metadata read for a Firebase Reel — never a video byte download.
      // Fire-and-forget like every other prefetch call in this file: the
      // result populates reels.ts's own playbackUrlCache as a side
      // effect, nothing here needs to read it back.
      resolveReelVideoPlaybackUrl(reel);
    }
  }, [reels, activeIndex, networkClass]);

  // Impression/watch-behavior tracking used to live here as a dwell-time
  // approximation across the whole list (keyed on activeIndex) — replaced
  // by REAL per-item, player-position-based tracking owned by
  // ReelFeedItem itself (Step 1, second pass: it has direct access to the
  // video player's own reported position/duration, which this list-level
  // component never did). 'not_interested' (below) is the one
  // recommendation signal that still belongs here, since it's driven by
  // this component's own options menu.

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

  // Save moved out of this menu into its own always-visible action-rail
  // icon per item (ReelFeedItem owns its own Saved state/toggle now) — see
  // that component for the equivalent "reflect current state" effect.
  //
  // Same reflect-current-state pattern as Save used to follow, independently —
  // Repost is public (Step 41.2F), Saved is private (Step 41.2E); neither
  // reads or writes the other's state.
  useEffect(() => {
    let cancelled = false;
    if (!optionsReel || !user || optionsReel.authorUid === user.uid) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsOptionsReelReposted(false);
      return;
    }
    isPostReposted(user.uid, 'reel', optionsReel.reelId).then((reposted) => {
      if (!cancelled) setIsOptionsReelReposted(reposted);
    });
    return () => {
      cancelled = true;
    };
  }, [optionsReel, user]);

  const handleToggleRepost = useCallback(
    async (reel: Reel) => {
      if (!user) return;
      const wasReposted = isOptionsReelReposted;
      const result = wasReposted
        ? await undoRepost(user.uid, 'reel', reel.reelId)
        : await repostPost(user.uid, 'reel', reel.reelId, reel.authorUid);
      if (!result.ok) {
        showToast(result.message);
        return;
      }
      setIsOptionsReelReposted(!wasReposted);
      showToast(wasReposted ? 'Undid repost' : 'Reposted');
    },
    [user, isOptionsReelReposted, showToast]
  );

  const handleCopyLink = useCallback(
    async (reel: Reel) => {
      await Clipboard.setStringAsync(buildReelShareUrl(reel.reelId));
      showToast('Link copied');
    },
    [showToast]
  );

  // The recommendation engine's one negative, explicit signal (Step 2/13
  // — "deprioritize content the user already marked not interested").
  // Fire-and-forget, same as every other tracking call in this file — see
  // trackContentInteraction's own doc comment. Never shown on the
  // viewer's own Reel (own-content branch below has no use for it).
  const handleNotInterested = useCallback(
    (reel: Reel) => {
      if (!user) return;
      trackContentInteraction({
        userId: user.uid,
        contentId: reel.reelId,
        contentType: 'reel',
        action: 'not_interested',
        categoryId: reel.categoryId,
        creatorId: reel.authorUid,
        cityKey: reel.cityKey,
        countryCode: reel.countryCode,
        hashtags: reel.hashtags,
        attribution: attributionByReelId?.[reel.reelId],
        feedSessionId,
      }).catch(() => {});
      showToast("We'll show you less like this");
    },
    [user, showToast, attributionByReelId, feedSessionId]
  );

  // Share moved out of this menu into its own always-visible action-rail
  // icon per item (ReelFeedItem owns the share/copy-link-fallback flow
  // now) — "Copy link" stays here as a separate, explicit menu action.
  const optionsMenuOptions: OptionsMenuOption[] = optionsReel
    ? optionsReel.authorUid === user?.uid
      ? [
          { label: 'Copy link', onPress: () => handleCopyLink(optionsReel) },
          { label: 'Delete post', onPress: () => setDeleteTarget(optionsReel), destructive: true },
        ]
      : [
          { label: 'Not interested', onPress: () => handleNotInterested(optionsReel) },
          { label: isOptionsReelReposted ? 'Undo repost' : 'Repost', onPress: () => handleToggleRepost(optionsReel) },
          { label: 'Copy link', onPress: () => handleCopyLink(optionsReel) },
          { label: 'Report post', onPress: () => setReportReel(optionsReel) },
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
  // list — no separate local-state removal path needed. A caller that
  // passed onReelDeleted (the single-Reel detail view — see this prop's
  // own doc comment) gets that instead, since there's nothing left here
  // for it to reload.
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
    const deletedReelId = deleteTarget.reelId;
    setDeleteTarget(null);
    if (onReelDeleted) onReelDeleted(deletedReelId);
    else onReload();
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      {/* Same handler topOverlay's own back button calls, when provided
          (Home doesn't pass onSwipeBack, so this simply isn't rendered
          there). */}
      {onSwipeBack ? <SwipeBackEdge onBack={onSwipeBack} /> : null}
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
            // Only meaningful on this first real mount (reels is already
            // the full loaded list by the time this FlatList exists at
            // all — see the containerHeight/reels.length gating above) —
            // matches activeIndex's own initial state so the right item is
            // both scrolled-to and marked active/playing from the start,
            // not just scrolled-to.
            initialScrollIndex={initialIndex != null ? Math.min(Math.max(initialIndex, 0), reels.length - 1) : undefined}
            renderItem={({ item, index }) => {
              // Step 11D — byte-identical to the pre-11D
              // `Math.abs(index - activeIndex) <= 1` for every network
              // class (WARM_WINDOW is still 1 unconditionally — see
              // reelPreparationPolicy.ts's own doc comment for why); now
              // computed through the shared policy function instead of an
              // inline literal, so this and the LIGHT-tier effect above
              // can never silently drift apart. Step 11D.1: driven by the
              // live `networkClass` instead of a hardcoded constant.
              // Step 11E — computed once per item per render and passed
              // down as `preparationLevel` too (dev-measurement context
              // only — see ReelFeedItem's own doc comment for that prop;
              // `shouldPrepare` below remains the only thing that affects
              // real player/URL behavior, unchanged).
              const preparationLevel = computeReelPreparationLevel({ index, activeIndex, networkClass });
              return (
                <ReelFeedItem
                  reel={item}
                  height={containerHeight}
                  isActive={index === activeIndex && isScreenFocused}
                  shouldPrepare={isWithinWarmWindow(preparationLevel)}
                  preparationLevel={preparationLevel}
                  networkClass={networkClass}
                  onOpenOptions={() => setOptionsReel(item)}
                  onToast={showToast}
                  attribution={attributionByReelId?.[item.reelId]}
                  feedSessionId={feedSessionId}
                />
              );
            }}
            pagingEnabled
            showsVerticalScrollIndicator={false}
            decelerationRate="fast"
            snapToInterval={containerHeight}
            snapToAlignment="start"
            getItemLayout={(_, index) => ({ length: containerHeight, offset: containerHeight * index, index })}
            viewabilityConfig={VIEWABILITY_CONFIG}
            onViewableItemsChanged={onViewableItemsChanged}
            onEndReached={onEndReached}
            onEndReachedThreshold={1.5}
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
        title="Delete post?"
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
