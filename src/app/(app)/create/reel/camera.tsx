import { Ionicons } from '@expo/vector-icons';
import { useAudioPlayer } from 'expo-audio';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Colors, Spacing } from '@/constants/theme';
import { setPendingSelectedMusic, setPendingSelectedThumbnail, setPendingSelectedVideo } from '@/services/reelCameraHandoff';
import { REEL_MAX_DURATION_MS, type SelectedReelMusic, type SelectedReelThumbnail, type SelectedReelVideo } from '@/types/reel';
import { resolveAudioDurationMs } from '@/utils/audioMetadata';
import { resolveCameraVideoMetadata } from '@/utils/cameraVideoMetadata';
import { validateSelectedReelMusic } from '@/utils/reelMusicValidation';
import { generateReelThumbnailCandidates, type ReelThumbnailCandidate } from '@/utils/reelThumbnailCandidates';
import { validateSelectedReelVideo } from '@/utils/reelVideoValidation';

const MAX_DURATION_SECONDS = REEL_MAX_DURATION_MS / 1000;

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

  const [stage, setStage] = useState<Stage>('capture');
  const [video, setVideo] = useState<SelectedReelVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(true);

  // Device-picked background music (see the "Music" control below and
  // ReelMusicSourceType's doc comment in src/types/reel.ts). `null` means
  // no music — the camera's mic stays on (`mute={!!music}` below). Only
  // meaningful for camera recording, never for a library-picked video
  // (which already has its own audio) — cleared in handleChooseFromLibrary.
  const [music, setMusic] = useState<SelectedReelMusic | null>(null);
  const [isMusicLoading, setIsMusicLoading] = useState(false);

  // The real cover-frame image for this Post — always picked automatically
  // from the middle of the video (see reelThumbnailCandidates.ts), never by
  // the user. Generated silently in the background as soon as a video is
  // selected; if it isn't ready yet by the time Next is tapped,
  // handleNext generates it on demand instead of blocking on a picker UI.
  const [autoThumbnail, setAutoThumbnail] = useState<ReelThumbnailCandidate | null>(null);
  const [isPreparingNext, setIsPreparingNext] = useState(false);

  const cameraRef = useRef<CameraView>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const result = await cameraRef.current?.recordAsync({ maxDuration: MAX_DURATION_SECONDS });
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

  /**
   * Opens the system file picker restricted to audio, for the user's own
   * on-device music (see ReelMusicSourceType's doc comment in
   * src/types/reel.ts for the exact source model and its known iOS
   * limitation — this reaches the Files app, not the actual Apple Music
   * library). Picking a track mutes the camera's mic for the NEXT
   * recording (`mute={!!music}` below) — this never touches a take
   * already in progress.
   */
  const handlePickMusic = async () => {
    if (isRecording) return;
    setError(null);
    setIsMusicLoading(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({ type: 'audio/*', copyToCacheDirectory: true });
      if (result.canceled || result.assets.length === 0) return;

      const asset = result.assets[0];
      const mimeType = asset.mimeType ?? null;
      if (!mimeType || !mimeType.startsWith('audio/')) {
        setError('Choose an audio file.');
        return;
      }
      const fileSizeBytes = asset.size && asset.size > 0 ? asset.size : new File(asset.uri).size || 0;
      const durationMs = await resolveAudioDurationMs(asset.uri);

      const candidate: SelectedReelMusic = {
        uri: asset.uri,
        title: asset.name,
        fileSizeBytes,
        mimeType,
        durationMs,
      };

      const validation = validateSelectedReelMusic(candidate);
      if (!validation.ok) {
        setError(validation.message);
        return;
      }

      setMusic(candidate);
    } finally {
      setIsMusicLoading(false);
    }
  };

  const handleRemoveMusic = () => {
    musicPlayer.pause();
    setMusic(null);
  };

  const handleRetake = () => {
    player.pause();
    musicPlayer.pause();
    setVideo(null);
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
    if (!video || isPreparingNext) return;
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

  const bothGranted = !!cameraPermission?.granted && !!microphonePermission?.granted;
  const eitherDenied = permissionRequested && (cameraPermission?.granted === false || microphonePermission?.granted === false);

  if (stage === 'preview' && video) {
    return (
      <View style={styles.container}>
        <VideoView
          style={StyleSheet.absoluteFill}
          player={player}
          contentFit="cover"
          nativeControls={false}
          allowsPictureInPicture={false}
        />
        <SafeAreaView style={styles.overlay} pointerEvents="box-none">
          <View style={styles.topRow}>
            <Pressable onPress={handleRetake} hitSlop={12} accessibilityRole="button" accessibilityLabel="Back" style={styles.iconButton}>
              <Ionicons name="chevron-back" size={26} color={Colors.text} />
            </Pressable>
            <Pressable
              onPress={togglePreviewPlayback}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={isPreviewPlaying ? 'Pause preview' : 'Play preview'}
              style={styles.iconButton}
            >
              <Ionicons name={isPreviewPlaying ? 'pause' : 'play'} size={22} color={Colors.text} />
            </Pressable>
          </View>

          <View style={styles.previewBottomRow}>
            <Pressable style={styles.retakeButton} onPress={handleRetake} accessibilityRole="button">
              <Ionicons name="refresh" size={16} color={Colors.text} />
              <Text style={styles.retakeText}>{video.source === 'camera' ? 'Retake' : 'Choose another'}</Text>
            </Pressable>
            <View style={styles.nextButtonWrap}>
              <Button label="Next" onPress={handleNext} loading={isPreparingNext} />
            </View>
          </View>
        </SafeAreaView>
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
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing}
        mirror={facing === 'front'}
        mode="video"
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
                {formatDuration(elapsedMs)} / {formatDuration(REEL_MAX_DURATION_MS)}
              </Text>
            </View>
          ) : !music ? (
            <Pressable
              onPress={handlePickMusic}
              disabled={isMusicLoading}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel="Add music"
              style={styles.iconButton}
            >
              {isMusicLoading ? <ActivityIndicator size="small" color={Colors.text} /> : <Ionicons name="musical-notes-outline" size={22} color={Colors.text} />}
            </Pressable>
          ) : (
            <View style={styles.musicPill}>
              <Pressable onPress={handlePickMusic} disabled={isMusicLoading} style={styles.musicPillLabel} accessibilityRole="button" accessibilityLabel="Change music">
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

        <View style={styles.bottomRow}>
          <View style={styles.sideButtonSlot}>
            {!isRecording ? (
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
            onPress={isRecording ? handleStopRecording : handleStartRecording}
            disabled={!isCameraReady}
            accessibilityRole="button"
            accessibilityLabel={isRecording ? 'Stop recording' : 'Record'}
            style={[styles.recordButtonOuter, !isCameraReady && styles.recordButtonDisabled]}
          >
            <View style={isRecording ? styles.recordButtonInnerStop : styles.recordButtonInnerIdle} />
          </Pressable>

          <View style={styles.sideButtonSlot}>
            {!isRecording ? (
              <Pressable
                onPress={() => setFacing((prev) => (prev === 'back' ? 'front' : 'back'))}
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
});
