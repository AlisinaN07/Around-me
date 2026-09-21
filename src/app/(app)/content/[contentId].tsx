import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View, type ViewToken } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActivityDetail } from '@/components/ActivityDetail';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DetailHero } from '@/components/DetailHero';
import { ErrorState } from '@/components/ErrorState';
import { EventDetail } from '@/components/EventDetail';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState, SkeletonBlock } from '@/components/LoadingState';
import { OptionsMenu } from '@/components/OptionsMenu';
import { PostDetail } from '@/components/PostDetail';
import { ReportModal } from '@/components/ReportModal';
import { SwipeBackEdge } from '@/components/SwipeBackEdge';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { deleteMyContent, fetchContentById, peekEventFeedHandoff } from '@/services/content';
import { trackContentInteraction } from '@/services/recommendations/interactions';
import { isPostReposted, repostPost, undoRepost } from '@/services/reposts';
import { isPostSaved, savePost, unsavePost } from '@/services/saved';
import type { ActivityContent, Content, EventContent } from '@/types/content';

const EVENT_FEED_VIEWABILITY_CONFIG = { itemVisiblePercentThreshold: 90 };

type LoadStatus = 'loading' | 'loaded' | 'error';

const DELETE_LABEL: Record<Content['type'], string> = {
  post: 'Delete post?',
  activity: 'Delete activity?',
  event: 'Delete event?',
};

/**
 * Swipe-to-next-Event — reads `peekEventFeedHandoff` ONCE per mount (a
 * lazy initializer, not a plain call, so a LATER unrelated handoff write
 * during this screen's own lifetime never retroactively hijacks it) to
 * decide between two completely independent screens: `EventFeedScreen`
 * (a real vertical swipeable feed through the caller's own already-
 * loaded Event list — Profile's own Live/Upcoming/Past Events tabs and
 * the Events tab's own rails, see their own call sites) when one was
 * just handed off AND actually contains the Event being opened, or the
 * existing `SingleContentScreen` (unchanged) for every other entry point
 * (a share link, search result, or any other case that never wrote one).
 * Kept as two separate components rather than one big conditional so
 * neither one's hooks (most importantly SingleContentScreen's own
 * fetchContentById effect) ever run for the branch that isn't taken —
 * the swipeable feed already has its own data in hand and must never
 * duplicate that read.
 */
export default function ContentDetailScreen() {
  const { contentId } = useLocalSearchParams<{ contentId: string }>();
  const [feedEvents] = useState(() => peekEventFeedHandoff());
  const feedIndex = feedEvents?.findIndex((event) => event.contentId === contentId) ?? -1;

  if (feedEvents && feedIndex !== -1) {
    return <EventFeedScreen events={feedEvents} initialIndex={feedIndex} />;
  }
  return <SingleContentScreen />;
}

function SingleContentScreen() {
  const { contentId } = useLocalSearchParams<{ contentId: string }>();
  const { user } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [content, setContent] = useState<Content | null>(null);
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isSaved, setIsSaved] = useState(false);
  const [isReposted, setIsReposted] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    try {
      const result = await fetchContentById(contentId);
      if (!result) {
        setStatus('error');
        return;
      }
      setContent(result);
      // Save/Repost are only ever a legacy text Post concept here — Event
      // and Activity documents never get a Saved/Reposted-state check.
      if (user && result.type === 'post' && result.authorUid !== user.uid) {
        const [saved, reposted] = await Promise.all([
          isPostSaved(user.uid, 'post', result.contentId),
          isPostReposted(user.uid, 'post', result.contentId),
        ]);
        setIsSaved(saved);
        setIsReposted(reposted);
      }
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [contentId, user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Step 2, second pass — `event_open` fires once per loaded Event
  // detail, regardless of entry point (Events discovery, a Place page's
  // "Happening now" rail, a share link, ...) — see EventCard's own
  // default onPress, which already routes here for every variant. Posts/
  // Activities have no equivalent tracked signal (not asked for). Guarded
  // by contentId in the dependency array so refocusing this same screen
  // (useFocusEffect-free here, but a re-render from an unrelated state
  // change is still possible) never double-fires for the same content.
  useEffect(() => {
    if (!user || !content || content.type !== 'event') return;
    trackContentInteraction({
      userId: user.uid,
      contentId: content.contentId,
      contentType: 'content',
      action: 'event_open',
      categoryId: content.categoryId,
      creatorId: content.authorUid,
      cityKey: content.cityKey,
      countryCode: content.countryCode,
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content?.contentId, content?.type, user]);

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

  const handleToggleSave = async () => {
    if (!content || !user) return;
    const wasSaved = isSaved;
    const result = wasSaved ? await unsavePost(user.uid, 'post', content.contentId) : await savePost(user.uid, 'post', content.contentId);
    if (!result.ok) {
      showToast(result.message);
      return;
    }
    setIsSaved(!wasSaved);
    showToast(wasSaved ? 'Removed from saved' : 'Saved');
  };

  const handleToggleRepost = async () => {
    if (!content || !user) return;
    const wasReposted = isReposted;
    const result = wasReposted
      ? await undoRepost(user.uid, 'post', content.contentId)
      : await repostPost(user.uid, 'post', content.contentId, content.authorUid);
    if (!result.ok) {
      showToast(result.message);
      return;
    }
    setIsReposted(!wasReposted);
    showToast(wasReposted ? 'Undid repost' : 'Reposted');
  };

  const isOwnContent = !!user && !!content && content.authorUid === user.uid;
  const canSaveContent = !isOwnContent && content?.type === 'post';

  const optionsMenuOptions = isOwnContent
    ? [{ label: 'Delete', destructive: true, onPress: () => setIsDeleteConfirmOpen(true) }]
    : canSaveContent
      ? [
          { label: isSaved ? 'Remove from saved' : 'Save', onPress: handleToggleSave },
          { label: isReposted ? 'Undo repost' : 'Repost', onPress: handleToggleRepost },
          { label: 'Report', onPress: () => setIsReportOpen(true) },
        ]
      : [{ label: 'Report', onPress: () => setIsReportOpen(true) }];

  // Permanent — no recycle bin, no restore (locked Step 40.1 policy). The
  // backend independently re-verifies content.authorUid == request.auth.uid
  // server-side, so this is never trusted client-side beyond gating which
  // menu option even appears.
  const handleConfirmDelete = async () => {
    if (!content || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    const result = await deleteMyContent(content.contentId);
    setIsDeleting(false);
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }
    setIsDeleteConfirmOpen(false);
    // Prefer returning to wherever the user actually came from (their own
    // Profile, a Place page, Events discovery); a fresh deep link has no
    // back stack, so fall back to a surface that still makes sense for
    // content they authored — Events discovery for a deleted Event,
    // Profile (where their own content always lives) otherwise. Never
    // Home — Posts/Activities/Events never appear there (see Step 25/40).
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace(content.type === 'event' ? '/events' : '/profile');
    }
  };

  // Event/Activity get the Step 29 media-first hero chrome — Back/More
  // are overlaid directly on the hero, not shown in a separate header bar
  // above it, so this branch owns its own SafeAreaView/ScrollView instead
  // of HeaderScreenLayout. Post detail (Step 29 Section 28: not redesigned
  // this step) and the loading/error states — where the content type
  // isn't known yet — keep the original HeaderScreenLayout path, below,
  // completely unchanged in structure.
  if (status === 'loaded' && content && content.type !== 'post') {
    return (
      <>
        <MediaDetailScreen content={content} onOptionsPress={() => setIsOptionsMenuOpen(true)} onToast={showToast} />
        {toastMessage ? (
          <View style={styles.toast} pointerEvents="none">
            <Text style={styles.toastText}>{toastMessage}</Text>
          </View>
        ) : null}
        <OptionsMenu visible={isOptionsMenuOpen} onClose={() => setIsOptionsMenuOpen(false)} options={optionsMenuOptions} />
        {user ? (
          <ReportModal
            visible={isReportOpen}
            onClose={() => setIsReportOpen(false)}
            reporterUid={user.uid}
            target={{ type: 'content', contentId: content.contentId }}
          />
        ) : null}
        <ConfirmDialog
          visible={isDeleteConfirmOpen}
          title={DELETE_LABEL[content.type]}
          message={deleteError ?? "This can't be undone."}
          confirmLabel="Delete"
          isSubmitting={isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setIsDeleteConfirmOpen(false);
            setDeleteError(null);
          }}
        />
      </>
    );
  }

  const title = content?.type === 'activity' ? 'Activity' : content?.type === 'event' ? 'Event' : 'Post';

  return (
    <HeaderScreenLayout
      title={title}
      headerRight={
        status === 'loaded' && content ? (
          <Pressable
            onPress={() => setIsOptionsMenuOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="More options"
            style={styles.overflowButton}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={Colors.textSecondary} />
          </Pressable>
        ) : undefined
      }
    >
      {status === 'loading' ? (
        <View style={styles.loadingShape}>
          <SkeletonBlock width="100%" height={200} />
          <View style={styles.loadingLines}>
            <SkeletonBlock width="70%" height={20} />
            <SkeletonBlock width="45%" height={14} />
          </View>
          <LoadingState />
        </View>
      ) : status === 'error' || !content ? (
        <ErrorState
          title={title === 'Event' ? "Couldn't load event." : title === 'Activity' ? "Couldn't load activity." : "Couldn't load post."}
          onRetry={load}
        />
      ) : content.type === 'post' ? (
        <PostDetail content={content} />
      ) : null}

      {toastMessage ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}

      <OptionsMenu visible={isOptionsMenuOpen} onClose={() => setIsOptionsMenuOpen(false)} options={optionsMenuOptions} />

      {user && content ? (
        <ReportModal
          visible={isReportOpen}
          onClose={() => setIsReportOpen(false)}
          reporterUid={user.uid}
          target={{ type: 'content', contentId: content.contentId }}
        />
      ) : null}

      {content ? (
        <ConfirmDialog
          visible={isDeleteConfirmOpen}
          title={DELETE_LABEL[content.type]}
          message={deleteError ?? "This can't be undone."}
          confirmLabel="Delete"
          isSubmitting={isDeleting}
          onConfirm={handleConfirmDelete}
          onCancel={() => {
            setIsDeleteConfirmOpen(false);
            setDeleteError(null);
          }}
        />
      ) : null}
    </HeaderScreenLayout>
  );
}

type MediaDetailScreenProps = {
  content: EventContent | ActivityContent;
  onOptionsPress: () => void;
  /** Only actually used by EventDetail's Share button today (Activity has none) — see this file's own toast overlay, rendered by the caller, not here. */
  onToast: (message: string) => void;
};

/**
 * Full-bleed hero + body for Event/Activity detail (Step 29) — see the
 * branch above for why this bypasses HeaderScreenLayout. An Event now
 * owns its own complete screen (hero, scroll, and a footer PINNED at the
 * real screen bottom — see EventDetail's own top doc comment) rather
 * than being wrapped by one here, since Activity has no equivalent
 * pinned-footer need and keeps the plain "everything scrolls together"
 * layout below unchanged.
 */
function MediaDetailScreen({ content, onOptionsPress, onToast }: MediaDetailScreenProps) {
  if (content.type === 'event') {
    return <EventDetail content={content} onOptionsPress={onOptionsPress} onToast={onToast} />;
  }
  return (
    <SafeAreaView style={styles.mediaSafeArea} edges={['top']}>
      {/* Same handler DetailHero's own back button calls. */}
      <SwipeBackEdge onBack={() => router.back()} />
      <ScrollView style={styles.mediaScroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.mediaScrollContent}>
        <View style={styles.mediaPage}>
          <DetailHero
            title={content.title}
            categoryId={content.categoryId}
            startsAt={content.startsAt}
            endsAt={content.endsAt}
            onOptionsPress={onOptionsPress}
          />
          <View style={styles.mediaBody}>
            <ActivityDetail content={content} />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

type EventFeedScreenProps = {
  events: EventContent[];
  /** Which of `events` to open scrolled/playing to — see ReelFeed's own `initialIndex` prop for the identical convention this mirrors. */
  initialIndex: number;
};

/**
 * A real vertical, paged swipe-through of an already-loaded Event list —
 * one full `EventDetail` per page, mirroring the exact same vertical
 * FlatList/pagingEnabled/windowSize shape ReelFeed already uses for
 * Reels (see its own doc comment). Each page still independently owns
 * its own real-time response/follow/share state (EventDetail itself,
 * completely unchanged) — this component's only job is paging between
 * them and routing whichever page is currently VISIBLE (`activeIndex`,
 * tracked the same viewability-threshold way ReelFeed tracks its own) to
 * the right Options/Report/Delete target, and firing `event_open` once
 * per Event as it becomes visible rather than only for the one initially
 * opened (same reasoning as ReelFeedItem's own per-item impression
 * tracking).
 */
function EventFeedScreen({ events, initialIndex }: EventFeedScreenProps) {
  const { user } = useAuth();
  // Horizontal, not vertical — EventDetail's own body scrolls VERTICALLY
  // internally (the About description can be long — see its own "More"
  // toggle), and nesting that inside an ALSO-vertical outer pager is a
  // classic React Native gesture conflict: confirmed live, a vertical
  // drag starting anywhere over the description just scrolled that inner
  // ScrollView instead of paging to the next Event, since the innermost
  // scrollable wins a same-axis gesture. Paging left/right instead puts
  // the two gestures on different axes entirely, so both work
  // unambiguously everywhere on screen — same reasoning real apps use for
  // a horizontally-swiped card stack with vertically-scrolling content
  // inside each card. The one accepted trade-off: each page's own
  // SwipeBackEdge (EventDetail's own left-edge "swipe right to go back")
  // still claims a rightward drag starting in that same ~32px left-edge
  // strip specifically — swiping right to the PREVIOUS Event from
  // anywhere else on screen is unaffected.
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [activeIndex, setActiveIndex] = useState(initialIndex);
  const [optionsTarget, setOptionsTarget] = useState<EventContent | null>(null);
  const [reportTarget, setReportTarget] = useState<EventContent | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EventContent | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Same event_open tracking as SingleContentScreen's own effect, just
  // keyed on the currently-VISIBLE page (activeIndex) instead of the one
  // Event that screen ever shows — see this component's own doc comment.
  useEffect(() => {
    const active = events[activeIndex];
    if (!user || !active) return;
    trackContentInteraction({
      userId: user.uid,
      contentId: active.contentId,
      contentType: 'content',
      action: 'event_open',
      categoryId: active.categoryId,
      creatorId: active.authorUid,
      cityKey: active.cityKey,
      countryCode: active.countryCode,
    }).catch(() => {});
  }, [events, activeIndex, user]);

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    const firstVisible = viewableItems.find((item) => item.isViewable);
    if (firstVisible && typeof firstVisible.index === 'number') setActiveIndex(firstVisible.index);
  }, []);

  const optionsMenuOptions =
    optionsTarget && user && user.uid === optionsTarget.authorUid
      ? [{ label: 'Delete', destructive: true, onPress: () => setDeleteTarget(optionsTarget) }]
      : optionsTarget
        ? [{ label: 'Report', onPress: () => setReportTarget(optionsTarget) }]
        : [];

  // Same permanent, no-recycle-bin policy as SingleContentScreen's own
  // delete — deleting the currently-open Event out of a swipeable feed
  // has nowhere sensible to "advance" to that this simple client-side
  // list can safely re-derive on its own (a neighbor's own place in the
  // ORIGINAL list may itself now be stale), so this simply leaves the
  // feed (back to wherever it was opened from) rather than trying to
  // keep paging through a list this screen no longer fully trusts.
  const handleConfirmDelete = async () => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    setDeleteError(null);
    const result = await deleteMyContent(deleteTarget.contentId);
    setIsDeleting(false);
    if (!result.ok) {
      setDeleteError(result.message);
      return;
    }
    setDeleteTarget(null);
    if (router.canGoBack()) router.back();
    else router.replace('/events');
  };

  return (
    <View
      style={styles.feedContainer}
      onLayout={(event) => {
        setContainerWidth(event.nativeEvent.layout.width);
        setContainerHeight(event.nativeEvent.layout.height);
      }}
    >
      {containerWidth > 0 && containerHeight > 0 ? (
        <FlatList
          data={events}
          keyExtractor={(item) => item.contentId}
          horizontal
          initialScrollIndex={initialIndex}
          getItemLayout={(_, index) => ({ length: containerWidth, offset: containerWidth * index, index })}
          renderItem={({ item }) => (
            <View style={{ width: containerWidth, height: containerHeight }}>
              <EventDetail content={item} onOptionsPress={() => setOptionsTarget(item)} onToast={showToast} />
            </View>
          )}
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          decelerationRate="fast"
          snapToInterval={containerWidth}
          snapToAlignment="start"
          viewabilityConfig={EVENT_FEED_VIEWABILITY_CONFIG}
          onViewableItemsChanged={onViewableItemsChanged}
          // Same conservative render-window reasoning as ReelFeed's own
          // identical props — only the active page plus its immediate
          // neighbors are ever mounted at once, regardless of list length.
          windowSize={3}
          maxToRenderPerBatch={2}
        />
      ) : null}

      {toastMessage ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toastMessage}</Text>
        </View>
      ) : null}

      <OptionsMenu visible={!!optionsTarget} onClose={() => setOptionsTarget(null)} options={optionsMenuOptions} />

      {user && reportTarget ? (
        <ReportModal
          visible={!!reportTarget}
          onClose={() => setReportTarget(null)}
          reporterUid={user.uid}
          target={{ type: 'content', contentId: reportTarget.contentId }}
        />
      ) : null}

      <ConfirmDialog
        visible={!!deleteTarget}
        title="Delete event?"
        message={deleteError ?? "This can't be undone."}
        confirmLabel="Delete"
        isSubmitting={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteError(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  loadingShape: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingTop: Spacing.sm,
  },
  loadingLines: {
    width: '100%',
    gap: Spacing.sm,
  },
  mediaSafeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  feedContainer: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  // This whole ScrollView/mediaPage/mediaBody stack is only reached by
  // Activity content now — Event owns its own separate full-screen
  // layout (see MediaDetailScreen's own doc comment above and
  // EventDetail.tsx's return statement) with a pinned footer, not this
  // plain scroll-everything-together one.
  mediaScroll: {
    flex: 1,
  },
  mediaScrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  mediaPage: {
    flex: 1,
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  mediaBody: {
    flex: 1,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  overflowButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toast: {
    position: 'absolute',
    bottom: Spacing.xxl,
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
