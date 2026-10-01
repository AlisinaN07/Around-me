import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { Image } from 'expo-image';
import { router, useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, PanResponder, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import { AuthorLink } from '@/components/AuthorLink';
import { Avatar } from '@/components/Avatar';
import { HighlightedText } from '@/components/HighlightedText';
import { ReelCommentsSheet } from '@/components/ReelCommentsSheet';
import { SoundSheet } from '@/components/SoundSheet';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { INTERESTS } from '@/constants/interests';
import { useAuth } from '@/hooks/useAuth';
import { followUser, isFollowing } from '@/services/following';
import { fetchPublicProfile } from '@/services/publicProfile';
import { fetchReelCommentCount, fetchReelLikeCount, isReelLiked, likeReel, unlikeReel } from '@/services/reelEngagement';
import { trackContentInteraction, trackReelWatchSummary, trackVideoStarted } from '@/services/recommendations/interactions';
import { isReelPlaybackUrlCached, resolveReelThumbnailUrl, resolveReelVideoPlaybackUrl } from '@/services/reels';
import { isPostSaved, savePost, unsavePost } from '@/services/saved';
import { fetchActiveStoriesForAuthor, hasViewedStory } from '@/services/stories';
import type { Reel } from '@/types/reel';
import type { RankingAttribution } from '@/types/recommendation';
import type { PublicProfile } from '@/types/social';
import { prefetchImageOnce } from '@/utils/imagePrefetch';
import { recordReelActivation, recordReelPlaybackAborted, recordReelPlaybackCompletion } from '@/utils/reelPlaybackMetrics';
import {
  consumePendingStartup,
  determineStartupOutcome,
  isPrewarmedActivation,
  type PendingReelStartup,
  type PriorReelPreparationLevel,
} from '@/utils/reelPlaybackSessionState';
import type { ReelNetworkClass, ReelPreparationLevel } from '@/utils/reelPreparationPolicy';
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
  /**
   * Step 11E — the exact ReelPreparationLevel this item is at right now
   * (ReelFeed.tsx already computes this to derive `shouldPrepare` above —
   * passed through unchanged, never recomputed here). Used ONLY for dev
   * playback-measurement classification (prior-level/prewarmed context
   * below) — never for any player/render decision; `shouldPrepare`
   * remains the single source of truth for that, exactly as before this
   * step.
   */
  preparationLevel: ReelPreparationLevel;
  /**
   * Step 11E — the feed's one live `useReelNetworkClass()` value (see
   * ReelFeed.tsx), passed through so each dev playback-measurement record
   * can report the network class actually active during that attempt —
   * no second subscription is created here.
   */
  networkClass: ReelNetworkClass;
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
export function ReelFeedItem({
  reel,
  height,
  isActive,
  shouldPrepare,
  preparationLevel,
  networkClass,
  onOpenOptions,
  onToast,
  attribution,
  feedSessionId,
}: ReelFeedItemProps) {
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
  // Phase 3 perf pass — whether the player has actually reported a real
  // frame to show ('readyToPlay', set by the statusChange listener
  // below), as opposed to merely having a resolved playbackUrl. Gates the
  // thumbnail overlay's own hide condition in the render below: a
  // resolved URL alone doesn't mean the video has anything to actually
  // display yet (it can still be buffering its first frame), so the
  // thumbnail stays up until this is genuinely true. Reset alongside
  // urlStatus/playbackFailed everywhere they reset (this effect, retry)
  // since it describes the same playback attempt's lifecycle.
  const [isVideoReady, setIsVideoReady] = useState(false);
  // Phase 3 perf pass — a still cover frame shown instead of a blank/
  // black state while the real video above is still resolving its
  // playbackUrl and/or buffering its first frame (see the render below).
  // Never fetched for a photo Reel: its thumbnailStoragePath is the exact
  // same object as its own full image (see Reel.thumbnailStoragePath's
  // doc comment in src/types/reel.ts), so there's nothing distinct to
  // show early. Reuses the exact same shouldPrepare gate as playbackUrl
  // above — this never widens the existing prepare window — and the
  // exact same resolveReelPlaybackUrl cache (keyed by storagePath, the
  // same function ReelPreviewCard's own thumbnail already resolves
  // through), so an already-resolved thumbnail this session is an
  // instant cache hit, never a second real Storage metadata read.
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  // Step 11D — dev-only startup-latency measurement (see
  // src/utils/reelPlaybackMetrics.ts). `urlAssignedAtRef` is the
  // timestamp of the most recent successful playbackUrl resolution
  // below; `urlSourceRef` labels where that URL actually came from.
  // `urlAssignedAtRef` is consumed (reset to null) the first time the
  // player reports 'readyToPlay' after it's set, so a later, unrelated
  // statusChange (e.g. a brief re-buffer mid-playback) never re-measures
  // a stale "startup." Refs, not state: these are one-shot/latest-value
  // measurements with no UI to re-render for.
  const urlAssignedAtRef = useRef<number | null>(null);
  const urlSourceRef = useRef<'r2-persisted' | 'cache-hit' | 'cache-miss' | null>(null);
  // Step 11E — how long resolveReelVideoPlaybackUrl itself took for the
  // most recent resolution (Firestore/getDownloadURL time for a Firebase
  // Reel, a cache-hit's near-zero Map lookup, or an R2 Reel's synchronous
  // persisted-URL read) — measured separately from urlAssignedAtRef so a
  // slow URL resolution and a slow native buffer are never conflated into
  // one undifferentiated number. Never reset to null on consumption (an
  // aborted/prewarmed activation simply doesn't read it) — the NEXT
  // resolution effect run always overwrites it before it's read again.
  const urlResolutionMsRef = useRef<number | null>(null);
  // Mirrors the `isActive` prop for the statusChange listener below,
  // which is keyed only on `[player, isPhoto]` (re-subscribing on every
  // isActive change would leak listeners — see that effect's own doc
  // comment) — reading `isActive` directly there would use whatever
  // value was captured when the listener was ORIGINALLY attached, not
  // the current one, for a component instance that genuinely does
  // transition active -> inactive -> active again while staying mounted.
  const isActiveRef = useRef(isActive);
  // Step 11E — same "read the LATEST value inside a stable-keyed effect"
  // pattern as isActiveRef above, for the statusChange listener's own
  // completion record (that effect is also keyed only on [player,
  // isPhoto], never on networkClass — a network-class CHANGE mid-playback
  // must never tear down and recreate the player's own listener).
  const networkClassRef = useRef(networkClass);
  useEffect(() => {
    networkClassRef.current = networkClass;
  }, [networkClass]);
  // Step 11E — the latest ReelPreparationLevel this item held while NOT
  // 'active' — i.e. its level right before whatever activation is about
  // to happen. Read the instant isActive flips true, in the effect below.
  const priorLevelRef = useRef<PriorReelPreparationLevel>('cold');
  useEffect(() => {
    if (preparationLevel !== 'active') {
      priorLevelRef.current = preparationLevel;
    }
  }, [preparationLevel]);
  // Step 11E — the in-flight measurement for an activation that hasn't
  // reached readyToPlay yet. `null` whenever nothing is pending: no
  // activation has happened yet, the last one already completed or
  // aborted, or the most recent activation was PREWARMED and needed no
  // pending record at all (see isPrewarmedActivation).
  const pendingStartupRef = useRef<PendingReelStartup | null>(null);

  useEffect(() => {
    const wasActive = isActiveRef.current;
    isActiveRef.current = isActive;
    // Photos have no player/readyToPlay concept at all — Step 11E
    // instrumentation is video-only, same scope as Step 11D's own
    // startup metric (see this file's own isPhoto-gated effects below).
    if (isPhoto) return;
    if (isActive && !wasActive) {
      // A fresh activation — classify it, then either emit an immediate
      // PREWARMED completion (the player already reached readyToPlay
      // while merely warm, so there is nothing left to wait for — Step
      // 11D's own gap: this case previously produced NO record at all,
      // since readyToPlay had already fired once before activation) or
      // arm a pending record for the statusChange listener below to
      // complete once a real readyToPlay arrives.
      const { startupType } = recordReelActivation(reel.reelId);
      if (isPrewarmedActivation(priorLevelRef.current, isVideoReady)) {
        if (determineStartupOutcome({ reachedReady: true }) === 'completed') {
          recordReelPlaybackCompletion({
            reelId: reel.reelId,
            networkClass: networkClassRef.current,
            priorLevel: priorLevelRef.current,
            startupType,
            urlSource: urlSourceRef.current ?? 'cache-miss',
            urlResolutionMs: urlResolutionMsRef.current,
            sourceToReadyMs: null,
            activeToReadyMs: 0,
            prewarmed: true,
          });
        }
        pendingStartupRef.current = null;
      } else {
        pendingStartupRef.current = { activatedAt: Date.now(), priorLevel: priorLevelRef.current, startupType };
      }
    } else if (!isActive && wasActive && pendingStartupRef.current) {
      // Scrolled away before readyToPlay ever fired — an aborted
      // attempt, never a fake completed measurement (Step 11D's silent
      // drop here is now an explicit, logged, non-noisy dev event).
      if (determineStartupOutcome({ reachedReady: false }) === 'aborted') {
        recordReelPlaybackAborted(reel.reelId);
      }
      pendingStartupRef.current = null;
    }
    // Deliberately excludes networkClass/preparationLevel — both are read
    // via their own refs (networkClassRef/priorLevelRef) so a value
    // change that ISN'T an isActive/isVideoReady transition never
    // re-evaluates this activation logic; the ref-based wasActive
    // comparison above already makes any extra re-run (from isVideoReady
    // alone changing while isActive stays the same) a safe no-op in both
    // branches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isPhoto, isVideoReady, reel.reelId]);

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
      setIsVideoReady(false);
      // Step 11D — a pending startup measurement for a player that's
      // about to be released is no longer meaningful (there's nothing
      // left to report readyToPlay) — drop it rather than let a much
      // later re-entry into the warm window log a bogus, huge "startup."
      urlAssignedAtRef.current = null;
      urlSourceRef.current = null;
      // Step 11E — same reasoning, extended to the newer refs: a
      // released item's pending activation measurement and resolution
      // timing are both stale the moment it's out of the preload window.
      urlResolutionMsRef.current = null;
      pendingStartupRef.current = null;
      return;
    }
    // Resets fresh whenever the item's own reel (and therefore its
    // storagePath) changes — the same prop-driven-reset pattern already
    // used in ReportModal.
    setUrlStatus('loading');
    setIsVideoReady(false);
    // Step 11D — captured BEFORE the resolve call below, which is what
    // actually decides cache-hit vs cache-miss for a Firebase Reel (an R2
    // Reel never touches this cache at all — see
    // resolveReelVideoPlaybackUrl's own doc comment — so it's always
    // labeled 'r2-persisted', never a guess). Dev-only measurement, read
    // by the statusChange listener below.
    urlSourceRef.current = reel.storageProvider === 'r2' ? 'r2-persisted' : isReelPlaybackUrlCached(reel.storagePath) ? 'cache-hit' : 'cache-miss';
    // Step 11E — resolution-start timestamp for urlResolutionMs below;
    // deliberately a local variable, not a ref — this value is only ever
    // needed inside THIS specific `.then` callback, never read elsewhere.
    const resolutionStartedAt = Date.now();
    // Step 9A — branches on this Reel's OWN persisted storageProvider
    // (Firebase, resolved lazily via the same resolveReelPlaybackUrl
    // cache as before; or R2, already resolved at upload-confirm time) —
    // see resolveReelVideoPlaybackUrl's own doc comment.
    resolveReelVideoPlaybackUrl(reel).then((url) => {
      if (cancelled) return;
      if (url) {
        // Step 11E — how long THIS resolution actually took — a cheap
        // cache-hit/R2-persisted read measures near-zero here, a real
        // Firebase getDownloadURL measures its real network round trip.
        urlResolutionMsRef.current = Date.now() - resolutionStartedAt;
        // Step 11D — the moment a real source is about to be handed to
        // the player (see useVideoPlayer below) — this IS "source
        // assigned," the start of the startup-latency window the
        // statusChange listener's own 'readyToPlay' branch measures to.
        urlAssignedAtRef.current = Date.now();
        setPlaybackUrl(url);
        setUrlStatus('ready');
      } else {
        setUrlStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reel.storagePath, reel.storageProvider, reel.sourceUrl, shouldPrepare]);

  // Phase 3 perf pass — see thumbnailUrl's own doc comment above. Gated
  // on the exact same shouldPrepare window as playbackUrl (never resolved
  // for an item outside it — this doesn't widen that window at all), and
  // skipped entirely for a photo Reel (nothing distinct to show early —
  // see thumbnailUrl's own doc comment). A successfully-resolved
  // thumbnail is also prefetched (Image.prefetch, deduped in-session by
  // prefetchImageOnce) so it's already warm in RN's own image cache by
  // the time the render below actually mounts an <Image> for it — most
  // useful for the neighbor this item becomes just before it's scrolled
  // to, exactly like playbackUrl's own preload window already does for
  // video.
  useEffect(() => {
    let cancelled = false;
    if (isPhoto || !shouldPrepare) {
      // Out of the preload window, or nothing distinct to preload — same
      // prop-driven-reset pattern as playbackUrl above.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setThumbnailUrl(null);
      setThumbnailFailed(false);
      return;
    }
    // Step 5E — branches on this Reel's OWN persisted
    // thumbnailStorageProvider (Firebase, resolved lazily via the same
    // resolveReelPlaybackUrl cache as before; or R2, already resolved at
    // upload time) — see resolveReelThumbnailUrl's own doc comment.
    resolveReelThumbnailUrl(reel).then((url) => {
      if (cancelled) return;
      setThumbnailUrl(url);
      if (url) prefetchImageOnce(url);
    });
    return () => {
      cancelled = true;
    };
  }, [reel.thumbnailStoragePath, reel.thumbnailStorageProvider, reel.thumbnailUrl, shouldPrepare, isPhoto]);

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
      if (cancelled) return;
      setAuthorPhotoURL(authorProfile?.photoURL ?? '');
      // Phase 3 perf pass — reuses the Phase 2 public-profile cache above
      // (no extra Firestore read just for this); only warms RN's own
      // image cache for a photo it already has in hand.
      prefetchImageOnce(authorProfile?.photoURL);
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
      if (cancelled) return;
      setSoundOriginProfile(profile);
      // Phase 3 perf pass — same reasoning as authorPhotoURL's own
      // prefetch above.
      prefetchImageOnce(profile?.photoURL);
    });
    return () => {
      cancelled = true;
    };
  }, [reel.musicSourceType, reel.soundOriginAuthorUid]);

  // Step 11A perf audit — `useCaching: true` opts this source into
  // expo-video's own native disk cache (AVFoundation resource-loader
  // cache on iOS, ExoPlayer SimpleCache on Android — see
  // VideoPlayer.types.d.ts; default is `false`, which this codebase had
  // never overridden). This directly targets the audited root cause of
  // the reported "scroll down ~2, scroll back, previous Reel reloads"
  // behavior: shouldPrepare (above) deliberately releases this item's
  // player — and therefore its in-memory buffer — once it's more than one
  // position from active, to keep concurrent players/buffers bounded
  // regardless of feed length; without a BYTE-level cache, recreating the
  // player on return had no choice but a full fresh network fetch of
  // identical bytes. The native cache lives independently of any single
  // player instance, so it survives exactly that release/recreate cycle.
  // Safe to pass a fresh object literal on every render: useVideoPlayer's
  // own source-change detection keys on `JSON.stringify(source)` (see
  // expo-video's VideoPlayer.tsx), not reference identity, so this never
  // adds a render-driven player re-creation that didn't already happen
  // for the same `playbackUrl` string before this change. Plain MP4,
  // never HLS/DRM, so none of `useCaching`'s documented platform
  // limitations apply here. The cache's own size is bounded app-wide by
  // setVideoCacheSizeAsync (see src/app/_layout.tsx).
  const player = useVideoPlayer(isPhoto ? null : playbackUrl ? { uri: playbackUrl, useCaching: true } : null, (p) => {
    // Deliberately NOT p.loop = true on native — on iOS/Android, expo-
    // video's own native loop visibly flashes black for a frame or two at
    // the loop point (it appears to fully reset the player item rather
    // than just seeking back within the same one). Looping manually
    // instead — see the `playToEnd` listener below, which calls
    // player.replay() (a lightweight seek-to-0 on the SAME already-
    // buffered player, not a re-init) followed by player.play() — is the
    // documented, lower-overhead way to loop and reads as seamless on
    // real devices.
    //
    // On web this is the OPPOSITE: expo-video's web build backs this with
    // a plain HTML5 <video>, and manually replaying via replay()+play()
    // on 'playToEnd' measured a very visible ~0.4-0.9s freeze at both the
    // end and the restart of every loop (confirmed live: currentTime sits
    // pinned at duration, then pinned at 0, before resuming) — far worse
    // than the native black-flash this was written to avoid. The
    // browser's own native <video loop> attribute already loops
    // perfectly seamlessly with zero JS involvement, so web keeps using
    // it exactly as before this fix existed.
    p.loop = Platform.OS === 'web';
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
      // Phase 3 perf pass — drives the thumbnail overlay's own hide
      // condition in the render below: only a real 'readyToPlay' means
      // the video actually has a frame to show, at which point the
      // thumbnail (shown instead of a blank state up to now) is no
      // longer needed. See isVideoReady's own doc comment above.
      setIsVideoReady(playerStatus === 'readyToPlay');
      // Step 11E — completes the PENDING activation measurement armed by
      // the activation-tracking effect above, exactly once per activation
      // (consumePendingStartup finds `pending` already cleared on any
      // later re-buffer's own 'readyToPlay', so that never double-logs —
      // see src/utils/reelPlaybackSessionState.ts). A readyToPlay that
      // fires with nothing pending (a WARM player finishing its buffer
      // while not yet active, or a rebuffer after this activation already
      // completed) is correctly a silent no-op: Step 11D's own gap here
      // (logging every readyToPlay regardless of activation) is what Step
      // 11E's whole redesign replaces.
      if (playerStatus === 'readyToPlay') {
        const pending = pendingStartupRef.current;
        const { shouldRecord } = consumePendingStartup(pending);
        if (shouldRecord && pending && determineStartupOutcome({ reachedReady: true }) === 'completed') {
          const now = Date.now();
          recordReelPlaybackCompletion({
            reelId: reel.reelId,
            networkClass: networkClassRef.current,
            priorLevel: pending.priorLevel,
            startupType: pending.startupType,
            urlSource: urlSourceRef.current ?? 'cache-miss',
            urlResolutionMs: urlResolutionMsRef.current,
            sourceToReadyMs: urlAssignedAtRef.current !== null ? now - urlAssignedAtRef.current : null,
            activeToReadyMs: now - pending.activatedAt,
            prewarmed: false,
          });
          pendingStartupRef.current = null;
        }
        // Consumed regardless of whether a pending record existed — same
        // one-shot-per-resolved-URL reasoning as Step 11D.
        urlAssignedAtRef.current = null;
      }
    });
    return () => {
      // Same native-player-already-released race as the watch-summary
      // effect's duration read further down this file — on unmount,
      // useVideoPlayer's own release effect can clean up before this
      // one, making `.remove()` throw. try/catch keeps that harmless: a
      // released player has no listeners left to worry about anyway.
      try {
        subscription.remove();
      } catch {
        // Player already released — nothing left to unsubscribe from.
      }
    };
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
  // counts how many times `playToEnd` has fired this session — once per
  // loop. On native, the player has no native loop (see useVideoPlayer's
  // own setup above) and this listener is what actually triggers every
  // subsequent loop; on web, `playToEnd` still fires once per loop
  // alongside the browser's own native <video loop> (expo-video's own
  // event, independent of the loop attribute) — either way a second full
  // pass still counts as a rewatch exactly as before. Nothing here writes to
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
      // Manual loop — NATIVE ONLY. See useVideoPlayer's own setup above
      // for why native keeps p.loop=false and loops via replay()+play()
      // instead. On web, `playToEnd` still fires once per loop even
      // though p.loop=true already handles the actual looping on its own
      // (confirmed live) — calling replay()/play() again here on top of
      // that measured a very visible ~0.5-0.9s freeze at both the end and
      // restart of every loop (this call fighting the browser's own
      // already-in-progress native loop), so web must skip this entirely
      // and let the native <video loop> attribute do the whole job.
      if (Platform.OS !== 'web') {
        player.replay();
        player.play();
      }
    });
    return () => {
      // Same native-player-already-released race as the statusChange
      // listener's cleanup above — try/catch per subscription so one
      // already-gone listener never stops the other from unsubscribing.
      try {
        timeSub.remove();
      } catch {
        // Player already released — nothing left to unsubscribe from.
      }
      try {
        endSub.remove();
      } catch {
        // Player already released — nothing left to unsubscribe from.
      }
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
      hashtags: reel.hashtags,
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
          hashtags: reel.hashtags,
          watchDurationMs: dwellMs,
          videoDurationMs: durationMs,
          attribution,
          feedSessionId,
        }).catch(() => {});
        return;
      }
      // Prefer the player's own reported duration; fall back to the
      // Reel's declared durationMs if playback never actually loaded far
      // enough to report one (e.g. a network failure) OR if the native
      // player is already gone by the time this runs: on unmount,
      // useVideoPlayer's own internal release effect (registered earlier
      // in this component's hook order — see expo-video's
      // useReleasingSharedObjectWithLifecycle) cleans up BEFORE this
      // effect's cleanup, since React fires effect cleanups in
      // declaration order. Reading a property off an already-released
      // player then throws a native "NotFoundException: Unable to find
      // the native shared object" that crashes the whole screen (repro:
      // navigate away from Home and back while a Reel is still mounted)
      // — try/catch is the only way to read it safely here.
      let videoDurationMs = reel.durationMs;
      try {
        if (player.duration > 0) {
          videoDurationMs = player.duration * 1000;
        }
      } catch {
        // Player already released — reel.durationMs above is the only
        // duration left to report.
      }
      trackReelWatchSummary({
        userId: user.uid,
        contentId: reel.reelId,
        categoryId: reel.categoryId,
        creatorId: reel.authorUid,
        cityKey: reel.cityKey,
        countryCode: reel.countryCode,
        hashtags: reel.hashtags,
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
    setIsVideoReady(false);
    // Step 11D/11E — same measurement capture as the main resolution
    // effect above. Deliberately does NOT re-arm pendingStartupRef: a
    // manual retry is the SAME viewing session/activation, not a new
    // scroll-to-this-Reel event, so it must never call
    // recordReelActivation again (that would inflate activationCount and
    // skew first-view/scroll-back classification). Its sourceToReadyMs is
    // still captured in the refs below, but — same as any other
    // non-activation-triggered readyToPlay (e.g. a plain WARM buffer
    // completing) — it simply produces no completion record, consistent
    // with every other call site's "completion records are
    // activation-triggered only" rule.
    urlSourceRef.current = reel.storageProvider === 'r2' ? 'r2-persisted' : isReelPlaybackUrlCached(reel.storagePath) ? 'cache-hit' : 'cache-miss';
    const resolutionStartedAt = Date.now();
    resolveReelVideoPlaybackUrl(reel).then((url) => {
      if (url) {
        urlResolutionMsRef.current = Date.now() - resolutionStartedAt;
        urlAssignedAtRef.current = Date.now();
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
        hashtags: reel.hashtags,
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
          // Perf pass — expo-image, memory+disk cached: a "FOTO" Reel's
          // own resolved media URL, same reuse-on-revisit win as the
          // thumbnail overlay below. Video Reels are untouched — this
          // branch only ever renders for mediaType === 'photo'.
          <Image source={{ uri: playbackUrl }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
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

      {/* Phase 3 perf pass — the real cover frame instead of the plain
          fallback background/spinner above while the video is still
          resolving its URL and/or buffering its first frame. Sits on top
          (absolute, after the block above in paint order) so it's what's
          actually visible regardless of what the fallback/still-buffering
          video surface underneath looks like, and disappears the instant
          isVideoReady flips true. Never shown for a photo Reel (see
          thumbnailUrl's own doc comment), never once the thumbnail image
          itself failed to load (thumbnailFailed — degrades to exactly the
          fallback above, untouched), and never over a genuine playback
          error (playbackFailed) — that error/Retry UI must stay visible,
          not be hidden behind a static image forever. */}
      {!isPhoto && thumbnailUrl && !thumbnailFailed && !isVideoReady && !playbackFailed ? (
        // Perf pass — expo-image, memory+disk cached: this exact cover
        // frame is what gets re-shown every time the viewer scrolls back
        // to this Reel while its real video is still resolving/buffering
        // — a cache hit here means it appears with zero flash instead of
        // waiting on a fresh network fetch each time.
        <Image
          source={{ uri: thumbnailUrl }}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          cachePolicy="memory-disk"
          onError={() => setThumbnailFailed(true)}
        />
      ) : null}

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

        {reel.caption ? (
          <HighlightedText text={reel.caption} style={styles.caption} hashtagStyle={styles.captionHashtag} />
        ) : null}

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
  captionHashtag: {
    color: Colors.accent,
    fontWeight: '700',
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
