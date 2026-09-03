import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  createReelDraft,
  discardReelDraft,
  publishReel,
  uploadReelVideo,
  type UploadReelVideoHandle,
} from '@/services/reels';
import { REEL_CAPTION_MAX_LENGTH, REEL_MAX_DURATION_MS, REEL_MAX_FILE_SIZE_BYTES, type Reel } from '@/types/reel';

type PickedVideo = {
  uri: string;
  mimeType: string;
  fileSizeBytes: number;
  durationMs: number;
  width: number;
  height: number;
};

type Stage = 'pick' | 'ready' | 'uploading' | 'publishing';

export default function CreateReelScreen() {
  const { user } = useAuth();
  const [video, setVideo] = useState<PickedVideo | null>(null);
  const [caption, setCaption] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('pick');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  const isBusy = stage === 'uploading' || stage === 'publishing';

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

    const mimeType = asset.mimeType ?? '';
    if (!mimeType.startsWith('video/')) {
      setError('That file type is not a supported video.');
      return;
    }

    // Reject before ever attempting an upload when the picker gives us
    // real metadata that fails a limit. If the platform genuinely can't
    // provide a value (fileSize/duration/width/height missing or 0), we
    // don't fabricate one — we reject with a clear message instead of
    // silently uploading something we can't validate. See the Step 18
    // spec's duration-limitation note: this is a client-declared check,
    // not proof of the real file — Firestore Rules re-validate the exact
    // same declared numbers on create (see firestore.rules).
    if (!asset.fileSize || asset.fileSize <= 0) {
      setError("Couldn't determine this video's file size — try a different video.");
      return;
    }
    if (asset.fileSize > REEL_MAX_FILE_SIZE_BYTES) {
      setError('Video must be under 50 MB.');
      return;
    }
    if (!asset.duration || asset.duration <= 0) {
      setError("Couldn't determine this video's length — try a different video.");
      return;
    }
    if (asset.duration > REEL_MAX_DURATION_MS) {
      setError('Video must be 60 seconds or shorter.');
      return;
    }
    if (!asset.width || !asset.height) {
      setError("Couldn't read this video's dimensions — try a different video.");
      return;
    }

    setVideo({
      uri: asset.uri,
      mimeType,
      fileSizeBytes: asset.fileSize,
      durationMs: asset.duration,
      width: asset.width,
      height: asset.height,
    });
    setStage('ready');
  };

  const resetAfterFailure = async (message: string) => {
    const draft = draftRef.current;
    draftRef.current = null;
    uploadHandleRef.current = null;
    if (draft) {
      await discardReelDraft(draft.reelId, draft.storagePath);
    }
    setError(message);
    setProgress(0);
    setStage('ready');
  };

  const handlePublish = async () => {
    if (isBusy || !video || !user) return;
    if (!categoryId) {
      setCategoryError('Choose a category.');
      return;
    }
    setCategoryError(null);
    setError(null);
    setStage('uploading');
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

    uploadHandleRef.current = uploadReelVideo(
      draftResult.reel,
      video.uri,
      (percent) => setProgress(percent),
      async (uploadResult) => {
        if (!uploadResult.ok) {
          await resetAfterFailure(uploadResult.message);
          return;
        }
        setStage('publishing');
        const publishResult = await publishReel(draftResult.reel.reelId);
        if (!publishResult.ok) {
          await resetAfterFailure(publishResult.message);
          return;
        }
        draftRef.current = null;
        router.replace('/reels');
      }
    );
  };

  const handleCancelUpload = async () => {
    uploadHandleRef.current?.cancel();
    await resetAfterFailure('Upload cancelled.');
  };

  const canPublish = !!video && !isBusy;

  return (
    <HeaderScreenLayout title="Create reel">
      <Text style={styles.subtitle}>Show what is happening right now.</Text>

      {video ? (
        <View style={styles.previewWrap}>
          <VideoView
            style={styles.preview}
            player={player}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
          />
          {!isBusy && (
            <Pressable style={styles.changeVideoButton} onPress={handleChooseVideo} accessibilityRole="button">
              <Ionicons name="swap-horizontal" size={16} color={Colors.text} />
              <Text style={styles.changeVideoText}>Change video</Text>
            </Pressable>
          )}
        </View>
      ) : (
        <Pressable style={styles.picker} onPress={handleChooseVideo} accessibilityRole="button">
          <Ionicons name="videocam-outline" size={40} color={Colors.textSecondary} />
          <Text style={styles.pickerTitle}>Choose a video</Text>
          <Text style={styles.pickerHint}>Up to 60 seconds, under 50 MB.</Text>
        </Pressable>
      )}

      <View>
        <TextInput
          style={styles.captionInput}
          placeholder="Add a caption (optional)"
          placeholderTextColor={Colors.textSecondary}
          value={caption}
          onChangeText={setCaption}
          multiline
          maxLength={REEL_CAPTION_MAX_LENGTH}
          editable={!isBusy}
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

      {error ? <Text style={styles.formError}>{error}</Text> : null}

      {isBusy ? (
        <View style={styles.progressRow}>
          <Text style={styles.progressText}>
            {stage === 'publishing' ? 'Publishing…' : `Uploading ${progress}%`}
          </Text>
          {stage === 'uploading' && (
            <Pressable onPress={handleCancelUpload} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      <Button
        label={stage === 'publishing' ? 'Publishing…' : stage === 'uploading' ? `Uploading ${progress}%` : 'Publish Reel'}
        onPress={handlePublish}
        disabled={!canPublish}
        loading={isBusy}
      />
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    marginTop: -Spacing.sm,
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
  pickerTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginTop: Spacing.sm,
  },
  pickerHint: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  previewWrap: {
    aspectRatio: 9 / 14,
    maxHeight: 360,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
  },
  preview: {
    flex: 1,
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
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    color: Colors.text,
    fontSize: 15,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    textAlignVertical: 'top',
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
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  progressText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  cancelText: {
    color: Colors.error,
    fontSize: 13,
    fontWeight: '600',
  },
});
