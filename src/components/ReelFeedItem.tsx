import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import { AuthorLink } from '@/components/AuthorLink';
import { Avatar } from '@/components/Avatar';
import { ReelCommentsSheet } from '@/components/ReelCommentsSheet';
import { SoundSheet } from '@/components/SoundSheet';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { INTERESTS } from '@/constants/interests';
import { useAuth } from '@/hooks/useAuth';
import { followUser, isFollowing } from '@/services/following';
import { fetchPublicProfile } from '@/services/publicProfile';
import { fetchReelCommentCount, fetchReelLikeCount, isReelLiked, likeReel, unlikeReel } from '@/services/reelEngagement';
import { trackContentInteraction, trackReelWatchSummary, trackVideoStarted } from '@/services/recommendations/interactions';
import { resolveReelPlaybackUrl } from '@/services/reels';
import { isPostSaved, savePost, unsavePost } from '@/services/saved';
import { fetchActiveStoriesForAuthor, hasViewedStory } from '@/services/stories';
import type { Reel } from '@/types/reel';
import type { RankingAttribution } from '@/types/recommendation';
import type { PublicProfile } from '@/types/social';
import { buildReelShareUrl, shareReel } from '@/utils/reelShare';

// How far (px) a horizontal drag has to travel before it counts as a
// deliberate "swipe to profile" rather than an accidental wobble during a
// tap or a vertical page-swipe.
const SWIPE_TO_PROFILE_THRESHOLD = 60;

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
  /** Recommendation Engine — Step 6 — DEVELOPMENT/analytics-only ranking metadata for THIS reel (Step 18/19) — undefined for a Reel that didn't come from a ranked feed (Following mode, /reels, a single-Reel detail view). Attached to every tracking call this component fires below; never read for anything else. */
  attribution?: RankingAttribution;
  /** Paired with `attribution` — see ReelFeed.tsx's own doc comment. */
  feedSessionId?: string;
};

const CATEGORY_LABEL_BY_ID = new Map(INTERESTS.map((interest) => [interest.id, `${interest.emoji} ${interest.label}`]));

/**
 * One page of the vertical Reels feed. Owns its own video player instance
 * (only ever plays when `isActive`, only ever holds a real source when
 * `shouldPrepare`) — see ReelsScreen for how activity/prepare windows are
 * tracked and how only one item is ever active at a time.
 */
export function ReelFeedItem({ reel, height, isActive, shouldPrepare, onOpenOptions, onToast, attribution, feedSessionId }: ReelFeedItemProps) {
  const { user } = useAuth();
  // Whether the screen THIS item lives on (Home, a single-Post route,
  // etc.) is the one currently on top — see isSoundSheetOpen's own doc
  // comment and the SoundSheet render below for why.
  const isScreenFocused = useIsFocused();
  // "FOTO" mode (see ReelMediaType's own doc comment in src/types/reel.ts)
  // — a static image, so it skips the video player entirely below (no
  // play/pause, no statusChange listener) while reusing the exact same
  // storagePath-resolving effect, like/comment/save/follow/share state,
  // and swipe gesture as a video Reel.
  const isPhoto = reel.mediaType === 'photo';
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
  // The "whose sound is this" bottom sheet (src/components/SoundSheet.tsx)
  // — same still-playing, no-navigation-away pattern as comments above.
  // Deliberately NOT reset when this screen loses focus (tapping a post
  // inside the sheet's own grid pushes the reel detail screen on top) —
  // see isScreenFocused below, which is what actually hides the Modal
  // while away, so navigating back here reveals this exact sheet again
  // rather than a plain feed with no memory it was ever open.
  const [isSoundSheetOpen, setIsSoundSheetOpen] = useState(false);

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

  // Same Story ring as FollowingAvatarRow (src/app/(app)/(tabs)/inbox.tsx)
  // — accent while any of the author's active Stories is still unwatched,
  // gray once you've seen all of them, absent entirely if they have none.
  // fetchActiveStoriesForAuthor already enforces the real followers-only
  // visibility (src/types/story.ts) — it comes back empty, not an error,
  // for an author whose Stories you can't see, so this never needs its
  // own separate "do I follow them" check. Same "accepted, low-cost
  // per-mount re-read" reasoning as authorPhotoURL/Follow-state above.
  const [hasActiveStory, setHasActiveStory] = useState(false);
  const [isStoryUnseen, setIsStoryUnseen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      // Resets fresh whenever there's no signed-in viewer to check
      // against — same prop-driven-reset pattern as ReportModal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHasActiveStory(false);
      setIsStoryUnseen(false);
      return;
    }
    fetchActiveStoriesForAuthor(reel.authorUid).then(async (stories) => {
      if (cancelled) return;
      if (stories.length === 0) {
        setHasActiveStory(false);
        setIsStoryUnseen(false);
        return;
      }
      setHasActiveStory(true);
      let unseen = false;
      for (const story of stories) {
        const seen = await hasViewedStory(story.storyId, user.uid);
        if (!seen) {
          unseen = true;
          break;
        }
      }
      if (!cancelled) setIsStoryUnseen(unseen);
    });
    return () => {
      cancelled = true;
    };
  }, [reel.authorUid, user]);

  // "Whose sound is this" avatar (see this component's own doc comment
  // above and Reel.musicHash's own doc comment in src/types/reel.ts) —
  // only ever fetched for a Reel with picked device music AND a real
  // resolved origin (soundOriginAuthorUid is '' on a Reel with no music,
  // or a legacy Reel predating this feature — see normalizeReel in
  // reels.ts). A Reel with NO picked music needs no fetch at all: its own
  // author (authorPhotoURL, already fetched above) is who gets shown.
  const [soundOriginProfile, setSoundOriginProfile] = useState<PublicProfile | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (reel.musicSourceType !== 'device' || !reel.soundOriginAuthorUid) {
      // Resets fresh whenever this Reel has no attributable sound to
      // look up — same prop-driven-reset pattern as ReportModal.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSoundOriginProfile(null);
      return;
    }
    fetchPublicProfile(reel.soundOriginAuthorUid).then((profile) => {
      if (!cancelled) setSoundOriginProfile(profile);
    });
    return () => {
      cancelled = true;
    };
  }, [reel.musicSourceType, reel.soundOriginAuthorUid]);

  // Never given a real source for a photo Reel — there is nothing to
  // decode or play, and handing a still-image URL to expo-video would just
  // surface as a spurious playback error.
  const player = useVideoPlayer(isPhoto ? null : playbackUrl, (p) => {
    p.loop = true;
    // Sound is always on — no mute control, no muted-by-default (owner
    // decision). Note: this can make unattended web autoplay unreliable
    // under a strict browser autoplay policy (some browsers block
    // autoplaying unmuted media without prior user interaction on the
    // origin) — native iOS/Android playback is unaffected.
    p.muted = false;
  });

  useEffect(() => {
    if (isPhoto) return;
    const subscription = player.addListener('statusChange', ({ status: playerStatus }) => {
      if (playerStatus === 'error') {
        setPlaybackFailed(true);
      }
    });
    return () => subscription.remove();
  }, [player, isPhoto]);

  useEffect(() => {
    if (isPhoto) return;
    if (isActive && urlStatus === 'ready' && !playbackFailed) {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, urlStatus, playbackFailed, player, isPhoto]);

  // Recommendation signals (Step 1, second pass) — REAL player-position-
  // based watch tracking for video Reels, replacing the earlier dwell-
  // time proxy (see ReelFeed.tsx's git history for that earlier version).
  // `maxWatchedMsRef` accumulates the furthest real playback position
  // reached THIS viewing session (never wall-clock time); `playToEndRef`
  // counts how many times expo-video's own `playToEnd` event has fired
  // this session (it fires every loop, even with `player.loop = true`),
  // so a second full pass counts as a rewatch. Nothing here writes to
  // Firestore on every tick — these are local accumulators only; exactly
  // one summarized event is sent when this item stops being active (see
  // the isActive-keyed effect below, which reads these refs at cleanup
  // time). `hasStartedRef` guards trackVideoStarted so it fires at most
  // once per viewing session, never once per timeUpdate tick.
  const maxWatchedMsRef = useRef(0);
  const playToEndRef = useRef(0);
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (isPhoto) return;
    const timeSub = player.addListener('timeUpdate', ({ currentTime }) => {
      const currentMs = currentTime * 1000;
      if (currentMs > maxWatchedMsRef.current) maxWatchedMsRef.current = currentMs;
      if (!hasStartedRef.current && currentMs > 0) {
        hasStartedRef.current = true;
        if (user) {
          trackVideoStarted({
            userId: user.uid,
            contentId: reel.reelId,
            categoryId: reel.categoryId,
            creatorId: reel.authorUid,
            cityKey: reel.cityKey,
            countryCode: reel.countryCode,
          }).catch(() => {});
        }
      }
    });
    const endSub = player.addListener('playToEnd', () => {
      playToEndRef.current += 1;
    });
    return () => {
      timeSub.remove();
      endSub.remove();
    };
    // Deliberately keyed only on [player, isPhoto] — reel/user identifying
    // fields don't change for an already-mounted item, and re-subscribing
    // on every render would both leak listeners (a new one added before
    // the old is ever removed, since this effect wouldn't re-run to clean
    // up the previous one) and risk firing trackVideoStarted more than
    // once by resetting nothing here on purpose (that reset lives in the
    // isActive-keyed effect below, which owns the session boundary).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, isPhoto]);

  useEffect(() => {
    if (!isActive || !user) return;
    // Entering — reset THIS viewing session's accumulators. For a photo
    // Reel there is no player, so watch behavior falls back to dwell time
    // (the only signal available for a static image) captured via
    // `enteredAt` below.
    maxWatchedMsRef.current = 0;
    playToEndRef.current = 0;
    hasStartedRef.current = false;
    const enteredAt = Date.now();

    trackContentInteraction({
      userId: user.uid,
      contentId: reel.reelId,
      contentType: 'reel',
      action: 'impression',
      categoryId: reel.categoryId,
      creatorId: reel.authorUid,
      cityKey: reel.cityKey,
      countryCode: reel.countryCode,
      attribution,
      feedSessionId,
    }).catch(() => {});

    return () => {
      // Leaving — isActive flipped false, or this item unmounted while
      // still active (e.g. the feed itself was torn down). Reads the
      // refs' LATEST values, kept fresh by the listener effect above
      // regardless of this effect's own lifecycle.
      if (isPhoto) {
        const dwellMs = Date.now() - enteredAt;
        const durationMs = reel.durationMs > 0 ? reel.durationMs : Math.max(dwellMs, 1);
        trackReelWatchSummary({
          userId: user.uid,
          contentId: reel.reelId,
          categoryId: reel.categoryId,
          creatorId: reel.authorUid,
          cityKey: reel.cityKey,
          countryCode: reel.countryCode,
          watchDurationMs: dwellMs,
          videoDurationMs: durationMs,
          attribution,
          feedSessionId,
        }).catch(() => {});
        return;
      }
      // Prefer the player's own reported duration; fall back to the
      // Reel's declared durationMs only if playback never actually
      // loaded far enough to report one (e.g. a network failure).
      const videoDurationMs = player.duration > 0 ? player.duration * 1000 : reel.durationMs;
      trackReelWatchSummary({
        userId: user.uid,
        contentId: reel.reelId,
        categoryId: reel.categoryId,
        creatorId: reel.authorUid,
        cityKey: reel.cityKey,
        countryCode: reel.countryCode,
        watchDurationMs: maxWatchedMsRef.current,
        videoDurationMs,
        isRewatch: playToEndRef.current >= 2,
        attribution,
        feedSessionId,
      }).catch(() => {});
    };
    // Deliberately excludes `attribution`/`feedSessionId` — this effect's
    // own boundary IS the viewing session (isActive true -> false), so it
    // must record the attribution snapshot captured at ENTRY for both the
    // impression and the eventual exit's watch summary. A parent re-render
    // that rebuilds the attribution map (e.g. loadMoreForYou appending a
    // page) gives every already-shown reel a structurally-equal but
    // referentially-new `attribution` object; reacting to that would tear
    // down and re-fire this effect mid-view, double-counting the
    // impression and truncating the watch summary already in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isPhoto, user, player, reel.reelId, reel.categoryId, reel.authorUid, reel.cityKey, reel.countryCode, reel.durationMs]);

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
    if (result.ok && user) {
      trackContentInteraction({
        userId: user.uid,
        contentId: reel.reelId,
        contentType: 'reel',
        action: 'share',
        categoryId: reel.categoryId,
        creatorId: reel.authorUid,
        cityKey: reel.cityKey,
        countryCode: reel.countryCode,
        attribution,
        feedSessionId,
      }).catch(() => {});
    }
    if (!result.ok && !/cancel/i.test(result.message)) {
      await Clipboard.setStringAsync(buildReelShareUrl(reel.reelId));
      onToast('Link copied');
    }
  };

  const categoryLabel = CATEGORY_LABEL_BY_ID.get(reel.categoryId);

  // Swipe left anywhere on the reel to jump to its author's profile — the
  // same "swipe to the person" gesture short-video apps generally offer,
  // in addition to the existing tap-the-avatar-or-name (AuthorLink) route.
  // Works on your own Reel too — /user/[uid] already renders correctly for
  // your own uid (an "This is you" badge, Edit profile instead of Follow/
  // Message), so there's no need to special-case it out. Only claims the
  // gesture once the drag is clearly horizontal, LEFTWARD, and past
  // SWIPE_TO_PROFILE_THRESHOLD — a rightward drag is deliberately left
  // unclaimed here (screens with their own back button use SwipeBackEdge
  // for that direction instead, from a dedicated left-edge hot zone rather
  // than "anywhere"; see reels.tsx and reel/[reelId].tsx), and a vertical
  // drag or a plain tap with no real movement falls through untouched to
  // the feed's own vertical paging and to the action buttons/AuthorLink
  // Pressables.
  const swipeResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) => gesture.dx < -20 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dx <= -SWIPE_TO_PROFILE_THRESHOLD) {
            router.push(`/user/${reel.authorUid}`);
          }
        },
      }),
    [reel.authorUid]
  );

  return (
    <View style={[styles.page, { height }]} {...swipeResponder.panHandlers}>
      {urlStatus === 'ready' && playbackUrl && !playbackFailed ? (
        isPhoto ? (
          <Image source={{ uri: playbackUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <VideoView
            style={StyleSheet.absoluteFill}
            player={player}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
          />
        )
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
          {hasActiveStory ? (
            // An active Story takes over the tap here — same trade as
            // FollowingAvatarRow's own ringed avatars (Inbox): the
            // author's Profile is still one tap away from their name
            // below (AuthorLink there is unaffected by any of this).
            <Pressable
              onPress={() => router.push(`/story/${reel.authorUid}`)}
              style={styles.actionAvatar}
              accessibilityRole="button"
              accessibilityLabel={isOwnReel ? 'Your Story' : `${reel.authorDisplayName}'s Story`}
            >
              <View style={isStoryUnseen ? styles.avatarRing : styles.avatarRingSeen}>
                <Avatar name={reel.authorDisplayName} photoURL={authorPhotoURL} size={40} />
              </View>
            </Pressable>
          ) : (
            <AuthorLink uid={reel.authorUid} style={styles.actionAvatar}>
              <Avatar name={reel.authorDisplayName} photoURL={authorPhotoURL} size={40} />
            </AuthorLink>
          )}
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

        {/* "Whose sound is this" — a photo has no audio at all, so this
            never renders for one (isPhoto below). For a video: opens
            SoundSheet either way (see this component's own doc comment
            and Reel.musicHash's own doc comment in src/types/reel.ts) —
            picked music with a resolved origin -> that origin account and
            every post sharing the sound, with real Save/Use-audio; no
            picked music -> this Reel's own author, "Original audio" —
            SoundSheet itself resolves that into the same real
            Save/Use-audio experience the first time anyone actually opens
            it (see resolveOwnSoundOrigin's own doc comment in
            functions/src/index.ts for why that's lazy, not automatic).
            Picked music with no resolved origin yet (shouldn't normally
            happen, but never fabricate an avatar) -> nothing rendered. */}
        {isPhoto ? null : reel.musicSourceType === 'none' ? (
          <Pressable
            onPress={() => setIsSoundSheetOpen(true)}
            style={styles.soundAvatarWrap}
            accessibilityRole="button"
            accessibilityLabel="Original audio"
          >
            <View style={styles.soundAvatar}>
              <Avatar name={reel.authorDisplayName} photoURL={authorPhotoURL} size={32} />
              <View style={styles.soundBadge}>
                <Ionicons name="musical-notes" size={10} color={Colors.text} />
              </View>
            </View>
          </Pressable>
        ) : soundOriginProfile ? (
          <Pressable
            onPress={() => setIsSoundSheetOpen(true)}
            style={styles.soundAvatarWrap}
            accessibilityRole="button"
            accessibilityLabel={`Sound by ${soundOriginProfile.displayName}`}
          >
            <View style={styles.soundAvatar}>
              <Avatar name={soundOriginProfile.displayName} photoURL={soundOriginProfile.photoURL} size={32} />
              <View style={styles.soundBadge}>
                <Ionicons name="musical-notes" size={10} color={Colors.text} />
              </View>
            </View>
          </Pressable>
        ) : null}
      </View>

      {/* isScreenFocused, not just isSoundSheetOpen alone — see
          isSoundSheetOpen's own doc comment above: this is what actually
          hides the Modal while a post tapped inside it is open
          full-screen, and reveals it again on the way back. */}
      {isPhoto ? null : (
        <SoundSheet visible={isSoundSheetOpen && isScreenFocused} reel={reel} onClose={() => setIsSoundSheetOpen(false)} onToast={onToast} />
      )}

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
    bottom: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.lg,
  },
  actionAvatarWrap: {
    alignItems: 'center',
  },
  actionAvatar: {
    alignItems: 'center',
  },
  // Same ring pair as FollowingAvatarRow (src/app/(app)/(tabs)/inbox.tsx),
  // just sized for this rail's smaller 40px avatar.
  avatarRing: {
    borderWidth: 2,
    borderColor: Colors.accent,
    borderRadius: 22,
    padding: 2,
  },
  avatarRingSeen: {
    borderWidth: 2,
    borderColor: Colors.textMuted,
    borderRadius: 22,
    padding: 2,
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
  soundAvatarWrap: {
    alignItems: 'center',
    marginTop: Spacing.xs,
  },
  soundAvatar: {
    position: 'relative',
  },
  soundBadge: {
    position: 'absolute',
    bottom: -3,
    right: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: Colors.surfaceElevated,
    borderWidth: 1,
    borderColor: Colors.background,
    alignItems: 'center',
    justifyContent: 'center',
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
