import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { EmptyState } from '@/components/EmptyState';
import { SwipeBackEdge } from '@/components/SwipeBackEdge';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchPublicProfile } from '@/services/publicProfile';
import { deleteMyStory, fetchActiveStoriesForAuthor, markStoryViewed, resolveStoryPlaybackUrl } from '@/services/stories';
import type { Story } from '@/types/story';

type LoadStatus = 'loading' | 'loaded' | 'error';

/** How long a photo Story stays on screen before auto-advancing — a video Story instead advances on its own `playToEnd` (see the effect below), so this only ever applies to a still image. */
const STORY_PHOTO_DISPLAY_MS = 5000;

/**
 * Full-screen Story viewer — one author's currently-active Story group
 * (src/types/story.ts), tap-through with a segmented progress bar, exactly
 * like every other Stories feature. Reached from a ringed avatar in
 * FollowingAvatarRow (src/app/(app)/(tabs)/inbox.tsx — Stories live in the
 * Inbox's own avatar strip, not a separate tray), which also passes every
 * OTHER story-having uid in that same row as `queue` (a comma-separated
 * list) so finishing one author's last Story auto-advances straight into
 * the next author's group instead of dropping back to Inbox — `startAt=last`
 * (also set by this screen when navigating BACKWARD through that same
 * queue) opens a group on its final Story rather than its first, matching
 * tapping "back" past the start of
 * the next group in a real Stories UI.
 */
export default function StoryViewerScreen() {
  const { uid, queue, startAt } = useLocalSearchParams<{ uid: string; queue?: string; startAt?: string }>();
  const { user } = useAuth();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [stories, setStories] = useState<Story[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [authorDisplayName, setAuthorDisplayName] = useState('');
  const [authorPhotoURL, setAuthorPhotoURL] = useState('');
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<Story | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const queueUids = useMemo(() => (queue ? queue.split(',').filter(Boolean) : []), [queue]);
  const isSelf = !!user && user.uid === uid;

  const load = useCallback(async () => {
    setStatus('loading');
    setStories([]);
    setCurrentIndex(0);
    const [activeStories, profile] = await Promise.all([fetchActiveStoriesForAuthor(uid), fetchPublicProfile(uid)]);
    setStories(activeStories);
    setAuthorDisplayName(profile?.displayName ?? activeStories[0]?.authorDisplayName ?? '');
    setAuthorPhotoURL(profile?.photoURL ?? '');
    setCurrentIndex(startAt === 'last' ? Math.max(0, activeStories.length - 1) : 0);
    setStatus('loaded');
  }, [uid, startAt]);

  useFocusEffect(
    useCallback(() => {
      load();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uid, startAt])
  );

  const currentStory: Story | undefined = stories[currentIndex];

  // A still-image Story has no player of its own — the video player below
  // is only ever given a real source when the CURRENT Story is a video.
  const isVideoStory = currentStory?.mediaType === 'video';
  const player = useVideoPlayer(isVideoStory ? playbackUrl : null, (p) => {
    // Never loops — a video Story auto-advances via its own `playToEnd`
    // (see the effect below), same one-pass-then-move-on behavior as the
    // fixed timer used for a photo Story.
    p.loop = false;
    p.muted = false;
  });

  useEffect(() => {
    let cancelled = false;
    // Resets fresh whenever the current Story changes — same prop-driven-
    // reset pattern as ReelFeedItem/ReportModal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlaybackUrl(null);
    setProgress(0);
    if (!currentStory) return;
    resolveStoryPlaybackUrl(currentStory).then((url) => {
      if (!cancelled) setPlaybackUrl(url);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentStory?.storagePath, currentStory?.storageProvider, currentStory?.mediaUrl]);

  useEffect(() => {
    if (isVideoStory && playbackUrl) player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideoStory, playbackUrl]);

  const closeViewer = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const goToQueueUid = useCallback(
    (direction: 'next' | 'prev') => {
      const idx = queueUids.indexOf(uid);
      const targetIdx = idx === -1 ? -1 : direction === 'next' ? idx + 1 : idx - 1;
      if (targetIdx < 0 || targetIdx >= queueUids.length) {
        closeViewer();
        return;
      }
      const targetUid = queueUids[targetIdx];
      const suffix = direction === 'prev' ? '&startAt=last' : '';
      router.replace(`/story/${targetUid}?queue=${encodeURIComponent(queue ?? '')}${suffix}`);
    },
    [queueUids, uid, queue]
  );

  const goNext = useCallback(() => {
    const next = currentIndex + 1;
    if (next >= stories.length) {
      goToQueueUid('next');
      return;
    }
    setCurrentIndex(next);
  }, [currentIndex, stories.length, goToQueueUid]);

  const goPrev = useCallback(() => {
    const prev = currentIndex - 1;
    if (prev < 0) {
      goToQueueUid('prev');
      return;
    }
    setCurrentIndex(prev);
  }, [currentIndex, goToQueueUid]);

  // Photo auto-advance timer.
  useEffect(() => {
    if (!currentStory || isVideoStory) return;
    const start = Date.now();
    const interval = setInterval(() => {
      const pct = Math.min(1, (Date.now() - start) / STORY_PHOTO_DISPLAY_MS);
      setProgress(pct);
      if (pct >= 1) {
        clearInterval(interval);
        goNext();
      }
    }, 100);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, currentStory?.storyId, isVideoStory]);

  // Video progress-bar polling + real end-of-clip auto-advance.
  useEffect(() => {
    if (!isVideoStory) return;
    const interval = setInterval(() => {
      if (player.duration > 0) setProgress(Math.min(1, player.currentTime / player.duration));
    }, 150);
    const subscription = player.addListener('playToEnd', goNext);
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, isVideoStory, currentIndex]);

  // Mark viewed once this Story's real content is actually on screen —
  // INCLUDING your own Story: this is what turns its ring gray in
  // FollowingAvatarRow (src/app/(app)/(tabs)/inbox.tsx) once you've
  // actually watched it, same as everyone else's. A future per-Story
  // "view count" feature (there isn't one yet) would need to exclude the
  // author's own uid from that count — see markStoryViewed's own doc
  // comment in src/services/stories.ts for the "author sees a count,
  // never who else is watching along with them" privacy model this
  // otherwise feeds.
  useEffect(() => {
    if (!user || !currentStory) return;
    markStoryViewed(currentStory.storyId, user.uid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, currentStory?.storyId]);

  const handleConfirmDelete = async () => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    const result = await deleteMyStory(deleteTarget.storyId);
    setIsDeleting(false);
    setDeleteTarget(null);
    if (!result.ok) return;
    const remaining = stories.filter((story) => story.storyId !== deleteTarget.storyId);
    if (remaining.length === 0) {
      goToQueueUid('next');
      return;
    }
    setStories(remaining);
    setCurrentIndex((prev) => Math.min(prev, remaining.length - 1));
  };

  if (status === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={Colors.textSecondary} />
      </View>
    );
  }

  if (stories.length === 0 || !currentStory) {
    return (
      <View style={styles.centered}>
        <EmptyState bare icon="time-outline" title="No active Story" body="This Story has expired or is no longer available." />
        <Pressable onPress={closeViewer} style={styles.emptyCloseButton} accessibilityRole="button" accessibilityLabel="Close">
          <Text style={styles.emptyCloseText}>Close</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <SwipeBackEdge onBack={closeViewer} />

      {currentStory.mediaType === 'photo' ? (
        // Perf pass — expo-image, memory+disk cached. Video Stories
        // (VideoView below) are untouched.
        <Image source={{ uri: playbackUrl ?? undefined }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
      ) : playbackUrl ? (
        <VideoView style={StyleSheet.absoluteFill} player={player} contentFit="cover" nativeControls={false} allowsPictureInPicture={false} />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.centered]}>
          <ActivityIndicator color={Colors.textSecondary} />
        </View>
      )}

      {/* Tap zones — left third goes back, the rest advances. Rendered
          BELOW the top overlay in JSX so the close/delete buttons still
          receive their own taps first. */}
      <View style={StyleSheet.absoluteFill}>
        <Pressable style={styles.tapZoneLeft} onPress={goPrev} accessibilityRole="button" accessibilityLabel="Previous Story" />
        <Pressable style={styles.tapZoneRight} onPress={goNext} accessibilityRole="button" accessibilityLabel="Next Story" />
      </View>

      <View style={styles.topOverlay} pointerEvents="box-none">
        <View style={styles.progressRow}>
          {stories.map((story, index) => (
            <View key={story.storyId} style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${index < currentIndex ? 100 : index === currentIndex ? progress * 100 : 0}%` },
                ]}
              />
            </View>
          ))}
        </View>

        <View style={styles.authorRow}>
          <Avatar name={authorDisplayName} photoURL={authorPhotoURL} size={32} />
          <Text style={styles.authorName} numberOfLines={1}>
            {isSelf ? 'Your Story' : authorDisplayName}
          </Text>
          <View style={styles.authorRowSpacer} />
          {isSelf ? (
            <Pressable onPress={() => setDeleteTarget(currentStory)} hitSlop={10} accessibilityRole="button" accessibilityLabel="Delete Story">
              <Ionicons name="trash-outline" size={22} color={Colors.text} />
            </Pressable>
          ) : null}
          <Pressable onPress={closeViewer} hitSlop={10} accessibilityRole="button" accessibilityLabel="Close">
            <Ionicons name="close" size={26} color={Colors.text} />
          </Pressable>
        </View>
      </View>

      <ConfirmDialog
        visible={!!deleteTarget}
        title="Delete this Story?"
        message="This will remove it for everyone who can currently see it."
        confirmLabel="Delete"
        isSubmitting={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
    gap: Spacing.md,
  },
  emptyCloseButton: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  emptyCloseText: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  tapZoneLeft: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '35%',
  },
  tapZoneRight: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: '65%',
  },
  topOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 56,
    paddingHorizontal: Spacing.md,
    gap: Spacing.sm,
  },
  progressRow: {
    flexDirection: 'row',
    gap: 4,
  },
  progressTrack: {
    flex: 1,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: Colors.text,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  authorName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  authorRowSpacer: {
    flex: 1,
  },
});
