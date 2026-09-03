import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import { AuthorLink } from '@/components/AuthorLink';
import { Avatar } from '@/components/Avatar';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { INTERESTS } from '@/constants/interests';
import { useAuth } from '@/hooks/useAuth';
import { fetchReelCommentCount, fetchReelLikeCount, isReelLiked, likeReel, unlikeReel } from '@/services/reelEngagement';
import { resolveReelPlaybackUrl } from '@/services/reels';
import type { Reel } from '@/types/reel';

type ReelFeedItemProps = {
  reel: Reel;
  height: number;
  isActive: boolean;
  /**
   * True for the active item plus one neighbor on each side — see
   * ReelsScreen's preload window. Only "prepared" items ever resolve a
   * playback URL and hold a real video player; everything else stays
   * released (see the useEffect below resetting local state when this
   * flips false), which is what keeps concurrent player/buffer resources
   * bounded to at most 3 regardless of feed length.
   */
  shouldPrepare: boolean;
  isOwnReel: boolean;
  onOpenOptions: () => void;
};

const CATEGORY_LABEL_BY_ID = new Map(INTERESTS.map((interest) => [interest.id, `${interest.emoji} ${interest.label}`]));

/**
 * One page of the vertical Reels feed. Owns its own video player instance
 * (only ever plays when `isActive`, only ever holds a real source when
 * `shouldPrepare`) — see ReelsScreen for how activity/prepare windows are
 * tracked and how only one item is ever active at a time.
 */
export function ReelFeedItem({ reel, height, isActive, shouldPrepare, isOwnReel, onOpenOptions }: ReelFeedItemProps) {
  const { user } = useAuth();
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [urlStatus, setUrlStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [playbackFailed, setPlaybackFailed] = useState(false);
  const [muted, setMuted] = useState(true);

  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [isLikeSubmitting, setIsLikeSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!shouldPrepare) {
      // Out of the preload window — release whatever this item was
      // holding (setting playbackUrl back to null is what actually
      // releases the underlying player; see useVideoPlayer below). Same
      // prop-driven-reset pattern as ReportModal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPlaybackUrl(null);
      setUrlStatus('idle');
      setPlaybackFailed(false);
      return;
    }
    // Resets fresh whenever the item's own reel (and therefore its
    // storagePath) changes — the same prop-driven-reset pattern already
    // used in ReportModal.
    setUrlStatus('loading');
    resolveReelPlaybackUrl(reel.storagePath).then((url) => {
      if (cancelled) return;
      if (url) {
        setPlaybackUrl(url);
        setUrlStatus('ready');
      } else {
        setUrlStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reel.storagePath, shouldPrepare]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([user ? isReelLiked(reel.reelId, user.uid) : Promise.resolve(false), fetchReelLikeCount(reel.reelId), fetchReelCommentCount(reel.reelId)]).then(
      ([liked, likes, comments]) => {
        if (cancelled) return;
        setIsLiked(liked);
        setLikeCount(likes);
        setCommentCount(comments);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [reel.reelId, user]);

  const player = useVideoPlayer(playbackUrl, (p) => {
    p.loop = true;
    // Muted by default — browser autoplay policy blocks unmuted autoplay
    // (see the Step 18 spec's web-autoplay note). The mute control below
    // lets the viewer opt into sound once a video is already playing.
    p.muted = true;
  });

  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status: playerStatus }) => {
      if (playerStatus === 'error') {
        setPlaybackFailed(true);
      }
    });
    return () => subscription.remove();
  }, [player]);

  useEffect(() => {
    if (isActive && urlStatus === 'ready' && !playbackFailed) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, urlStatus, playbackFailed, player]);

  const handleRetryPlayback = () => {
    setPlaybackUrl(null);
    setPlaybackFailed(false);
    setUrlStatus('loading');
    resolveReelPlaybackUrl(reel.storagePath).then((url) => {
      if (url) {
        setPlaybackUrl(url);
        setUrlStatus('ready');
      } else {
        setUrlStatus('error');
      }
    });
  };

  const handleToggleLike = async () => {
    if (!user || isLikeSubmitting) return;
    const wasLiked = isLiked;
    const previousCount = likeCount;
    // Optimistic UI — rolled back below if the write fails. isLikeSubmitting
    // guards against a double-tap firing a second write before this one
    // settles.
    setIsLikeSubmitting(true);
    setIsLiked(!wasLiked);
    setLikeCount(wasLiked ? Math.max(0, previousCount - 1) : previousCount + 1);
    const result = wasLiked ? await unlikeReel(reel.reelId, user.uid) : await likeReel(reel.reelId, user.uid);
    setIsLikeSubmitting(false);
    if (!result.ok) {
      // Rollback — includes the Block-denied case, handled gracefully by
      // simply reverting to the prior state rather than crashing the feed.
      setIsLiked(wasLiked);
      setLikeCount(previousCount);
    }
  };

  const categoryLabel = CATEGORY_LABEL_BY_ID.get(reel.categoryId);

  return (
    <View style={[styles.page, { height }]}>
      {urlStatus === 'ready' && playbackUrl && !playbackFailed ? (
        <VideoView
          style={StyleSheet.absoluteFill}
          player={player}
          contentFit="cover"
          nativeControls={false}
          allowsPictureInPicture={false}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.mediaFallback]}>
          {urlStatus === 'loading' || urlStatus === 'idle' ? (
            <ActivityIndicator color={Colors.textSecondary} />
          ) : playbackFailed ? (
            <View style={styles.playbackErrorState}>
              <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
              <Text style={styles.playbackErrorText}>Couldn&apos;t play this Reel</Text>
              <Pressable onPress={handleRetryPlayback} accessibilityRole="button">
                <Text style={styles.retryLink}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
          )}
        </View>
      )}

      <Pressable
        style={styles.muteButton}
        onPress={() => {
          const next = !muted;
          setMuted(next);
          // expo-video's player is an imperative external handle (a
          // SharedObject) — setting properties like `muted` directly is
          // its documented API, not React state; this mutation belongs in
          // an event handler, not a render body or effect.
          // eslint-disable-next-line react-hooks/immutability
          player.muted = next;
        }}
        accessibilityRole="button"
        accessibilityLabel={muted ? 'Unmute' : 'Mute'}
      >
        <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={18} color={Colors.text} />
      </Pressable>

      {!isOwnReel && (
        <Pressable style={styles.optionsButton} onPress={onOpenOptions} accessibilityRole="button" accessibilityLabel="Reel options">
          <Ionicons name="ellipsis-horizontal" size={20} color={Colors.text} />
        </Pressable>
      )}

      <View style={styles.actionRail}>
        <Pressable
          onPress={handleToggleLike}
          disabled={!user || isLikeSubmitting}
          style={styles.actionButton}
          accessibilityRole="button"
          accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
          accessibilityState={{ selected: isLiked }}
        >
          <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={30} color={isLiked ? Colors.accent : Colors.text} />
          <Text style={styles.actionCount}>{likeCount}</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push(`/reel/${reel.reelId}`)}
          style={styles.actionButton}
          accessibilityRole="button"
          accessibilityLabel="Open comments"
        >
          <Ionicons name="chatbubble-outline" size={27} color={Colors.text} />
          <Text style={styles.actionCount}>{commentCount}</Text>
        </Pressable>
      </View>

      <View style={styles.overlay} pointerEvents="box-none">
        <AuthorLink uid={reel.authorUid} style={styles.authorRow}>
          <Avatar name={reel.authorDisplayName} size={36} />
          <View>
            <Text style={styles.authorName}>{reel.authorDisplayName}</Text>
            <Text style={styles.authorUsername}>@{reel.authorUsername}</Text>
          </View>
        </AuthorLink>

        {reel.caption ? <Text style={styles.caption}>{reel.caption}</Text> : null}

        {categoryLabel ? (
          <View style={styles.categoryChip}>
            <Text style={styles.categoryText}>{categoryLabel}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    width: '100%',
    backgroundColor: Colors.background,
    justifyContent: 'flex-end',
  },
  mediaFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  playbackErrorState: {
    alignItems: 'center',
    gap: Spacing.xs,
  },
  playbackErrorText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  retryLink: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  muteButton: {
    position: 'absolute',
    top: Spacing.lg,
    right: Spacing.lg,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
  },
  optionsButton: {
    position: 'absolute',
    top: Spacing.lg,
    right: Spacing.lg + 44,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
  },
  actionRail: {
    position: 'absolute',
    right: Spacing.lg,
    bottom: Spacing.xxl * 2,
    alignItems: 'center',
    gap: Spacing.lg,
  },
  actionButton: {
    alignItems: 'center',
    gap: 4,
  },
  actionCount: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '700',
  },
  overlay: {
    padding: Spacing.lg,
    paddingRight: Spacing.xxl * 2,
    gap: Spacing.sm,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    alignSelf: 'flex-start',
  },
  authorName: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  authorUsername: {
    color: 'rgba(245, 245, 247, 0.75)',
    fontSize: 13,
  },
  caption: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  categoryChip: {
    alignSelf: 'flex-start',
    borderRadius: Radius.full,
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  categoryText: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
});
