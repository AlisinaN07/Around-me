import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { deleteMyContent, fetchContentById } from '@/services/content';
import { isPostReposted, repostPost, undoRepost } from '@/services/reposts';
import { isPostSaved, savePost, unsavePost } from '@/services/saved';
import type { ActivityContent, Content, EventContent } from '@/types/content';

type LoadStatus = 'loading' | 'loaded' | 'error';

const DELETE_LABEL: Record<Content['type'], string> = {
  post: 'Delete post?',
  activity: 'Delete activity?',
  event: 'Delete event?',
};

export default function ContentDetailScreen() {
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
        <MediaDetailScreen content={content} onOptionsPress={() => setIsOptionsMenuOpen(true)} />
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
};

/** Full-bleed hero + body for Event/Activity detail (Step 29) — see the branch above for why this bypasses HeaderScreenLayout. */
function MediaDetailScreen({ content, onOptionsPress }: MediaDetailScreenProps) {
  return (
    <SafeAreaView style={styles.mediaSafeArea} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.mediaScrollContent}>
        <View style={styles.mediaPage}>
          <DetailHero
            title={content.title}
            categoryId={content.categoryId}
            startsAt={content.startsAt}
            endsAt={content.endsAt}
            onOptionsPress={onOptionsPress}
          />
          <View style={styles.mediaBody}>
            {content.type === 'activity' ? <ActivityDetail content={content} /> : <EventDetail content={content} />}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
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
  mediaScrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  mediaPage: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  mediaBody: {
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
