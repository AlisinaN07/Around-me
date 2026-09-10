/* eslint-disable react-hooks/refs, react-hooks/preserve-manual-memoization, react-hooks/immutability --
 * The pinch-to-zoom PanResponder below (see `pinchResponder`) reads/writes
 * refs inside its own callbacks — the only correct way to track a
 * gesture's start state across grant/move/release without re-rendering on
 * every pixel of finger movement. React Compiler's static analysis can't
 * prove this is safe, even though those callbacks only ever run later,
 * from real touch events, never during render. No other screen in this
 * app mixes PanResponder with cross-callback refs, so this file-level
 * disable is scoped to exactly the one place that needs it.
 *
 * react-hooks/immutability additionally covers `musicPlayer.loop = true`
 * (the "FOTO" mode + music preview effect) — expo-audio's useAudioPlayer
 * has no config-callback param to set `loop` at creation time the way
 * useVideoPlayer does (`useVideoPlayer(uri, (p) => { p.loop = true; })`
 * above), so mutating the returned player's own `loop` property after the
 * fact is the library's actual documented API for it, not a real bug. */
import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer } from 'expo-audio';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import { Button } from '@/components/Button';
import { SwipeBackEdge } from '@/components/SwipeBackEdge';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  setPendingSelectedMusic,
  setPendingSelectedPhoto,
  setPendingSelectedThumbnail,
  setPendingSelectedVideo,
  takePendingPreselectedSound,
} from '@/services/reelCameraHandoff';
import { createStoryDraft, discardStoryDraft, publishStory, uploadStoryMedia, type UploadStoryMediaHandle } from '@/services/stories';
import {
  REEL_MAX_DURATION_MS,
  type ReelMediaType,
  type SelectedReelMusic,
  type SelectedReelPhoto,
  type SelectedReelThumbnail,
  type SelectedReelVideo,
} from '@/types/reel';
import type { Story } from '@/types/story';
import { resolveCameraVideoMetadata } from '@/utils/cameraVideoMetadata';
import { generateReelThumbnailCandidates, type ReelThumbnailCandidate } from '@/utils/reelThumbnailCandidates';
import { validateSelectedReelVideo } from '@/utils/reelVideoValidation';

// The two selectable video recording lengths (Step: capture duration
// picker) — "60 s" is the app-wide REEL_MAX_DURATION_MS itself; "15 s" is
// just a shorter cap on the SAME recording, never a different Storage/
// validation path (both are well inside REEL_MAX_DURATION_MS, so nothing
// else needs to change to support a shorter one). A "10 min" option was
// considered and deliberately dropped — it would exceed this app's actual
// 60-second hard cap (REEL_MAX_DURATION_MS) and the Storage size limit
// that's sized around it; offering it without also raising those limits
// app-wide would just make recordings fail to validate afterward.
const RECORD_DURATION_OPTIONS_SECONDS = [15, REEL_MAX_DURATION_MS / 1000] as const;
const DEFAULT_RECORD_DURATION_SECONDS = REEL_MAX_DURATION_MS / 1000;

// One entry per capture-mode picker cell — "15 s" and "60 s" (video, a
// fixed max recording length each) then "FOTO" (a single still). Deliberately
// built with the two video lengths BEFORE "FOTO": with exactly 3 items,
// that puts the default ("60 s") in the middle cell, so the picker's
// initial scroll position (see DEFAULT_CAPTURE_MODE_INDEX below) already
// has the record button's real default mode centered over it, with no
// special-casing needed for "what's centered when nothing has been
// scrolled yet".
type CaptureModeItem = { key: string; label: string; mode: ReelMediaType; seconds?: number };
const CAPTURE_MODE_ITEMS: CaptureModeItem[] = [
  ...RECORD_DURATION_OPTIONS_SECONDS.map((seconds) => ({ key: `video-${seconds}`, label: `${seconds} s`, mode: 'video' as const, seconds })),
  { key: 'photo', label: 'FOTO', mode: 'photo' as const },
];
const DEFAULT_CAPTURE_MODE_INDEX = CAPTURE_MODE_ITEMS.findIndex((item) => item.mode === 'video' && item.seconds === DEFAULT_RECORD_DURATION_SECONDS);

// Fixed width per picker cell, used both to lay out each cell and to
// compute which one is centered — see the horizontal scroll picker below
// (captureModeRow/captureModeScroll). Deliberately a plain constant rather
// than measured at runtime: a horizontally-snapping picker needs every
// cell to be the exact same width for snapToInterval and the "index =
// round(scrollX / width)" math to agree with what's actually rendered.
const CAPTURE_MODE_ITEM_WIDTH = 76;

// "FOTO" mode WITH music only (see handleNext's own doc comment) — the
// width the captured photo is resized down to for its separately-uploaded
// cover thumbnail, comfortably under REEL_THUMBNAIL_MAX_FILE_SIZE_BYTES.
// The full-resolution photo itself is uploaded unresized to storagePath
// either way (see reels.ts's createReelDraft) — this only shrinks the
// derived cover copy, matching a normal video Reel's own small extracted-
// frame thumbnail.
const REEL_PHOTO_THUMBNAIL_WIDTH = 720;

// expo-camera's recordAsync() gives back only a local file:// URI, no
// content type — this maps its real extension to a real video MIME type.
// An unrecognized extension is rejected rather than guessed at (see
// validateSelectedReelVideo), never defaulted to a fabricated value.
const KNOWN_VIDEO_EXTENSIONS: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
};

function inferMimeTypeFromUri(uri: string): string | null {
  const match = /\.([a-zA-Z0-9]+)$/.exec(uri);
  const extension = match?.[1]?.toLowerCase();
  return extension ? (KNOWN_VIDEO_EXTENSIONS[extension] ?? null) : null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// The on-screen "1.0x"–"3.0x" range is our own app-level scale, not a
// hardware-verified one: expo-camera's `zoom` prop is only ever a 0-1
// fraction of "the device's own max zoom" (see its own doc comment in
// node_modules/expo-camera), and the library never exposes what that real
// maximum actually is in optical-multiplier terms — there is no API to ask
// "how much is 3.0x on THIS phone". ZOOM_FRACTION_AT_DISPLAY_MAX picks a
// deliberately modest slice of the device's own range for our "3.0x"
// ceiling (many phones' true zoom=1 is an extreme, ugly digital zoom far
// past anything usable) — an interpretation we control, not a real
// measurement.
const ZOOM_DISPLAY_MIN = 1;
const ZOOM_DISPLAY_MAX = 3;
const ZOOM_FRACTION_AT_DISPLAY_MAX = 0.5;

// How much a full doubling of the pinch distance (fingers twice as far
// apart as when the gesture started) moves CameraView's own `zoom` value,
// within its now-capped [0, ZOOM_FRACTION_AT_DISPLAY_MAX] range. Scaled
// down alongside that cap so the FEEL stays just as low-sensitivity as
// before: a doubled pinch distance only moves zoom this much of its
// (smaller) usable range, so small, everyday pinch movements barely
// register at all and reaching 3.0x takes a real, sustained pinch.
const PINCH_ZOOM_SENSITIVITY = 0.075;

function pinchTouchDistance(touches: { pageX: number; pageY: number }[]): number {
  const [a, b] = touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

function zoomFractionToDisplayMultiplier(fraction: number): number {
  const progress = ZOOM_FRACTION_AT_DISPLAY_MAX > 0 ? fraction / ZOOM_FRACTION_AT_DISPLAY_MAX : 0;
  return ZOOM_DISPLAY_MIN + Math.min(1, Math.max(0, progress)) * (ZOOM_DISPLAY_MAX - ZOOM_DISPLAY_MIN);
}

type Stage = 'capture' | 'resolving' | 'preview';

/**
 * Post creation Stage 1 (capture/library) + Stage 2 (preview) — Step
 * 41.2D.1. Combined into one route/component because both stages share the
 * same "I don't have a video yet" vs. "I have a video, about to hand it
 * off" lifecycle, and because a video recorded here never needs to leave
 * this screen until the user actually taps Next — only then does Stage 3
 * (src/app/(app)/create/reel/index.tsx, caption + category + Post) get
 * pushed, via the one-shot handoff in reelCameraHandoff.ts.
 *
 * No filters, no editing controls (unchanged since Step 20). Camera video
 * recording is only implemented by expo-camera on Android/iOS (its web
 * `CameraView` ref exposes no record/stopRecording methods at all — only
 * picture capture), so the capture stage's record button and camera-flip
 * control are native-only; on web, this screen still offers the Library
 * button so Post creation is reachable there too.
 */
export default function CreateReelCameraScreen() {
  // Opts this whole component out of React Compiler's auto-memoization —
  // the pinch-to-zoom PanResponder below reads/writes refs inside its
  // callbacks (the only correct way to track a gesture's start state
  // across grant/move/release without re-rendering on every pixel of
  // finger movement), which the compiler's static analysis can't prove is
  // safe even though these callbacks only ever run later, from real touch
  // events, never during render. This is React Compiler's own documented
  // escape hatch for exactly this situation — no other screen in this app
  // needs it since none of them mix PanResponder with cross-callback refs.
  'use no memo';

  const { user } = useAuth();
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [permissionRequested, setPermissionRequested] = useState(false);
  // Front camera by default — selfie-first capture is the expected entry
  // state for Post creation; the flip control (bottom-right of the capture
  // stage) still lets the user switch to the rear camera freely.
  //
  // CameraView's `mirror` prop (below) is set to true only for the front
  // camera — without it, iOS mirrors the LIVE PREVIEW but saves the
  // recorded file un-mirrored by default, so what the user sees while
  // framing themselves doesn't match the finished Post (the previous
  // version of this comment claimed recordings were "never flipped" — that
  // was wrong for iOS, which is exactly the bug this prop fixes). Setting
  // `mirror` explicitly keeps the preview and the saved recording
  // consistent with each other on both iOS and Android.
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mountError, setMountError] = useState<string | null>(null);

  // The capture-mode row above the record button: a horizontally-scrolling
  // picker (see CAPTURE_MODE_ITEMS) — whichever cell is centered over the
  // record button is the active mode, exactly like a real camera app's
  // mode carousel. `captureModeIndex` is the only state; `captureMode`/
  // `recordDurationSeconds` below are just the currently-centered item's
  // fields, kept as plain derived consts so every other reference to them
  // elsewhere in this file didn't need to change. "60 s" (video) is the
  // default (unchanged behavior for everyone who never touches this row)
  // — recordDurationSeconds only matters while captureMode is 'video'.
  // Switching to 'photo' makes the record button go white (see its own
  // style below) and turns a tap into an immediate single-shot capture
  // (handleTakePicture) instead of the press-to-toggle-recording behavior
  // — see CameraView's own `mode` prop for the matching native switch
  // between video and still-picture capture.
  const [captureModeIndex, setCaptureModeIndex] = useState(DEFAULT_CAPTURE_MODE_INDEX);
  const activeCaptureModeItem = CAPTURE_MODE_ITEMS[captureModeIndex];
  const captureMode: ReelMediaType = activeCaptureModeItem.mode;
  const recordDurationSeconds = activeCaptureModeItem.seconds ?? DEFAULT_RECORD_DURATION_SECONDS;
  // True once the picker's ScrollView has laid out and been snapped to its
  // initial (default) scroll offset — see the picker's onLayout below.
  // Guards against re-applying that initial scrollTo on every re-render.
  const hasSetInitialCaptureModeScrollRef = useRef(false);
  const captureModeScrollRef = useRef<ScrollView>(null);
  const { width: windowWidth } = useWindowDimensions();

  // Shared by the picker's onScrollEndDrag AND onMomentumScrollEnd — both
  // are wired to this (see the picker below) because which one actually
  // fires, and with what final offset, differs by platform once
  // snapToInterval is involved (a drag that ends with ~zero residual
  // velocity can settle without ever firing a momentum event on some
  // platforms). Both computing the same "nearest cell" from whatever
  // offset they're given converges on the same correct index either way,
  // and calling setCaptureModeIndex again with an unchanged value is a
  // no-op re-render, not a bug.
  const handleCaptureModeScrollSettle = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const rawIndex = Math.round(event.nativeEvent.contentOffset.x / CAPTURE_MODE_ITEM_WIDTH);
    const clampedIndex = Math.max(0, Math.min(CAPTURE_MODE_ITEMS.length - 1, rawIndex));
    setCaptureModeIndex(clampedIndex);
  };

  // 0 (1.0x, not zoomed) to ZOOM_FRACTION_AT_DISPLAY_MAX (our own "3.0x"
  // ceiling) — CameraView's own `zoom` prop below. See
  // ZOOM_FRACTION_AT_DISPLAY_MAX's own comment for why 1.0x-3.0x is our own
  // app-level scale, not a hardware-verified one.
  const [zoom, setZoom] = useState(0);
  // Mirrors `zoom` for the PanResponder callbacks below to read without
  // needing to recreate the responder (and interrupt an in-progress pinch)
  // every time zoom itself changes.
  const zoomRef = useRef(0);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  // Set once per pinch, at the exact moment a second finger touches down —
  // the distance between the two fingers right then, and the zoom level at
  // that instant, both used to compute the relative change into a new zoom
  // value in onPanResponderMove below.
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);

  const [stage, setStage] = useState<Stage>('capture');
  const [video, setVideo] = useState<SelectedReelVideo | null>(null);
  // "FOTO" mode's counterpart to `video` — mutually exclusive with it (see
  // handleTakePicture/handleStartRecording, and pendingSelectedPhoto's own
  // doc comment in reelCameraHandoff.ts).
  const [photo, setPhoto] = useState<SelectedReelPhoto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(true);

  // Device-picked background music (see the music picker screen,
  // src/app/(app)/create/reel/music.tsx, and ReelMusicSourceType's doc
  // comment in src/types/reel.ts). `null` means no music — the camera's
  // mic stays on (`mute={!!music}` below). Only meaningful for camera
  // recording, never for a library-picked video (which already has its
  // own audio) — cleared in handleChooseFromLibrary.
  //
  // Populated via takePendingPreselectedSound() on every FOCUS, not just
  // first mount — see the effect below for why: this screen is already
  // mounted (never unmounted) when the music picker hands a sound back,
  // since it's a screen pushed ON TOP of this one, not a fresh entry into
  // it (unlike "Use audio" on the Sound sheet, src/components/SoundSheet.tsx,
  // which pushes into a not-yet-mounted camera screen from elsewhere in
  // the app — a focus effect covers both cases identically). Every
  // downstream step (mic muting, the synced preview player,
  // uploadReelMusicAudio at Stage 3) treats a pre-selected sound
  // identically to a freshly device-picked one either way.
  const [music, setMusic] = useState<SelectedReelMusic | null>(null);

  useFocusEffect(
    useCallback(() => {
      const pending = takePendingPreselectedSound();
      if (pending) setMusic(pending);
    }, [])
  );

  // The real cover-frame image for this Post — always picked automatically
  // from the middle of the video (see reelThumbnailCandidates.ts), never by
  // the user. Generated silently in the background as soon as a video is
  // selected; if it isn't ready yet by the time Next is tapped,
  // handleNext generates it on demand instead of blocking on a picker UI.
  const [autoThumbnail, setAutoThumbnail] = useState<ReelThumbnailCandidate | null>(null);
  const [isPreparingNext, setIsPreparingNext] = useState(false);

  // "Story" — the option beside "Next" on this same preview screen that
  // publishes the captured video/photo directly as an ephemeral, 24-hour,
  // followers-only Story (src/types/story.ts) instead of going through the
  // full caption/category Reel flow (Stage 3, create/reel/index.tsx).
  // There's no Stage 3 equivalent for a Story — publishing happens right
  // here, with its own small inline progress overlay below.
  const [isPublishingStory, setIsPublishingStory] = useState(false);
  const [storyUploadProgress, setStoryUploadProgress] = useState(0);
  const storyUploadHandleRef = useRef<UploadStoryMediaHandle | null>(null);
  const storyDraftRef = useRef<Story | null>(null);

  const cameraRef = useRef<CameraView>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Two-finger pinch-to-zoom over the live camera preview — created once
  // (not tied to `zoom` itself, which would recreate and interrupt this
  // mid-pinch every time it changes) and reads/writes zoom through the
  // refs above instead of through render-time values, so a gesture in
  // progress always sees the latest state without needing to be rebuilt.
  // React Compiler's static analysis can't prove a ref read inside a
  // factory callback like this is safe (these callbacks only ever run
  // later, from real touch events, never during render) — this is a real
  // compiler error, not just an eslint nag a disable comment can suppress
  // (see the "use no memo" directive at the top of this component, the
  // documented React Compiler opt-out for exactly this situation). Only
  // ever claims a gesture that already has TWO touches down, so it never
  // competes with the record button, the flip/music/back Pressables, or
  // SwipeBackEdge below (all single-finger).
  const pinchResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length === 2,
        onMoveShouldSetPanResponder: (event) => event.nativeEvent.touches.length === 2,
        onPanResponderGrant: (event) => {
          if (event.nativeEvent.touches.length !== 2) return;
          pinchStartRef.current = { distance: pinchTouchDistance(event.nativeEvent.touches), zoom: zoomRef.current };
        },
        onPanResponderMove: (event) => {
          const start = pinchStartRef.current;
          if (!start || event.nativeEvent.touches.length !== 2 || start.distance <= 0) return;
          const distance = pinchTouchDistance(event.nativeEvent.touches);
          const relativeChange = (distance - start.distance) / start.distance;
          const nextZoom = Math.min(ZOOM_FRACTION_AT_DISPLAY_MAX, Math.max(0, start.zoom + relativeChange * PINCH_ZOOM_SENSITIVITY));
          setZoom(nextZoom);
        },
        onPanResponderRelease: () => {
          pinchStartRef.current = null;
        },
        onPanResponderTerminate: () => {
          pinchStartRef.current = null;
        },
      }),
    []
  );

  // Muted by default — browser autoplay policy blocks unmuted autoplay,
  // and this is just a local preview before Next, not final playback.
  const player = useVideoPlayer(video?.uri ?? null, (p) => {
    p.loop = true;
    p.muted = true;
  });

  // Synced playback companion for `music`, LOCAL PREVIEW ONLY — the real
  // merge (muxReelMusic, functions/src/index.ts) hasn't run yet at this
  // point, so this is still two separately-played files here (unlike
  // every published-playback surface, which just plays the one real
  // merged file). Deliberately NOT `loop = true` on the music itself: the
  // track is almost always much longer than the recorded video, so
  // letting it free-loop on its own natural length would drift out of
  // sync with the video's own (much shorter) loop almost immediately —
  // it would just keep playing underneath, never stopping in step with
  // the video, exactly the bug this avoids. Instead the video's own
  // `playToEnd` event (below) explicitly restarts the music every time
  // the video itself loops, so the two stay aligned the same way the
  // final merged file is aligned (see muxReelMusic's own `-shortest`
  // doc comment).
  const musicPlayer = useAudioPlayer(music?.uri ?? null);

  useEffect(() => {
    const subscription = player.addListener('playToEnd', () => {
      if (music) {
        musicPlayer.seekTo(0);
        musicPlayer.play();
      }
    });
    return () => subscription.remove();
  }, [player, music, musicPlayer]);

  useEffect(() => {
    if (stage === 'preview' && video) {
      player.play();
      if (music) {
        musicPlayer.seekTo(0);
        musicPlayer.play();
      }
      // Resets fresh whenever a new video is selected — same prop-driven-
      // reset pattern as ReportModal/ReelFeedItem.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsPreviewPlaying(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, video]);

  // "FOTO" mode with music, LOCAL PREVIEW ONLY: there's no video's own
  // `playToEnd` event to restart the music in step with (a still photo
  // never "ends") — see the video effect just above and the `musicPlayer`
  // doc comment for that per-loop-restart mechanism. Simplest correct
  // preview here is just letting the track loop on its own natural length
  // instead. This has no bearing on the real published post either way:
  // renderPhotoToVideo (functions/src/index.ts) renders the actual
  // REEL_PHOTO_DURATION_MS-long output server-side from scratch.
  useEffect(() => {
    if (stage === 'preview' && photo && music) {
      musicPlayer.loop = true;
      musicPlayer.seekTo(0);
      musicPlayer.play();
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsPreviewPlaying(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, photo, music]);

  // Real cover-frame extraction — runs once per newly-selected video,
  // entirely in the background (no picker, no loading UI, nothing that
  // gates Next — see handleNext's own on-demand fallback for the case
  // where this hasn't resolved yet).
  useEffect(() => {
    if (!video || video.durationMs === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAutoThumbnail(null);
      return;
    }
    let cancelled = false;
    setAutoThumbnail(null);
    generateReelThumbnailCandidates(video.uri, video.durationMs).then((candidates) => {
      if (cancelled || candidates.length === 0) return;
      // The middle candidate is the video's ~50% mark — always the one
      // used, automatically, never a user choice.
      setAutoThumbnail(candidates[Math.floor(candidates.length / 2)]);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video?.uri]);

  // Requested only once this screen is actually reached — i.e. only after
  // the user tapped + (Personal) or Post (Business) — same minimum-
  // permissions rule as the Step 18/20 specs. Both camera and microphone
  // are requested together: expo-camera records audio by default
  // (`mute={false}`), and on iOS/Android that requires microphone access
  // up front, not something to discover mid-recording.
  useEffect(() => {
    // expo-camera's web CameraView exposes no record/stopRecording methods
    // at all (picture capture only) — recording is native-only, so web
    // never requests these permissions and instead only offers the
    // Library button below (see the web branch in the render).
    if (Platform.OS === 'web') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPermissionRequested(true);
      return;
    }
    (async () => {
      await Promise.all([requestCameraPermission(), requestMicrophonePermission()]);
      setPermissionRequested(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    };
  }, []);

  const handleStartRecording = async () => {
    if (!isCameraReady || isRecording) return;
    setIsRecording(true);
    setElapsedMs(0);
    elapsedTimerRef.current = setInterval(() => {
      setElapsedMs((prev) => prev + 200);
    }, 200);

    // Starts in sync with the camera's own recordAsync call just below —
    // the mic is already off for this take (CameraView's `mute` prop, set
    // from `!!music`), so this is the only audio being captured live by
    // the person recording, matching what they'll hear back later.
    if (music) {
      musicPlayer.seekTo(0);
      musicPlayer.play();
    }

    try {
      const result = await cameraRef.current?.recordAsync({ maxDuration: recordDurationSeconds });
      if (result?.uri) {
        await resolveAndPreviewCameraVideo(result.uri);
      }
    } catch {
      // Recording failed or was interrupted — stay on this screen so the
      // user can just try again, no local file to clean up (recordAsync
      // never resolved a uri).
    } finally {
      setIsRecording(false);
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
      if (music) {
        musicPlayer.pause();
        musicPlayer.seekTo(0);
      }
    }
  };

  const handleStopRecording = () => {
    cameraRef.current?.stopRecording();
  };

  // "FOTO" mode's single-tap shutter — a real still capture via
  // CameraView's own `mode="picture"` (set below), not a video frame grab.
  // expo-camera's takePictureAsync() already reports width/height/format
  // directly (unlike recordAsync(), nothing here needs a post-capture
  // probe), so this goes straight to the preview stage.
  const handleTakePicture = async () => {
    if (!isCameraReady) return;
    setError(null);
    try {
      const result = await cameraRef.current?.takePictureAsync();
      if (!result?.uri) {
        setError("Couldn't take this photo — try again.");
        return;
      }
      setPhoto({
        uri: result.uri,
        fileSizeBytes: new File(result.uri).size || null,
        width: result.width || null,
        height: result.height || null,
        mimeType: result.format === 'png' ? 'image/png' : 'image/jpeg',
      });
      setStage('preview');
    } catch {
      setError("Couldn't take this photo — try again.");
    }
  };

  const resolveAndPreviewCameraVideo = async (uri: string) => {
    setError(null);
    setStage('resolving');

    const mimeType = inferMimeTypeFromUri(uri);
    const fileSizeBytes = new File(uri).size || null;
    const metadata = await resolveCameraVideoMetadata(uri);

    const candidate: SelectedReelVideo = {
      uri,
      source: 'camera',
      fileSizeBytes,
      durationMs: metadata?.durationMs ?? null,
      width: metadata?.width ?? null,
      height: metadata?.height ?? null,
      mimeType,
    };

    const validation = validateSelectedReelVideo(candidate);
    if (!validation.ok) {
      setError(validation.message);
      setStage('capture');
      return;
    }
    setVideo(candidate);
    setStage('preview');
  };

  const handleChooseFromLibrary = async () => {
    setError(null);
    // A library-picked video already has its own audio track — music is
    // only ever meaningful for a fresh camera recording (see `music`'s own
    // doc comment above), so any prior pick is cleared here rather than
    // left as confusing latent state.
    setMusic(null);
    // Requested only when the user explicitly chooses a video — never on
    // screen mount (see the Step 18 spec's minimum-permissions rule).
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setError('Around Me needs access to your photo library to choose a video.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0];
    if (asset.type && asset.type !== 'video') {
      setError('Choose a video, not a photo.');
      return;
    }

    const candidate: SelectedReelVideo = {
      uri: asset.uri,
      source: 'library',
      fileSizeBytes: asset.fileSize && asset.fileSize > 0 ? asset.fileSize : null,
      durationMs: asset.duration && asset.duration > 0 ? asset.duration : null,
      width: asset.width || null,
      height: asset.height || null,
      mimeType: asset.mimeType ?? null,
    };

    const validation = validateSelectedReelVideo(candidate);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }

    setVideo(candidate);
    setStage('preview');
  };


  const handleRemoveMusic = () => {
    musicPlayer.pause();
    setMusic(null);
  };

  const handleRetake = () => {
    player.pause();
    musicPlayer.pause();
    setVideo(null);
    setPhoto(null);
    setError(null);
    setStage('capture');
  };

  const togglePreviewPlayback = () => {
    if (isPreviewPlaying) {
      player.pause();
      if (music) musicPlayer.pause();
    } else {
      player.play();
      if (music) musicPlayer.play();
    }
    setIsPreviewPlaying((prev) => !prev);
  };

  const handleNext = async () => {
    if (isPreparingNext) return;

    if (photo) {
      if (music) {
        // "FOTO" mode WITH music — this becomes a real 'video' Reel once
        // renderPhotoToVideo runs server-side (see
        // Reel.needsPhotoVideoRender's own doc comment), so — unlike the
        // plain no-music case just below — it needs a real, separately-
        // uploaded cover thumbnail, same as any other video Reel. The
        // photo itself already IS the cover's content; this just resizes
        // it down to a normal cover-image size so the uploaded thumbnail
        // object comfortably stays under the same 5 MB cap every other
        // video Reel's cover already respects (the full-resolution photo,
        // up to REEL_PHOTO_MAX_FILE_SIZE_BYTES, still goes to storagePath
        // itself unresized — see reels.ts's createReelDraft).
        setIsPreparingNext(true);
        try {
          const context = ImageManipulator.manipulate(photo.uri);
          const targetWidth = photo.width ? Math.min(REEL_PHOTO_THUMBNAIL_WIDTH, photo.width) : REEL_PHOTO_THUMBNAIL_WIDTH;
          context.resize({ width: targetWidth });
          const rendered = await context.renderAsync();
          const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.7 });
          const thumbnail: SelectedReelThumbnail = {
            uri: saved.uri,
            fileSizeBytes: new File(saved.uri).size || 0,
            mimeType: 'image/jpeg',
            width: saved.width,
            height: saved.height,
          };
          setPendingSelectedPhoto(photo);
          setPendingSelectedMusic(music);
          setPendingSelectedThumbnail(thumbnail);
          router.push('/create/reel');
        } catch {
          setError("Couldn't prepare this post's cover image — try again.");
        } finally {
          setIsPreparingNext(false);
        }
        return;
      }

      // Plain "FOTO" mode, no music — the photo already IS its own cover
      // image (see createReelDraft/Reel.thumbnailStoragePath's own doc
      // comment), so there's nothing else to prepare.
      setPendingSelectedPhoto(photo);
      router.push('/create/reel');
      return;
    }

    if (!video) return;
    // The background effect above almost always already has this ready by
    // the time Next is tapped — this is just a safety net for the rare
    // case it hasn't resolved yet, never a picker the user interacts with.
    let chosen = autoThumbnail;
    if (!chosen) {
      setIsPreparingNext(true);
      const candidates = await generateReelThumbnailCandidates(video.uri, video.durationMs ?? 0);
      chosen = candidates[Math.floor(candidates.length / 2)] ?? candidates[0] ?? null;
      setIsPreparingNext(false);
    }
    if (!chosen) {
      setError("Couldn't prepare this video's cover image — try again.");
      return;
    }
    const thumbnail: SelectedReelThumbnail = {
      uri: chosen.uri,
      fileSizeBytes: new File(chosen.uri).size || 0,
      // expo-video-thumbnails always produces a JPEG file — it has no
      // format option to request anything else (see its own .d.ts).
      mimeType: 'image/jpeg',
      width: chosen.width,
      height: chosen.height,
    };
    setPendingSelectedVideo(video);
    setPendingSelectedMusic(music);
    setPendingSelectedThumbnail(thumbnail);
    router.push('/create/reel');
  };

  // "Story" — publishes the exact same captured video/photo as a Story
  // instead of a Reel (see the state block above). No caption, no
  // category, no music, no cover thumbnail — a Story doesn't have any of
  // those (see src/types/story.ts) — so this uploads and publishes right
  // here on the preview screen rather than pushing to Stage 3.
  const handlePublishAsStory = async () => {
    if (isPublishingStory || isPreparingNext || !user) return;

    let mediaType: ReelMediaType;
    let localUri: string;
    let storageContentType: string;
    let fileSizeBytes: number;
    let durationMs: number;
    let width: number;
    let height: number;

    if (photo) {
      if (photo.fileSizeBytes === null || !photo.width || !photo.height || !photo.mimeType) {
        setError("Couldn't verify this photo's details — try again.");
        return;
      }
      mediaType = 'photo';
      localUri = photo.uri;
      storageContentType = photo.mimeType;
      fileSizeBytes = photo.fileSizeBytes;
      durationMs = 0;
      width = photo.width;
      height = photo.height;
    } else if (video) {
      if (video.fileSizeBytes === null || video.durationMs === null || !video.width || !video.height || !video.mimeType) {
        setError("Couldn't verify this video's details — try again.");
        return;
      }
      mediaType = 'video';
      localUri = video.uri;
      storageContentType = video.mimeType;
      fileSizeBytes = video.fileSizeBytes;
      durationMs = video.durationMs;
      width = video.width;
      height = video.height;
    } else {
      return;
    }

    setError(null);
    setIsPublishingStory(true);
    setStoryUploadProgress(0);

    const draftResult = await createStoryDraft({ uid: user.uid, mediaType, storageContentType, fileSizeBytes, durationMs, width, height });
    if (!draftResult.ok) {
      setError(draftResult.message);
      setIsPublishingStory(false);
      return;
    }
    storyDraftRef.current = draftResult.story;

    storyUploadHandleRef.current = uploadStoryMedia(
      draftResult.story,
      localUri,
      (percent) => setStoryUploadProgress(percent),
      async (uploadResult) => {
        storyUploadHandleRef.current = null;
        if (!uploadResult.ok) {
          await discardStoryDraft(draftResult.story.storyId, draftResult.story.storagePath);
          storyDraftRef.current = null;
          setIsPublishingStory(false);
          setError("Couldn't upload your Story.");
          return;
        }
        const publishResult = await publishStory(draftResult.story.storyId);
        if (!publishResult.ok) {
          await discardStoryDraft(draftResult.story.storyId, draftResult.story.storagePath);
          storyDraftRef.current = null;
          setIsPublishingStory(false);
          setError("Couldn't publish your Story.");
          return;
        }
        storyDraftRef.current = null;
        setIsPublishingStory(false);
        router.replace('/');
      }
    );
  };

  const handleCancelStoryUpload = async () => {
    storyUploadHandleRef.current?.cancel();
    storyUploadHandleRef.current = null;
    const draft = storyDraftRef.current;
    storyDraftRef.current = null;
    if (draft) {
      await discardStoryDraft(draft.storyId, draft.storagePath);
    }
    setIsPublishingStory(false);
    setStoryUploadProgress(0);
  };

  const bothGranted = !!cameraPermission?.granted && !!microphonePermission?.granted;
  const eitherDenied = permissionRequested && (cameraPermission?.granted === false || microphonePermission?.granted === false);

  if (stage === 'preview' && (video || photo)) {
    return (
      <View style={styles.container}>
        {/* This stage's chevron actually retakes rather than leaving the screen. */}
        <SwipeBackEdge onBack={handleRetake} />
        {photo ? (
          <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        ) : (
          <VideoView
            style={StyleSheet.absoluteFill}
            player={player}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
          />
        )}
        <SafeAreaView style={styles.overlay} pointerEvents="box-none">
          <View style={styles.topRow}>
            <Pressable onPress={handleRetake} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={styles.iconButton}>
              <Ionicons name="chevron-back" size={26} color={Colors.text} />
            </Pressable>
            {/* A still photo has nothing to play/pause. */}
            {video ? (
              <Pressable
                onPress={togglePreviewPlayback}
                hitSlop={12}
                accessibilityRole="button"
                accessibilityLabel={isPreviewPlaying ? 'Pause preview' : 'Play preview'}
                style={styles.iconButton}
              >
                <Ionicons name={isPreviewPlaying ? 'pause' : 'play'} size={22} color={Colors.text} />
              </Pressable>
            ) : (
              <View style={styles.iconButtonSpacer} />
            )}
          </View>

          {error ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>{error}</Text>
            </View>
          ) : null}

          <View style={styles.previewBottomRow}>
            <Pressable style={styles.retakeButton} onPress={handleRetake} accessibilityRole="button">
              <Ionicons name="refresh" size={16} color={Colors.text} />
              <Text style={styles.retakeText}>{photo || video?.source === 'camera' ? 'Retake' : 'Choose another'}</Text>
            </Pressable>
            <View style={styles.previewActionsRight}>
              {/* Publishes this exact video/photo directly as an ephemeral
                  24-hour Story instead — see handlePublishAsStory's own
                  doc comment. Deliberately "secondary" styling: "Next"
                  (the full Reel post flow) stays the primary action. */}
              <View style={styles.storyButtonWrap}>
                <Button label="Story" variant="secondary" onPress={handlePublishAsStory} disabled={isPreparingNext} />
              </View>
              <View style={styles.nextButtonWrap}>
                <Button label="Next" onPress={handleNext} loading={isPreparingNext} disabled={isPublishingStory} />
              </View>
            </View>
          </View>
        </SafeAreaView>

        {isPublishingStory ? (
          <View style={[StyleSheet.absoluteFill, styles.storyPublishOverlay]} pointerEvents="auto">
            <ActivityIndicator size="large" color={Colors.text} />
            <Text style={styles.storyPublishText}>Publishing Story… {storyUploadProgress}%</Text>
            <Pressable onPress={handleCancelStoryUpload} accessibilityRole="button" hitSlop={12}>
              <Text style={styles.storyPublishCancel}>Cancel</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  }

  if (stage === 'resolving') {
    return (
      <View style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator color={Colors.textSecondary} />
          <Text style={styles.deniedTitle}>Preparing your video…</Text>
        </View>
      </View>
    );
  }

  // Recording is native-only (see the permission-request effect above) —
  // web's capture stage is Library-only, no camera preview or record
  // button ever rendered, so there's nothing here that can silently fail.
  if (Platform.OS === 'web') {
    return (
      <SafeAreaView style={styles.safeArea}>
        <SwipeBackEdge onBack={() => router.back()} />
        <View style={styles.webTopRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={styles.webBackButton}>
            <Ionicons name="chevron-back" size={26} color={Colors.text} />
          </Pressable>
        </View>
        <View style={styles.centered}>
          <Ionicons name="videocam-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.deniedTitle}>Choose a video to share.</Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.deniedActions}>
            <Button label="Choose from library" onPress={handleChooseFromLibrary} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (!permissionRequested) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered} />
      </SafeAreaView>
    );
  }

  if (!bothGranted || eitherDenied) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <Ionicons name="videocam-off-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.deniedTitle}>Camera access is needed to record a post.</Text>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          <View style={styles.deniedActions}>
            <Button
              label="Try again"
              onPress={async () => {
                await Promise.all([requestCameraPermission(), requestMicrophonePermission()]);
              }}
            />
            <Button label="Choose from library" variant="secondary" onPress={handleChooseFromLibrary} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  if (mountError) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.deniedTitle}>Couldn&apos;t start the camera.</Text>
          <View style={styles.deniedActions}>
            <Button label="Choose from library" variant="secondary" onPress={handleChooseFromLibrary} />
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container} {...pinchResponder.panHandlers}>
      <SwipeBackEdge onBack={() => router.back()} />
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mirror={facing === 'front'}
        mode={captureMode === 'photo' ? 'picture' : 'video'}
        zoom={zoom}
        // Music selected -> mic off (the chosen track is the only audio
        // for this take); no music -> mic on, unchanged default. See
        // ReelMusicSourceType's doc comment in src/types/reel.ts.
        mute={!!music}
        onCameraReady={() => setIsCameraReady(true)}
        onMountError={(event) => setMountError(event.message)}
      />

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topRow}>
          <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={styles.iconButton}>
            <Ionicons name="chevron-back" size={26} color={Colors.text} />
          </Pressable>
          {isRecording ? (
            <View style={styles.durationPill}>
              <View style={styles.recordingDot} />
              <Text style={styles.durationText}>
                {formatDuration(elapsedMs)} / {formatDuration(recordDurationSeconds * 1000)}
              </Text>
            </View>
          ) : !music ? (
            <Pressable
              onPress={() => router.push('/create/reel/music')}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Add music"
              style={styles.iconButton}
            >
              <Ionicons name="musical-notes-outline" size={22} color={Colors.text} />
            </Pressable>
          ) : (
            <View style={styles.musicPill}>
              <Pressable
                onPress={() => router.push('/create/reel/music')}
                style={styles.musicPillLabel}
                accessibilityRole="button"
                accessibilityLabel="Change music"
              >
                <Ionicons name="musical-notes" size={14} color={Colors.text} />
                <Text style={styles.musicPillText} numberOfLines={1}>
                  {music.title}
                </Text>
              </Pressable>
              <Pressable onPress={handleRemoveMusic} hitSlop={8} accessibilityRole="button" accessibilityLabel="Remove music">
                <Ionicons name="close" size={16} color={Colors.text} />
              </Pressable>
            </View>
          )}
          <View style={styles.iconButtonSpacer} />
        </View>

        {error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{error}</Text>
          </View>
        ) : null}

        {/* Feedback for the pinch-to-zoom gesture on the CameraView above
            (see pinchResponder) — see ZOOM_FRACTION_AT_DISPLAY_MAX's own
            comment for why "1.0x"-"3.0x" is our own app-level scale, not a
            hardware-verified one. Shown once a pinch has moved it off
            1.0x, not just while actively pinching, so it still confirms
            the current level right after lifting your fingers. */}
        {zoom > 0 ? (
          <View style={styles.zoomPillWrap} pointerEvents="none">
            <View style={styles.zoomPill}>
              <Text style={styles.zoomPillText}>{zoomFractionToDisplayMultiplier(zoom).toFixed(1)}x</Text>
            </View>
          </View>
        ) : null}

        {/* Wrapped together with bottomRow (not a sibling of it) because
            the parent overlay uses justifyContent: 'space-between' —
            as a separate flow child, captureModeRow would get spaced
            evenly between topRow and bottomRow and land in the dead
            center of the screen instead of sitting right above the record
            button. Grouping them into one block keeps that block anchored
            to the bottom, with captureModeRow directly on top of bottomRow
            inside it. */}
        <View>
          {/* Capture-mode/duration row, directly above the record button —
              "60 s" / "15 s" (see RECORD_DURATION_OPTIONS_SECONDS) pick the
              max length of the NEXT video recording; "FOTO" switches the
              camera itself into still-picture mode (mode="picture" above),
              at which point the record button below turns white and a
              single tap takes one photo instead of starting a recording.
              Hidden entirely while actively recording, same as the side
              buttons. */}
          {!isRecording ? (
            <View style={styles.captureModeRow}>
              <ScrollView
                ref={captureModeScrollRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                snapToInterval={CAPTURE_MODE_ITEM_WIDTH}
                decelerationRate="fast"
                // Both wired to the same handler — see
                // handleCaptureModeScrollSettle's own doc comment for why.
                onScrollEndDrag={handleCaptureModeScrollSettle}
                onMomentumScrollEnd={handleCaptureModeScrollSettle}
                contentContainerStyle={{ paddingHorizontal: (windowWidth - CAPTURE_MODE_ITEM_WIDTH) / 2 }}
                onLayout={() => {
                  // Snaps to the default ("60 s") cell once, right after
                  // first layout — done imperatively via a ref rather than
                  // the ScrollView's own `contentOffset` prop, which isn't
                  // reliably applied before the initial layout pass on
                  // every platform.
                  if (hasSetInitialCaptureModeScrollRef.current) return;
                  hasSetInitialCaptureModeScrollRef.current = true;
                  captureModeScrollRef.current?.scrollTo({ x: DEFAULT_CAPTURE_MODE_INDEX * CAPTURE_MODE_ITEM_WIDTH, animated: false });
                }}
              >
                {CAPTURE_MODE_ITEMS.map((item, index) => (
                  <Pressable
                    key={item.key}
                    onPress={() => {
                      // Tapping a cell directly (not just scrolling to it)
                      // both selects it and scrolls it to center, so the
                      // marker below still lines up with the real
                      // selection afterward.
                      setCaptureModeIndex(index);
                      captureModeScrollRef.current?.scrollTo({ x: index * CAPTURE_MODE_ITEM_WIDTH, animated: true });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={item.mode === 'photo' ? 'Photo' : `${item.seconds} second video`}
                    accessibilityState={{ selected: index === captureModeIndex }}
                    style={styles.captureModeCell}
                  >
                    <Text style={[styles.captureModeChipText, index === captureModeIndex && styles.captureModeChipTextSelected]}>{item.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
              {/* Marks the exact center cell — directly above the record
                  button — so it's obvious which item scrolling will land
                  on even before anything moves. Purely visual: never
                  intercepts the scroll/tap gestures underneath it. */}
              <View style={styles.captureModeCenterMarker} pointerEvents="none" />
            </View>
          ) : null}

          <View style={styles.bottomRow}>
            <View style={styles.sideButtonSlot}>
              {!isRecording && captureMode !== 'photo' ? (
                <Pressable
                  onPress={handleChooseFromLibrary}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Choose from library"
                  style={styles.iconButton}
                >
                  <Ionicons name="images-outline" size={24} color={Colors.text} />
                </Pressable>
              ) : null}
            </View>

            <Pressable
              onPress={captureMode === 'photo' ? handleTakePicture : isRecording ? handleStopRecording : handleStartRecording}
              disabled={!isCameraReady}
              accessibilityRole="button"
              accessibilityLabel={captureMode === 'photo' ? 'Take photo' : isRecording ? 'Stop recording' : 'Record'}
              style={[styles.recordButtonOuter, !isCameraReady && styles.recordButtonDisabled]}
            >
              <View
                style={[
                  isRecording ? styles.recordButtonInnerStop : styles.recordButtonInnerIdle,
                  captureMode === 'photo' && styles.recordButtonInnerPhoto,
                ]}
              />
            </Pressable>

            <View style={styles.sideButtonSlot}>
              {!isRecording ? (
                <Pressable
                  onPress={() => {
                    setFacing((prev) => (prev === 'back' ? 'front' : 'back'));
                    // Front/back cameras have different real zoom ranges —
                    // same "start fresh on the new lens" behavior most
                    // camera apps use, rather than carrying over a
                    // fraction that may mean something completely
                    // different on the other one.
                    setZoom(0);
                  }}
                  hitSlop={12}
                  accessibilityRole="button"
                  accessibilityLabel="Switch camera"
                  style={styles.iconButton}
                >
                  <Ionicons name="camera-reverse-outline" size={26} color={Colors.text} />
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.md,
  },
  deniedTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  deniedActions: {
    width: '100%',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  webTopRow: {
    paddingHorizontal: Spacing.md,
  },
  webBackButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    justifyContent: 'space-between',
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingTop: Platform.OS === 'android' ? Spacing.md : 0,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
  },
  iconButtonSpacer: {
    width: 40,
    height: 40,
  },
  durationPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(11, 11, 15, 0.65)',
    borderRadius: 999,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
  },
  recordingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.error,
  },
  durationText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  musicPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
    backgroundColor: 'rgba(11, 11, 15, 0.65)',
    borderRadius: 999,
    paddingLeft: Spacing.md,
    paddingRight: Spacing.sm,
    paddingVertical: 6,
  },
  musicPillLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  musicPillText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
    flexShrink: 1,
  },
  errorBanner: {
    marginHorizontal: Spacing.xl,
    borderRadius: 12,
    backgroundColor: 'rgba(11, 11, 15, 0.75)',
    borderWidth: 1,
    borderColor: Colors.error,
    padding: Spacing.sm,
  },
  errorBannerText: {
    color: Colors.text,
    fontSize: 13,
    textAlign: 'center',
  },
  zoomPillWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 130,
    alignItems: 'center',
  },
  zoomPill: {
    backgroundColor: 'rgba(11, 11, 15, 0.65)',
    borderRadius: 999,
    paddingHorizontal: Spacing.md,
    paddingVertical: 6,
  },
  zoomPillText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  sideButtonSlot: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButtonOuter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: Colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recordButtonDisabled: {
    opacity: 0.4,
  },
  recordButtonInnerIdle: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: Colors.error,
  },
  recordButtonInnerStop: {
    width: 30,
    height: 30,
    borderRadius: 6,
    backgroundColor: Colors.error,
  },
  // "FOTO" mode's record-button fill — white, per "for foto the record
  // button become white". Layered on top of recordButtonInnerIdle/Stop's
  // own size/shape (never both idle+stop at once) purely to override
  // backgroundColor, so the shutter still reads as "a button", not red.
  recordButtonInnerPhoto: {
    backgroundColor: Colors.text,
  },
  captureModeRow: {
    height: 44,
    justifyContent: 'center',
    marginBottom: Spacing.lg,
  },
  // Fixed width, matching CAPTURE_MODE_ITEM_WIDTH exactly — see that
  // constant's own doc comment for why the two must always agree.
  captureModeCell: {
    width: CAPTURE_MODE_ITEM_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  captureModeChipText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  captureModeChipTextSelected: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '800',
  },
  // A small fixed dot under the screen's horizontal center — lines up with
  // whichever cell is currently centered in the ScrollView above (see
  // captureModeRow's contentContainerStyle padding, which centers cell 0
  // at scrollX 0 the same way this marker is centered in its parent).
  captureModeCenterMarker: {
    position: 'absolute',
    bottom: 2,
    left: '50%',
    marginLeft: -3,
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.text,
  },
  previewBottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
    gap: Spacing.md,
  },
  retakeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
    borderRadius: 999,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  retakeText: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '600',
  },
  nextButtonWrap: {
    minWidth: 120,
  },
  previewActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  storyButtonWrap: {
    minWidth: 90,
  },
  storyPublishOverlay: {
    backgroundColor: 'rgba(10, 10, 13, 0.75)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.md,
  },
  storyPublishText: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  storyPublishCancel: {
    color: Colors.error,
    fontSize: 14,
    fontWeight: '700',
  },
});
