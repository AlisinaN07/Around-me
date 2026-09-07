import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Colors, Spacing } from '@/constants/theme';
import { setPendingSelectedVideo } from '@/services/reelCameraHandoff';
import { REEL_MAX_DURATION_MS, type SelectedReelVideo } from '@/types/reel';
import { resolveCameraVideoMetadata } from '@/utils/cameraVideoMetadata';
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
  // stage) still lets the user switch to the rear camera freely. expo-camera
  // (57.x) records the underlying file in its natural, non-mirrored
  // orientation regardless of which camera is active or how the live
  // preview renders it — no manual mirror/scaleX transform is applied
  // anywhere in this app, so front-camera recordings are never flipped in
  // the resulting Post.
  const [facing, setFacing] = useState<'front' | 'back'>('front');
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mountError, setMountError] = useState<string | null>(null);

  const [stage, setStage] = useState<Stage>('capture');
  const [video, setVideo] = useState<SelectedReelVideo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(true);

  const cameraRef = useRef<CameraView>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Muted by default — browser autoplay policy blocks unmuted autoplay,
  // and this is just a local preview before Next, not final playback.
  const player = useVideoPlayer(video?.uri ?? null, (p) => {
    p.loop = true;
    p.muted = true;
  });

  useEffect(() => {
    if (stage === 'preview' && video) {
      player.play();
      // Resets fresh whenever a new video is selected — same prop-driven-
      // reset pattern as ReportModal/ReelFeedItem.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsPreviewPlaying(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, video]);

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

  const handleRetake = () => {
    player.pause();
    setVideo(null);
    setError(null);
    setStage('capture');
  };

  const togglePreviewPlayback = () => {
    if (isPreviewPlaying) {
      player.pause();
    } else {
      player.play();
    }
    setIsPreviewPlaying((prev) => !prev);
  };

  const handleNext = () => {
    if (!video) return;
    setPendingSelectedVideo(video);
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
              <Button label="Next" onPress={handleNext} />
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
        mode="video"
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
          ) : null}
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
