import { router } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

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
  renderPhotoToVideo,
  uploadReelMusicAudio,
  uploadReelThumbnail,
  uploadReelVideo,
  type UploadReelVideoHandle,
} from '@/services/reels';
import {
  takePendingSelectedMusic,
  takePendingSelectedPhoto,
  takePendingSelectedThumbnail,
  takePendingSelectedVideo,
} from '@/services/reelCameraHandoff';
import {
  REEL_CAPTION_MAX_LENGTH,
  type Reel,
  type SelectedReelMusic,
  type SelectedReelPhoto,
  type SelectedReelThumbnail,
  type SelectedReelVideo,
} from '@/types/reel';

type Stage = 'ready' | 'creating' | 'uploading' | 'uploadingThumbnail' | 'uploadingMusic' | 'merging' | 'renderingPhoto' | 'publishing';

/**
 * Post creation Stage 3 (caption + category + Post) — Step 41.2D.1. Only
 * ever reached with an already-selected, already-validated video OR photo
 * ("FOTO" mode — see ReelMediaType's own doc comment in src/types/reel.ts)
 * handed off from Stage 1/2 (src/app/(app)/create/reel/camera.tsx) when the
 * user tapped Next — this screen never shows camera controls or a library
 * picker; the media choice is done by the time a user gets here. A photo
 * skips the cover-frame and music steps entirely (see handlePublish's
 * `photo` branch below) — a still image has neither. If this screen is
 * ever reached directly (a stale link, not the normal flow), there's
 * nothing to publish, so it bounces straight back to the capture screen
 * rather than showing a broken form.
 */
export default function CreateReelScreen() {
  const { user } = useAuth();
  const [video, setVideo] = useState<SelectedReelVideo | null>(null);
  const [photo, setPhoto] = useState<SelectedReelPhoto | null>(null);
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
  // reminder of the video already chosen, not a scrubbable preview. Only
  // ever fed a real URI when a video (not a photo) was handed off.
  const player = useVideoPlayer(video?.uri ?? null, (p) => {
    p.loop = true;
    p.muted = true;
  });

  useEffect(() => {
    if (video) player.play();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video]);

  useEffect(() => {
    const pendingPhoto = takePendingSelectedPhoto();
    const pending = takePendingSelectedVideo();
    const pendingMusic = takePendingSelectedMusic();
    const pendingThumbnail = takePendingSelectedThumbnail();
    // Reads the one-shot handoffs exactly once on mount — this screen is
    // always a fresh push, never reused across selections. camera.tsx only
    // ever sets one of pendingPhoto/pending (never both), so at most one of
    // these two setters actually fires.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (pendingPhoto) setPhoto(pendingPhoto);
    if (pending) setVideo(pending);
    setMusic(pendingMusic);
    setThumbnail(pendingThumbnail);
    setHasCheckedHandoff(true);
  }, []);

  useEffect(() => {
    if (hasCheckedHandoff && !video && !photo) {
      router.replace('/create/reel/camera');
    }
  }, [hasCheckedHandoff, video, photo]);

  const isBusy =
    stage === 'creating' ||
    stage === 'uploading' ||
    stage === 'uploadingThumbnail' ||
    stage === 'uploadingMusic' ||
    stage === 'merging' ||
    stage === 'renderingPhoto' ||
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
    if (isBusy || (!video && !photo) || !user) return;
    if (!categoryId) {
      setCategoryError('Choose a category.');
      return;
    }

    if (photo && music) {
      // "FOTO" mode WITH music — publishes as a real 'video' Reel once
      // renderPhotoToVideo (functions/src/index.ts) finishes rendering it
      // server-side (see Reel.needsPhotoVideoRender's own doc comment).
      // camera.tsx's handleNext already generated a real cover thumbnail
      // for this exact case (see its own doc comment) — these checks
      // should be unreachable, same "honest last-resort guard" reasoning
      // as the plain video branch below.
      if (photo.fileSizeBytes === null || !photo.width || !photo.height || !photo.mimeType) {
        setError("Couldn't verify this photo's details — try again.");
        return;
      }
      if (music.fileSizeBytes <= 0 || music.durationMs === null || music.durationMs <= 0 || !music.mimeType) {
        setError("Couldn't verify this music file's details — try a different file.");
        return;
      }
      if (!thumbnail || thumbnail.fileSizeBytes <= 0 || !thumbnail.mimeType || !thumbnail.width || !thumbnail.height) {
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
        mediaType: 'video',
        photoRenderPending: true,
        storageContentType: photo.mimeType,
        fileSizeBytes: photo.fileSizeBytes,
        // Ignored by createReelDraft when photoRenderPending is true — it
        // always stores REEL_PHOTO_DURATION_MS instead (see its own doc
        // comment) — passed as 0 here just to satisfy the input shape.
        durationMs: 0,
        width: photo.width,
        height: photo.height,
        music: {
          title: music.title,
          storageContentType: music.mimeType,
          fileSizeBytes: music.fileSizeBytes,
          durationMs: music.durationMs,
        },
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

      // uploadReelVideo is fully generic over what bytes it's handed (see
      // its own doc comment in reels.ts) — here it uploads the PHOTO to
      // reel.storagePath; renderPhotoToVideo overwrites that same object
      // with the real rendered video afterward.
      uploadHandleRef.current = uploadReelVideo(draftResult.reel, photo.uri, (percent) => setProgress(percent), async (uploadResult) => {
        if (!uploadResult.ok) {
          await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
          return;
        }

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
                // All files are uploaded — now render the photo + music
                // into a real video (see renderPhotoToVideo's own doc
                // comment). Only after this succeeds does storagePath
                // actually hold a video, and only then can it publish.
                setStage('renderingPhoto');
                const renderResult = await renderPhotoToVideo(draftResult.reel.reelId);
                if (!renderResult.ok) {
                  await resetAfterFailure("Couldn't process this post's photo.", { keepFailureBanner: true });
                  return;
                }
                setStage('publishing');
                const publishResult = await publishReel(draftResult.reel.reelId);
                if (!publishResult.ok) {
                  await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
                  return;
                }
                draftRef.current = null;
                router.replace(`/reel/${draftResult.reel.reelId}`);
              }
            );
          }
        );
      });
      return;
    }

    if (photo) {
      // Plain "FOTO" mode, no music — a single still image, no cover frame
      // to validate or upload (see handlePublish's own doc comment above).
      if (photo.fileSizeBytes === null || !photo.width || !photo.height || !photo.mimeType) {
        // Should be unreachable — camera.tsx's handleTakePicture always
        // reads these straight back from expo-camera's own
        // takePictureAsync() result — but this is the same honest
        // last-resort guard the video branch below uses.
        setError("Couldn't verify this photo's details — try again.");
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
        mediaType: 'photo',
        storageContentType: photo.mimeType,
        fileSizeBytes: photo.fileSizeBytes,
        durationMs: 0,
        width: photo.width,
        height: photo.height,
      });
      if (!draftResult.ok) {
        setError(draftResult.message);
        setStage('ready');
        return;
      }
      draftRef.current = draftResult.reel;
      setStage('uploading');

      // The photo is the ONE Storage object for a photo Reel — it already
      // IS its own cover image (see Reel.thumbnailStoragePath's own doc
      // comment), so there's no separate thumbnail-upload step, and no
      // music/mux step either. uploadReelVideo is fully generic over media
      // type despite its name (see its own doc comment in reels.ts) — it
      // just uploads bytes to reel.storagePath, whatever they represent.
      uploadHandleRef.current = uploadReelVideo(draftResult.reel, photo.uri, (percent) => setProgress(percent), async (uploadResult) => {
        if (!uploadResult.ok) {
          await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
          return;
        }
        uploadHandleRef.current = null;
        setStage('publishing');
        const publishResult = await publishReel(draftResult.reel.reelId);
        if (!publishResult.ok) {
          await resetAfterFailure("Couldn't upload post.", { keepFailureBanner: true });
          return;
        }
        draftRef.current = null;
        router.replace(`/reel/${draftResult.reel.reelId}`);
      });
      return;
    }

    // video is non-null here — handlePublish's own early-return guard above
    // already ruled out "neither video nor photo".
    if (video!.fileSizeBytes === null || video!.durationMs === null || !video!.width || !video!.height || !video!.mimeType) {
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
      mediaType: 'video',
      storageContentType: video!.mimeType,
      fileSizeBytes: video!.fileSizeBytes,
      durationMs: video!.durationMs,
      width: video!.width,
      height: video!.height,
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
      video!.uri,
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

  const canPublish = (!!video || !!photo) && !isBusy;

  if (!video && !photo) {
    // Either still checking the handoff (one tick) or already redirecting
    // to the capture screen (see the effect above) — never render the form
    // without a real video or photo.
    return (
      <View style={styles.loadingScreen}>
        <LoadingState size="large" />
      </View>
    );
  }

  return (
    <HeaderScreenLayout title="Create post" subtitle="Add a caption and category before you post.">
      <View style={styles.thumbnailWrap}>
        {photo ? (
          <Image source={{ uri: photo.uri }} style={styles.thumbnail} resizeMode="cover" />
        ) : (
          <VideoView
            style={styles.thumbnail}
            player={player}
            contentFit="cover"
            nativeControls={false}
            allowsPictureInPicture={false}
          />
        )}
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
                  : stage === 'renderingPhoto'
                    ? 'Processing photo…'
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
                : stage === 'renderingPhoto'
                  ? 'Processing photo…'
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
