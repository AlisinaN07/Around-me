import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import { AuthorLink } from '@/components/AuthorLink';
import { Avatar } from '@/components/Avatar';
import { ReelCommentsSheet } from '@/components/ReelCommentsSheet';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { INTERESTS } from '@/constants/interests';
import { useAuth } from '@/hooks/useAuth';
import { followUser, isFollowing } from '@/services/following';
import { fetchPublicProfile } from '@/services/publicProfile';
import { fetchReelCommentCount, fetchReelLikeCount, isReelLiked, likeReel, unlikeReel } from '@/services/reelEngagement';
import { resolveReelPlaybackUrl } from '@/services/reels';
import { isPostSaved, savePost, unsavePost } from '@/services/saved';
import type { Reel } from '@/types/reel';
import { buildReelShareUrl, shareReel } from '@/utils/reelShare';

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
  onOpenOptions: () => void;
  /** Brief transient confirmation (e.g. "Saved") — rendered once by the shared parent feed, not per-item. */
  onToast: (message: string) => void;
};

const CATEGORY_LABEL_BY_ID = new Map(INTERESTS.map((interest) => [interest.id, `${interest.emoji} ${interest.label}`]));

/**
 * One page of the vertical Reels feed. Owns its own video player instance
 * (only ever plays when `isActive`, only ever holds a real source when
 * `shouldPrepare`) — see ReelsScreen for how activity/prepare windows are
 * tracked and how only one item is ever active at a time.
 */
export function ReelFeedItem({ reel, height, isActive, shouldPrepare, onOpenOptions, onToast }: ReelFeedItemProps) {
  const { user } = useAuth();
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [urlStatus, setUrlStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [playbackFailed, setPlaybackFailed] = useState(false);

  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [commentCount, setCommentCount] = useState(0);
  const [isLikeSubmitting, setIsLikeSubmitting] = useState(false);
  // Comments open as a half-screen sheet over this still-playing,
  // still-full-screen item — never a navigation away from it (see
  // ReelCommentsSheet's own doc comment for why).
  const [isCommentsOpen, setIsCommentsOpen] = useState(false);

  // Save has no meaning on the author's own Reel (same as the retired
  // Save option never appearing in the own-Reel options menu) — see the
  // `isOwnReel` guard below and in the effect that reflects current state.
  const [isSaved, setIsSaved] = useState(false);
  const [isSaveSubmitting, setIsSaveSubmitting] = useState(false);
  const isOwnReel = !!user && reel.authorUid === user.uid;

  // The small "+" follow badge on the author's avatar — `null` means not
  // yet checked (renders nothing, same "don't show a wrong guess" rule as
  // Save/Like), `false` shows the badge, `true` hides it entirely (never
  // shown again for an already-followed author). `justFollowed` is purely
  // the brief checkmark shown right after tapping, before the badge
  // disappears for good — see handleFollow.
  const [isFollowingAuthor, setIsFollowingAuthor] = useState<boolean | null>(null);
  const [isFollowSubmitting, setIsFollowSubmitting] = useState(false);
  const [justFollowed, setJustFollowed] = useState(false);
  const followHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The author's avatar photo — deliberately NOT reel.authorDisplayName's
  // sibling denormalized field. reel.authorDisplayName is frozen at Reel
  // creation time (never updated if the author later renames), which is
  // fine for a name but would be wrong here: it would mean a Reel posted
  // before the author ever set a profile photo could never show one, even
  // after they add one. So this reads the author's current
  // publicProfiles/{uid} instead — same live, per-mount fetch (and same
  // "accepted, low-cost re-read, not a real staleness bug" reasoning) as
  // the Follow-state effect just below.
  const [authorPhotoURL, setAuthorPhotoURL] = useState('');

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

  // Reflects the correct current Saved state for THIS item independently
  // (same "reflect current state" reasoning as the like effect above) —
  // never shown/fetched for the viewer's own Reel.
  useEffect(() => {
    let cancelled = false;
    if (isOwnReel || !user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsSaved(false);
      return;
    }
    isPostSaved(user.uid, 'reel', reel.reelId).then((saved) => {
      if (!cancelled) setIsSaved(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [reel.reelId, user, isOwnReel]);

  // Reflects the correct current Follow state for THIS item's author
  // independently (same "reflect current state" reasoning as Save above)
  // — never shown/fetched for the viewer's own Reel. Deliberately keyed
  // on reel.authorUid, not reel.reelId: the same author's next Reel in
  // the feed should never briefly re-show a "+" that was already
  // dismissed for them this session — but since this is a fresh mount per
  // feed item (not a shared cache), it still re-checks per item; that's
  // an accepted, low-cost re-read, not a real staleness bug.
  useEffect(() => {
    let cancelled = false;
    if (isOwnReel || !user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsFollowingAuthor(null);
      return;
    }
    isFollowing(user.uid, reel.authorUid).then((following) => {
      if (!cancelled) setIsFollowingAuthor(following);
    });
    return () => {
      cancelled = true;
    };
  }, [reel.authorUid, user, isOwnReel]);

  useEffect(() => {
    let cancelled = false;
    fetchPublicProfile(reel.authorUid).then((authorProfile) => {
      if (!cancelled) setAuthorPhotoURL(authorProfile?.photoURL ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [reel.authorUid]);

  const player = useVideoPlayer(playbackUrl, (p) => {
    p.loop = true;
    // Sound is always on — no mute control, no muted-by-default (owner
    // decision). Note: this can make unattended web autoplay unreliable
    // under a strict browser autoplay policy (some browsers block
    // autoplaying unmuted media without prior user interaction on the
    // origin) — native iOS/Android playback is unaffected.
    p.muted = false;
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

  const handleToggleSave = async () => {
    if (!user || isOwnReel || isSaveSubmitting) return;
    const wasSaved = isSaved;
    setIsSaveSubmitting(true);
    const result = wasSaved ? await unsavePost(user.uid, 'reel', reel.reelId) : await savePost(user.uid, 'reel', reel.reelId);
    setIsSaveSubmitting(false);
    if (!result.ok) {
      onToast(result.message);
      return;
    }
    setIsSaved(!wasSaved);
    onToast(wasSaved ? 'Removed from saved' : 'Saved');
  };

  // Tapping the "+" follow badge: real write immediately (never a fake
  // optimistic follow that could silently fail), then a brief checkmark
  // before the badge disappears for good — it never comes back for this
  // author once followed (isFollowingAuthor flips to true permanently
  // here, same as it would on a fresh mount that found an existing
  // Follow edge).
  const handleFollow = async () => {
    if (!user || isOwnReel || isFollowSubmitting) return;
    setIsFollowSubmitting(true);
    const result = await followUser(user.uid, reel.authorUid);
    setIsFollowSubmitting(false);
    if (!result.ok) {
      onToast(result.message);
      return;
    }
    setJustFollowed(true);
    followHideTimerRef.current = setTimeout(() => {
      setIsFollowingAuthor(true);
      setJustFollowed(false);
    }, 900);
  };

  useEffect(() => {
    return () => {
      if (followHideTimerRef.current) clearTimeout(followHideTimerRef.current);
    };
  }, []);

  // Same fallback reasoning as the retired options-menu "Share post"
  // entry: the native share sheet can fail for reasons other than the
  // person cancelling it (e.g. no share target configured on web), in
  // which case silently copying the link is a better outcome than
  // nothing happening at all. A genuine cancel stays quiet.
  const handleShare = async () => {
    const result = await shareReel(reel.reelId);
    if (!result.ok && !/cancel/i.test(result.message)) {
      await Clipboard.setStringAsync(buildReelShareUrl(reel.reelId));
      onToast('Link copied');
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
              <Text style={styles.playbackErrorText}>Couldn&apos;t play this post</Text>
              <Pressable onPress={handleRetryPlayback} accessibilityRole="button">
                <Text style={styles.retryLink}>Retry</Text>
              </Pressable>
            </View>
          ) : (
            <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
          )}
        </View>
      )}

      <View style={styles.actionRail}>
        <View style={styles.actionAvatarWrap}>
          <AuthorLink uid={reel.authorUid} style={styles.actionAvatar}>
            <Avatar name={reel.authorDisplayName} photoURL={authorPhotoURL} size={40} />
          </AuthorLink>
          {isFollowingAuthor === false && (
            <Pressable
              onPress={handleFollow}
              disabled={isFollowSubmitting}
              hitSlop={8}
              style={styles.followBadge}
              accessibilityRole="button"
              accessibilityLabel={justFollowed ? 'Followed' : `Follow ${reel.authorDisplayName}`}
            >
              <Ionicons name={justFollowed ? 'checkmark' : 'add'} size={14} color={Colors.text} />
            </Pressable>
          )}
        </View>
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
          onPress={() => setIsCommentsOpen(true)}
          style={styles.actionButton}
          accessibilityRole="button"
          accessibilityLabel="Open comments"
        >
          <Ionicons name="chatbubble-outline" size={27} color={Colors.text} />
          <Text style={styles.actionCount}>{commentCount}</Text>
        </Pressable>
        {!isOwnReel ? (
          <Pressable
            onPress={handleToggleSave}
            disabled={!user || isSaveSubmitting}
            style={styles.actionButton}
            accessibilityRole="button"
            accessibilityLabel={isSaved ? 'Remove from saved' : 'Save'}
            accessibilityState={{ selected: isSaved }}
          >
            <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={27} color={isSaved ? Colors.accent : Colors.text} />
          </Pressable>
        ) : null}
        <Pressable onPress={handleShare} style={styles.actionButton} accessibilityRole="button" accessibilityLabel="Share post">
          <Ionicons name="share-outline" size={27} color={Colors.text} />
        </Pressable>
        <Pressable onPress={onOpenOptions} style={styles.actionButton} accessibilityRole="button" accessibilityLabel="Post options">
          <Ionicons name="ellipsis-horizontal" size={27} color={Colors.text} />
        </Pressable>
      </View>

      <View style={styles.overlay} pointerEvents="box-none">
        <AuthorLink uid={reel.authorUid} style={styles.authorRow}>
          <Text style={styles.authorName}>{reel.authorDisplayName}</Text>
        </AuthorLink>

        {reel.caption ? <Text style={styles.caption}>{reel.caption}</Text> : null}

        {categoryLabel ? (
          <View style={styles.categoryChip}>
            <Text style={styles.categoryText}>{categoryLabel}</Text>
          </View>
        ) : null}
      </View>

      <ReelCommentsSheet
        visible={isCommentsOpen}
        reelId={reel.reelId}
        onClose={() => setIsCommentsOpen(false)}
        onCommentCountChange={setCommentCount}
      />
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
  actionRail: {
    position: 'absolute',
    right: Spacing.lg,
    bottom: Spacing.xxl * 2,
    alignItems: 'center',
    gap: Spacing.lg,
  },
  actionAvatarWrap: {
    alignItems: 'center',
  },
  actionAvatar: {
    alignItems: 'center',
  },
  // Overlaps the avatar's own bottom edge — same "+" -> checkmark ->
  // disappears pattern as every other short-video app's follow-from-feed
  // affordance (see handleFollow's own doc comment for the exact timing).
  followBadge: {
    position: 'absolute',
    bottom: -6,
    alignSelf: 'center',
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Colors.accent,
    borderWidth: 2,
    borderColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
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
    alignSelf: 'flex-start',
  },
  authorName: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
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
