import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { FormField } from '@/components/FormField';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  createReelDraft,
  discardReelDraft,
  muxReelMusic,
  publishReel,
  uploadReelMusicAudio,
  uploadReelThumbnail,
  uploadReelVideo,
  type UploadReelVideoHandle,
} from '@/services/reels';
import { takePendingSelectedMusic, takePendingSelectedThumbnail, takePendingSelectedVideo } from '@/services/reelCameraHandoff';
import { REEL_CAPTION_MAX_LENGTH, type Reel, type SelectedReelMusic, type SelectedReelThumbnail, type SelectedReelVideo } from '@/types/reel';

type Stage = 'ready' | 'creating' | 'uploading' | 'uploadingThumbnail' | 'uploadingMusic' | 'merging' | 'publishing';

/**
 * Post creation Stage 3 (caption + category + Post) — Step 41.2D.1. Only
 * ever reached with an already-selected, already-validated video handed
 * off from Stage 1/2 (src/app/(app)/create/reel/camera.tsx) when the user
 * tapped Next — this screen never shows camera controls or a library
 * picker; the video choice is done by the time a user gets here. If this
 * screen is ever reached directly (a stale link, not the normal flow),
 * there's nothing to publish, so it bounces straight back to the capture
 * screen rather than showing a broken form.
 */
export default function CreateReelScreen() {
  const { user } = useAuth();
  const [video, setVideo] = useState<SelectedReelVideo | null>(null);
  const [music, setMusic] = useState<SelectedReelMusic | null>(null);
  const [thumbnail, setThumbnail] = useState<SelectedReelThumbnail | null>(null);
  const [hasCheckedHandoff, setHasCheckedHandoff] = useState(false);
  const [caption, setCaption] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('ready');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);

  const uploadHandleRef = useRef<UploadReelVideoHandle | null>(null);
  const draftRef = useRef<Reel | null>(null);

  // Muted, no loop needed — this is just a small static-feeling thumbnail
  // reminder of the video already chosen, not a scrubbable preview.
  const player = useVideoPlayer(video?.uri ?? null, (p) => {
    p.loop = true;
    p.muted = true;
  });

  useEffect(() => {
    if (video) player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  useEffect(() => {
    const pending = takePendingSelectedVideo();
    const pendingMusic = takePendingSelectedMusic();
    const pendingThumbnail = takePendingSelectedThumbnail();
    // Reads the one-shot handoffs exactly once on mount — this screen is
    // always a fresh push, never reused across selections.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pending) setVideo(pending);
    setMusic(pendingMusic);
    setThumbnail(pendingThumbnail);
    setHasCheckedHandoff(true);
  }, []);

  useEffect(() => {
    if (hasCheckedHandoff && !video) {
      router.replace('/create/reel/camera');
    }
  }, [hasCheckedHandoff, video]);

  const isBusy =
    stage === 'creating' ||
    stage === 'uploading' ||
    stage === 'uploadingThumbnail' ||
    stage === 'uploadingMusic' ||
    stage === 'merging' ||
    stage === 'publishing';

  const resetAfterFailure = async (message: string, { keepFailureBanner = false }: { keepFailureBanner?: boolean } = {}) => {
    const draft = draftRef.current;
    draftRef.current = null;
    uploadHandleRef.current = null;
    if (draft) {
      // musicStorageAudioPath is '' when no music was attached — see
      // ReelMusicSourceType's doc comment; discardReelDraft treats an
      // empty/falsy path as "nothing to delete," not an error.
      await discardReelDraft(draft.reelId, draft.storagePath, draft.thumbnailStoragePath, draft.musicStorageAudioPath || undefined);
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
      // Should be unreachable — Stage 1/2 only hands off a video that
      // already passed validateSelectedReelVideo — but this is the honest
      // last-resort guard against ever uploading with a fabricated/missing
      // value.
      setError("Couldn't verify this video's details — try a different video.");
      return;
    }
    if (music && (music.fileSizeBytes <= 0 || music.durationMs === null || music.durationMs <= 0 || !music.mimeType)) {
      // Same "should be unreachable" defensive guard as the video check
      // above — camera.tsx only ever hands off music that already passed
      // validateSelectedReelMusic.
      setError("Couldn't verify this music file's details — try a different file.");
      return;
    }
    if (!thumbnail || thumbnail.fileSizeBytes <= 0 || !thumbnail.mimeType || !thumbnail.width || !thumbnail.height) {
      // Same "should be unreachable" defensive guard — camera.tsx always
      // hands off a chosen cover frame before pushing here (see
      // SelectedReelThumbnail's own doc comment).
      setError("Couldn't verify this post's cover image — go back and choose one again.");
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
      music: music
        ? {
            title: music.title,
            storageContentType: music.mimeType,
            fileSizeBytes: music.fileSizeBytes,
            durationMs: music.durationMs!,
          }
        : undefined,
      thumbnail: {
        storageContentType: thumbnail.mimeType,
        fileSizeBytes: thumbnail.fileSizeBytes,
        width: thumbnail.width,
        height: thumbnail.height,
      },
    });
    if (!draftResult.ok) {
      setError(draftResult.message);
      setStage('ready');
      return;
    }
    draftRef.current = draftResult.reel;
    setStage('uploading');

    const finishPublish = async () => {
      setStage('publishing');
      const publishResult = await publishReel(draftResult.reel.reelId);
      if (!publishResult.ok) {
        await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
        return;
      }
      draftRef.current = null;
      router.replace(`/reel/${draftResult.reel.reelId}`);
    };

    uploadHandleRef.current = uploadReelVideo(
      draftResult.reel,
      video.uri,
      (percent) => setProgress(percent),
      async (uploadResult) => {
        if (!uploadResult.ok) {
          await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
          return;
        }

        // The cover image is a SEPARATE Storage object from the video —
        // always uploaded next, whether or not music is attached.
        setStage('uploadingThumbnail');
        setProgress(0);
        uploadHandleRef.current = uploadReelThumbnail(
          draftResult.reel,
          thumbnail.uri,
          (percent) => setProgress(percent),
          async (thumbnailUploadResult) => {
            if (!thumbnailUploadResult.ok) {
              await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
              return;
            }

            // Music is a SEPARATE Storage object from the video (see
            // ReelMusicSourceType's doc comment) — uploaded as its own step
            // once the video and thumbnail have both succeeded, only when
            // one was attached.
            if (music) {
              setStage('uploadingMusic');
              setProgress(0);
              uploadHandleRef.current = uploadReelMusicAudio(
                draftResult.reel,
                music.uri,
                (percent) => setProgress(percent),
                async (musicUploadResult) => {
                  if (!musicUploadResult.ok) {
                    await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
                    return;
                  }
                  uploadHandleRef.current = null;
                  // All files are uploaded — now merge the music into the
                  // video itself (see muxReelMusic's own doc comment in
                  // functions/src/index.ts). Only after this succeeds does
                  // the published Reel actually carry the sound.
                  setStage('merging');
                  const muxResult = await muxReelMusic(draftResult.reel.reelId);
                  if (!muxResult.ok) {
                    await resetAfterFailure("Couldn't add music to this post.", { keepFailureBanner: true });
                    return;
                  }
                  await finishPublish();
                }
              );
              return;
            }

            uploadHandleRef.current = null;
            await finishPublish();
          }
        );
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

  if (!video) {
    // Either still checking the handoff (one tick) or already redirecting
    // to the capture screen (see the effect above) — never render the form
    // without a real video.
    return (
      <View style={styles.loadingScreen}>
        <LoadingState size="large" />
      </View>
    );
  }

  return (
    <HeaderScreenLayout title="Create post" subtitle="Add a caption and category before you post.">
      <View style={styles.thumbnailWrap}>
        <VideoView
          style={styles.thumbnail}
          player={player}
          contentFit="cover"
          nativeControls={false}
          allowsPictureInPicture={false}
        />
      </View>

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
                ? 'Creating post…'
                : stage === 'merging'
                  ? 'Adding music…'
                  : stage === 'publishing'
                    ? 'Publishing…'
                    : stage === 'uploadingMusic'
                      ? `Uploading music ${progress}%`
                      : stage === 'uploadingThumbnail'
                        ? `Uploading cover ${progress}%`
                        : `Uploading ${progress}%`}
            </Text>
            {(stage === 'uploading' || stage === 'uploadingThumbnail' || stage === 'uploadingMusic') && (
              <Pressable onPress={handleCancelUpload} accessibilityRole="button">
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
            )}
          </View>
          {stage === 'uploading' || stage === 'uploadingThumbnail' || stage === 'uploadingMusic' ? (
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
              ? 'Creating post…'
              : stage === 'merging'
                ? 'Adding music…'
                : stage === 'publishing'
                  ? 'Publishing…'
                  : stage === 'uploadingMusic'
                    ? `Uploading music ${progress}%`
                    : stage === 'uploadingThumbnail'
                      ? `Uploading cover ${progress}%`
                      : stage === 'uploading'
                        ? `Uploading ${progress}%`
                        : 'Post'
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
  loadingScreen: {
    flex: 1,
    backgroundColor: Colors.background,
    justifyContent: 'center',
  },
  thumbnailWrap: {
    aspectRatio: 9 / 14,
    maxHeight: 280,
    alignSelf: 'center',
    width: '60%',
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  thumbnail: {
    flex: 1,
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
