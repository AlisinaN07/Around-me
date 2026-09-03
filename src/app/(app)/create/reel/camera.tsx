import { Ionicons } from '@expo/vector-icons';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Colors, Spacing } from '@/constants/theme';
import { setPendingRecordedVideoUri } from '@/services/reelCameraHandoff';
import { REEL_MAX_DURATION_MS } from '@/types/reel';

const MAX_DURATION_SECONDS = REEL_MAX_DURATION_MS / 1000;

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Focused recording experience — no filters, no editing controls (see the
 * Step 20 spec). Camera video recording is only implemented by expo-camera
 * on Android/iOS (its web `CameraView` ref exposes no record/stopRecording
 * methods at all — only picture capture), so this route is native-only;
 * see the entry screen (index.tsx) for why "Record video" is hidden on web
 * instead of being offered and failing here.
 */
export default function CreateReelCameraScreen() {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [permissionRequested, setPermissionRequested] = useState(false);
  const [facing, setFacing] = useState<'front' | 'back'>('back');
  const [isCameraReady, setIsCameraReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [mountError, setMountError] = useState<string | null>(null);

  const cameraRef = useRef<CameraView>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Requested only once this screen is actually reached — i.e. only after
  // the user explicitly tapped "Record video" on the entry screen (see the
  // Step 20 spec's minimum-permissions rule, same pattern as the Step 18
  // media-library permission). Both camera and microphone are requested
  // together here: expo-camera records audio by default (`mute={false}`),
  // and on iOS/Android that requires microphone access up front, not
  // something to discover mid-recording.
  useEffect(() => {
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
        setPendingRecordedVideoUri(result.uri);
        router.back();
        return;
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

  const bothGranted = !!cameraPermission?.granted && !!microphonePermission?.granted;
  const eitherDenied = permissionRequested && (cameraPermission?.granted === false || microphonePermission?.granted === false);

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
          <Text style={styles.deniedTitle}>Camera access is needed to record a Reel.</Text>
          <View style={styles.deniedActions}>
            <Button
              label="Try again"
              onPress={async () => {
                await Promise.all([requestCameraPermission(), requestMicrophonePermission()]);
              }}
            />
            <Button label="Choose from library" variant="secondary" onPress={() => router.back()} />
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
            <Button label="Choose from library" variant="secondary" onPress={() => router.back()} />
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

        <View style={styles.bottomRow}>
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

          <Pressable
            onPress={isRecording ? handleStopRecording : handleStartRecording}
            disabled={!isCameraReady}
            accessibilityRole="button"
            accessibilityLabel={isRecording ? 'Stop recording' : 'Record'}
            style={[styles.recordButtonOuter, !isCameraReady && styles.recordButtonDisabled]}
          >
            <View style={isRecording ? styles.recordButtonInnerStop : styles.recordButtonInnerIdle} />
          </Pressable>

          <View style={styles.sideButtonSlot} />
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
  deniedActions: {
    width: '100%',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
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
});
