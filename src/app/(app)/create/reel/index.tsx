import { Ionicons } from '@expo/vector-icons';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { router, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { FormField } from '@/components/FormField';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, IconSize, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  createReelDraft,
  discardReelDraft,
  publishReel,
  uploadReelVideo,
  type UploadReelVideoHandle,
} from '@/services/reels';
import { takePendingRecordedVideoUri } from '@/services/reelCameraHandoff';
import { REEL_CAPTION_MAX_LENGTH, type Reel, type SelectedReelVideo } from '@/types/reel';
import { resolveCameraVideoMetadata } from '@/utils/cameraVideoMetadata';
import { validateSelectedReelVideo } from '@/utils/reelVideoValidation';

type Stage = 'pick' | 'ready' | 'creating' | 'uploading' | 'publishing';

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

export default function CreateReelScreen() {
  const { user } = useAuth();
  const [video, setVideo] = useState<SelectedReelVideo | null>(null);
  const [isResolvingCameraVideo, setIsResolvingCameraVideo] = useState(false);
  const [caption, setCaption] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('pick');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);
  const [isPreviewPlaying, setIsPreviewPlaying] = useState(true);

  const uploadHandleRef = useRef<UploadReelVideoHandle | null>(null);
  const draftRef = useRef<Reel | null>(null);

  // Muted by default — browser autoplay policy blocks unmuted autoplay,
  // and this is just a local preview before publish, not final playback.
  const player = useVideoPlayer(video?.uri ?? null, (p) => {
    p.loop = true;
    p.muted = true;
  });

  useEffect(() => {
    if (video) {
      player.play();
      // Resets fresh whenever a new video is selected — same prop-driven-
      // reset pattern as ReportModal/ReelFeedItem.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsPreviewPlaying(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  const isBusy = stage === 'creating' || stage === 'uploading' || stage === 'publishing';

  // Picks up a just-recorded video handed off from the camera route (see
  // src/services/reelCameraHandoff.ts) whenever this screen regains focus
  // — covers both "recorded successfully, came back" and "backed out of
  // the camera with nothing recorded" (nothing to pick up in that case).
  useFocusEffect(
    useCallback(() => {
      const uri = takePendingRecordedVideoUri();
      if (!uri) return;

      let cancelled = false;
      setError(null);
      setIsResolvingCameraVideo(true);

      (async () => {
        const mimeType = inferMimeTypeFromUri(uri);
        const fileSizeBytes = new File(uri).size || null;
        const metadata = await resolveCameraVideoMetadata(uri);
        if (cancelled) return;

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
        setIsResolvingCameraVideo(false);
        if (!validation.ok) {
          setError(validation.message);
          return;
        }
        setVideo(candidate);
        setStage('ready');
      })();

      return () => {
        cancelled = true;
      };
    }, [])
  );

  const handleRecordVideo = () => {
    setError(null);
    router.push('/create/reel/camera');
  };

  const handleChooseVideo = async () => {
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
    setStage('ready');
  };

  const handleChangeVideo = () => {
    if (isBusy) return;
    setVideo(null);
    setStage('pick');
    setError(null);
    if (video?.source === 'camera') {
      handleRecordVideo();
    } else {
      handleChooseVideo();
    }
  };

  const togglePreviewPlayback = () => {
    if (isPreviewPlaying) {
      player.pause();
    } else {
      player.play();
    }
    setIsPreviewPlaying((prev) => !prev);
  };

  const resetAfterFailure = async (message: string, { keepFailureBanner = false }: { keepFailureBanner?: boolean } = {}) => {
    const draft = draftRef.current;
    draftRef.current = null;
    uploadHandleRef.current = null;
    if (draft) {
      await discardReelDraft(draft.reelId, draft.storagePath);
    }
    setError(message);
    setUploadFailed(keepFailureBanner);
    setProgress(0);
    setStage('ready');
  };

  const handlePublish = async () => {
    if (isBusy || !video || !user) return;
    if (!categoryId) {
      setCategoryError('Choose a category.');
      return;
    }
    if (video.fileSizeBytes === null || video.durationMs === null || !video.width || !video.height || !video.mimeType) {
      // Should be unreachable — Publish is only ever enabled once every
      // field is resolved (see the useFocusEffect/handleChooseVideo
      // validation above) — but this is the honest last-resort guard
      // against ever uploading with a fabricated/missing value.
      setError("Couldn't verify this video's details — try a different video.");
      return;
    }
    setCategoryError(null);
    setError(null);
    setUploadFailed(false);
    setStage('creating');
    setProgress(0);

    const draftResult = await createReelDraft({
      uid: user.uid,
      categoryId,
      caption,
      storageContentType: video.mimeType,
      fileSizeBytes: video.fileSizeBytes,
      durationMs: video.durationMs,
      width: video.width,
      height: video.height,
    });
    if (!draftResult.ok) {
      setError(draftResult.message);
      setStage('ready');
      return;
    }
    draftRef.current = draftResult.reel;
    setStage('uploading');

    uploadHandleRef.current = uploadReelVideo(
      draftResult.reel,
      video.uri,
      (percent) => setProgress(percent),
      async (uploadResult) => {
        if (!uploadResult.ok) {
          await resetAfterFailure("Couldn't upload Reel.", { keepFailureBanner: true });
          return;
        }
        setStage('publishing');
        const publishResult = await publishReel(draftResult.reel.reelId);
        if (!publishResult.ok) {
          await resetAfterFailure("Couldn't upload Reel.", { keepFailureBanner: true });
          return;
        }
        draftRef.current = null;
        router.replace(`/reel/${draftResult.reel.reelId}`);
      }
    );
  };

  const handleCancelUpload = async () => {
    uploadHandleRef.current?.cancel();
    await resetAfterFailure('Upload cancelled.');
  };

  const handleDismissFailure = () => {
    setUploadFailed(false);
    setError(null);
  };

  const canPublish = !!video && !isBusy;

  return (
    <HeaderScreenLayout title="Create reel" subtitle="Share what's happening around you.">
      {isResolvingCameraVideo ? (
        <View style={styles.picker}>
          <ActivityIndicator color={Colors.textSecondary} />
          <Text style={styles.pickerHint}>Preparing your recording…</Text>
        </View>
      ) : video ? (
        <View style={styles.previewWrap}>
          <VideoView
            style={styles.preview}
            player={player}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
          />
          <Pressable
            style={styles.playPauseButton}
            onPress={togglePreviewPlayback}
            accessibilityRole="button"
            accessibilityLabel={isPreviewPlaying ? 'Pause preview' : 'Play preview'}
          >
            <Ionicons name={isPreviewPlaying ? 'pause' : 'play'} size={18} color={Colors.text} />
          </Pressable>
          {!isBusy && (
            <Pressable style={styles.changeVideoButton} onPress={handleChangeVideo} accessibilityRole="button">
              <Ionicons name="swap-horizontal" size={16} color={Colors.text} />
              <Text style={styles.changeVideoText}>{video.source === 'camera' ? 'Retake' : 'Choose another'}</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <View style={styles.pickChoiceGroup}>
          {Platform.OS !== 'web' ? (
            <Pressable style={styles.pickChoice} onPress={handleRecordVideo} accessibilityRole="button">
              <View style={styles.pickChoiceIconWrap}>
                <Ionicons name="videocam" size={IconSize.xl} color={Colors.accent} />
              </View>
              <Text style={styles.pickChoiceTitle}>Record video</Text>
              <Text style={styles.pickChoiceHint}>Up to 60 seconds</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.pickChoice} onPress={handleChooseVideo} accessibilityRole="button">
            <View style={styles.pickChoiceIconWrap}>
              <Ionicons name="images" size={IconSize.xl} color={Colors.accent} />
            </View>
            <Text style={styles.pickChoiceTitle}>Choose from library</Text>
            <Text style={styles.pickChoiceHint}>Up to 60 seconds, under 50 MB</Text>
          </Pressable>
        </View>
      )}

      <View>
        <FormField
          label="Caption (optional)"
          placeholder="Add a caption..."
          value={caption}
          onChangeText={setCaption}
          multiline
          numberOfLines={3}
          maxLength={REEL_CAPTION_MAX_LENGTH}
          editable={!isBusy}
          style={styles.captionInput}
        />
        <Text style={styles.charCount}>
          {caption.length}/{REEL_CAPTION_MAX_LENGTH}
        </Text>
      </View>

      <CategorySelector
        value={categoryId}
        onChange={(id) => {
          setCategoryId(id);
          setCategoryError(null);
        }}
        error={categoryError ?? undefined}
      />

      {uploadFailed ? (
        <View style={styles.failureBanner}>
          <Text style={styles.failureText}>{error}</Text>
          <View style={styles.failureActions}>
            <View style={styles.failureActionButton}>
              <Button label="Try again" onPress={handlePublish} />
            </View>
            <View style={styles.failureActionButton}>
              <Button label="Cancel" variant="secondary" onPress={handleDismissFailure} />
            </View>
          </View>
        </View>
      ) : error ? (
        <Text style={styles.formError}>{error}</Text>
      ) : null}

      {isBusy ? (
        <View style={styles.progressBlock}>
          <View style={styles.progressRow}>
            <Text style={styles.progressText}>
              {stage === 'creating'
                ? 'Creating Reel…'
                : stage === 'publishing'
                  ? 'Publishing…'
                  : `Uploading ${progress}%`}
            </Text>
            {stage === 'uploading' && (
              <Pressable onPress={handleCancelUpload} accessibilityRole="button">
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            )}
          </View>
          {stage === 'uploading' ? (
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${progress}%` }]} />
            </View>
          ) : null}
        </View>
      ) : null}

      {!uploadFailed && (
        <Button
          label={
            stage === 'creating'
              ? 'Creating Reel…'
              : stage === 'publishing'
                ? 'Publishing…'
                : stage === 'uploading'
                  ? `Uploading ${progress}%`
                  : 'Publish Reel'
          }
          onPress={handlePublish}
          disabled={!canPublish}
          loading={isBusy}
        />
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  pickChoiceGroup: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  pickChoice: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surfaceElevated,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    padding: Spacing.md,
  },
  pickChoiceIconWrap: {
    width: 56,
    height: 56,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accentMuted,
  },
  pickChoiceTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  pickChoiceHint: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
  picker: {
    aspectRatio: 9 / 14,
    maxHeight: 360,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    borderStyle: 'dashed',
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
  },
  pickerHint: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  previewWrap: {
    aspectRatio: 9 / 14,
    maxHeight: 380,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.accent,
  },
  preview: {
    flex: 1,
  },
  playPauseButton: {
    position: 'absolute',
    bottom: Spacing.sm,
    left: Spacing.sm,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.75)',
  },
  changeVideoButton: {
    position: 'absolute',
    bottom: Spacing.sm,
    right: Spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(11, 11, 15, 0.75)',
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
  },
  changeVideoText: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
  captionInput: {
    minHeight: 70,
    textAlignVertical: 'top',
    paddingTop: Spacing.sm,
  },
  charCount: {
    alignSelf: 'flex-end',
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  formError: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  failureBanner: {
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.error,
    backgroundColor: Colors.surface,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  failureText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  failureActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  failureActionButton: {
    flex: 1,
  },
  progressBlock: {
    gap: Spacing.xs,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progressText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  progressTrack: {
    height: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.surfaceElevated,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.full,
    backgroundColor: Colors.accent,
  },
  cancelText: {
    color: Colors.error,
    fontSize: 13,
    fontWeight: '600',
  },
});
