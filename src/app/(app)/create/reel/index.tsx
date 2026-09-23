import { router, useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView, type VideoPlayer } from 'expo-video';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { FormField } from '@/components/FormField';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { getActiveHashtag, replaceActiveHashtag, searchHashtagsRanked } from '@/services/hashtags';
import { takePendingSelectedMention } from '@/services/mentionHandoff';
import { searchPublicProfilesByUsername } from '@/services/publicProfile';
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
import type { Hashtag } from '@/types/hashtag';
import type { PublicProfile } from '@/types/social';
import {
  REEL_CAPTION_MAX_LENGTH,
  type Reel,
  type SelectedReelMusic,
  type SelectedReelPhoto,
  type SelectedReelThumbnail,
  type SelectedReelVideo,
} from '@/types/reel';
import { formatPostCount } from '@/utils/postCount';
import { normalizeUsernameSearchQuery } from '@/utils/username';

type Stage = 'ready' | 'creating' | 'uploading' | 'uploadingThumbnail' | 'uploadingMusic' | 'merging' | 'renderingPhoto' | 'publishing';

// @ mention autocomplete (per explicit request) — same debounce +
// generation-counter pattern src/app/(app)/search.tsx already uses for
// its own people search, applied here to the caption's own trailing
// "@partial-username" token instead of a dedicated search field. A
// shorter debounce and no minimum-length floor (search.tsx requires 2
// characters before it queries at all) — a caption is a much smaller,
// more casual surface, so showing a first suggestion the moment a single
// letter follows "@" reads as responsive rather than eager.
const MENTION_DEBOUNCE_MS = 200;
const MENTION_SUGGESTION_LIMIT = 6;

// "#" hashtag autocomplete (Step 3) — same debounce+generation-counter
// shape as the "@" mention autocomplete just above, but cursor-position-
// aware (see getActiveHashtag's own doc comment) rather than tail-of-
// string, since a caption can have multiple hashtags and the cursor can
// move back into an earlier one. Same suggestion-count ceiling as
// mentions for visual consistency between the two lists.
const HASHTAG_AUTOCOMPLETE_DEBOUNCE_MS = 200;
const HASHTAG_SUGGESTION_LIMIT = 6;

/**
 * Finds the "@partial-username" the caption currently ends with, if any —
 * e.g. "Great night with @al" -> "al". Deliberately only ever looks at the
 * END of the caption, not a full parse of every "@" anywhere in it: a
 * caption box is overwhelmingly typed forward, and this is the one case
 * that actually matters for "show suggestions right as I type @someone".
 * Requires "@" to start a new word (string start or right after
 * whitespace) so something like an email-shaped "foo@bar" never triggers
 * it, and caps the captured run at 24 characters — this app's own
 * USERNAME_PATTERN max length (src/utils/username.ts) — so it can never
 * capture more of the caption than a real username could ever be.
 */
function detectActiveMentionQuery(caption: string): string | null {
  const match = /(?:^|\s)@([a-zA-Z0-9_]{0,24})$/.exec(caption);
  return match ? match[1] : null;
}

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
  // Per explicit request — tapping into the caption box takes over the
  // whole screen (thumbnail shrinks to a small reminder up top, the
  // caption field fills the rest, category/Post/etc. are all hidden until
  // "Done") instead of editing a caption inline among everything else on
  // the page. Real device keyboard behavior (what actually shows above,
  // how much space it takes) is native-only — this only controls the
  // LAYOUT switch, which is equally real in the Browser pane preview.
  const [isCaptionFocused, setIsCaptionFocused] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('ready');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploadFailed, setUploadFailed] = useState(false);

  // @ mention autocomplete — see detectActiveMentionQuery's own doc
  // comment above. `mentionQuery` is null whenever the caption doesn't
  // currently end in an active "@partial-username" token; a non-null
  // (possibly empty) string drives the debounced search below.
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSuggestions, setMentionSuggestions] = useState<PublicProfile[]>([]);
  const mentionDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mentionGenerationRef = useRef(0);

  const uploadHandleRef = useRef<UploadReelVideoHandle | null>(null);
  const draftRef = useRef<Reel | null>(null);

  const handleCaptionChange = (text: string) => {
    setCaption(text);
    setMentionQuery(detectActiveMentionQuery(text));
  };

  // Debounced search against the exact same publicProfiles lookup
  // src/app/(app)/search.tsx's own People Search uses — real prefix
  // matching on `usernameLower` (see searchPublicProfilesByUsername's own
  // doc comment), never a duplicate/parallel search implementation.
  // Requires at least one real character after "@" before actually
  // querying — bare "@" alone would otherwise return an arbitrary
  // alphabetical slice of every username in the city, which isn't a
  // useful suggestion for anyone.
  useEffect(() => {
    if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
    if (!mentionQuery) {
      // Discards any suggestions already on screen AND any in-flight
      // fetch from a moment ago — bumping the generation is what makes a
      // slow response for "al" harmless if the mention was already
      // cancelled (space typed, caption cleared, ...) by the time it
      // resolves.
      mentionGenerationRef.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- mentionSuggestions is derived from the debounced mentionQuery, not a separate data source; clearing it the instant mentionQuery goes null (rather than only on the next debounce fire) is the correct behavior here, not an effect antipattern — same reasoning as search.tsx's own identical case.
      setMentionSuggestions([]);
      return;
    }
    const generation = ++mentionGenerationRef.current;
    mentionDebounceRef.current = setTimeout(async () => {
      const profiles = await searchPublicProfilesByUsername(normalizeUsernameSearchQuery(mentionQuery));
      if (generation !== mentionGenerationRef.current) return; // superseded by a newer keystroke
      setMentionSuggestions(profiles.filter((profile) => profile.uid !== user?.uid).slice(0, MENTION_SUGGESTION_LIMIT));
    }, MENTION_DEBOUNCE_MS);
    return () => {
      if (mentionDebounceRef.current) clearTimeout(mentionDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionQuery]);

  /**
   * Replaces the trailing "@partial-username" the suggestion list is
   * currently showing for with "@Display Name " (trailing space, so
   * typing continues naturally right after it) — per explicit feedback,
   * the caption itself shows the person's real display name, not their
   * (often auto-generated-looking) username; the row that was just tapped
   * still shows the real @username underneath it, so there's no loss of
   * "which exact person is this" when two people share a display name.
   */
  const handleSelectMention = (profile: PublicProfile) => {
    setCaption((current) => {
      const query = detectActiveMentionQuery(current);
      if (query === null) return current; // shouldn't happen — this row only shows while a mention is active
      const atIndex = current.length - query.length - 1;
      return `${current.slice(0, atIndex)}@${profile.displayName} `;
    });
    setMentionQuery(null);
    setMentionSuggestions([]);
  };

  /** Appends `insertText` to the caption, adding a leading space first only if the caption is non-empty and doesn't already end in whitespace. */
  const appendToCaption = (current: string, insertText: string): string => {
    const needsSpace = current.length > 0 && !/\s$/.test(current);
    return `${current}${needsSpace ? ' ' : ''}${insertText}`;
  };

  /** The "# Hashtag" quick-insert button below the caption box (per explicit request to "put # and @ in here") — appends "#", same as tapping it on a keyboard's own key would; typing the actual tag afterward is unchanged, plain text. */
  const handleInsertHashtag = () => {
    setCaption((current) => appendToCaption(current, '#'));
  };

  /**
   * The "@ Mention" button — per explicit follow-up request, this no
   * longer inserts "@" inline; it opens a full dedicated picker screen
   * (the same People Search screen, src/app/(app)/search.tsx, in its
   * `mode=select` variant — "work like regular search", searching every
   * user regardless of follow status, not just people already followed)
   * and waits for it to hand a profile back (see the useFocusEffect just
   * below). Typing "@" by hand still works too — see
   * detectActiveMentionQuery's own inline suggestion list above — this is
   * a second, richer path to the same result, not a replacement for it.
   */
  const handleOpenMentionPicker = () => {
    router.push('/search?mode=select');
  };

  /** Exits the full-screen caption editor back to the normal form — the "Done" button up top while editing. */
  const handleDoneCaptionEditing = () => {
    Keyboard.dismiss();
    setIsCaptionFocused(false);
  };

  // Reads the mention picker's one-shot handoff every time this screen
  // regains focus (it's already mounted underneath the pushed picker
  // screen, never freshly mounted when it pops back — a focus effect is
  // what catches that, the same reasoning camera.tsx's own
  // takePendingPreselectedSound effect documents for its own identical
  // "screen pushed on top, handing something back" shape).
  useFocusEffect(
    useCallback(() => {
      const picked = takePendingSelectedMention();
      if (!picked) return;
      // "@Display Name", not "@username" — same reasoning as
      // handleSelectMention's own doc comment just above.
      setCaption((current) => appendToCaption(current, `@${picked.displayName} `));
      // Whatever inline "@partial-username" suggestion state (if any) was
      // active before the picker was opened is now stale — the mention
      // was just resolved a different way.
      setMentionQuery(null);
      // handleOpenMentionPicker only ever navigates here FROM the
      // full-screen caption editor, so coming back always means "resume
      // editing the caption" — reopens it rather than dropping the viewer
      // back onto the normal, everything-visible form.
      setIsCaptionFocused(true);
      setMentionSuggestions([]);
    }, [])
  );

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
      // storageProvider/thumbnailStorageProvider (Step 9A) are always
      // 'firebase' at this point unless a real R2 upload for either one
      // already confirmed — discardReelDraft only asks the server to
      // clean up R2 when at least one of them says so.
      await discardReelDraft(
        draft.reelId,
        draft.storagePath,
        draft.thumbnailStoragePath,
        draft.musicStorageAudioPath || undefined,
        draft.storageProvider,
        draft.thumbnailStorageProvider
      );
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

  // Shared between the normal form below and the full-screen caption
  // editor (isCaptionFocused) — identical markup either way, so this is
  // computed once rather than duplicated.
  const mentionSuggestionsList =
    mentionSuggestions.length > 0 ? (
      <View style={styles.mentionList}>
        {mentionSuggestions.map((profile, index) => (
          <Pressable
            key={profile.uid}
            onPress={() => handleSelectMention(profile)}
            style={[styles.mentionRow, index > 0 && styles.mentionRowBorder]}
            accessibilityRole="button"
            accessibilityLabel={`Mention @${profile.username}`}
          >
            <Avatar name={profile.displayName} photoURL={profile.photoURL || undefined} size={32} />
            <View style={styles.mentionRowText}>
              <Text style={styles.mentionDisplayName} numberOfLines={1}>
                {profile.displayName}
              </Text>
              <Text style={styles.mentionUsername} numberOfLines={1}>
                @{profile.username}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    ) : null;

  const captionToolbar = (
    <View style={styles.captionToolbarRow}>
      {/* "@" opens the full mention picker screen (People Search, in its
          select variant); "#" is free-typed like any other character —
          this button just makes it easy to reach without hunting for it
          on a symbols keyboard. */}
      <Pressable
        onPress={handleOpenMentionPicker}
        disabled={isBusy}
        style={styles.captionToolbarButton}
        accessibilityRole="button"
        accessibilityLabel="Mention someone"
      >
        <Text style={styles.captionToolbarButtonText}>@ Mention</Text>
      </Pressable>
      <Pressable
        onPress={handleInsertHashtag}
        disabled={isBusy}
        style={styles.captionToolbarButton}
        accessibilityRole="button"
        accessibilityLabel="Add a hashtag"
      >
        <Text style={styles.captionToolbarButtonText}># Hashtag</Text>
      </Pressable>
      <Text style={styles.charCount}>
        {caption.length}/{REEL_CAPTION_MAX_LENGTH}
      </Text>
    </View>
  );

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

  // Full-screen caption editor — per explicit request, tapping into the
  // caption box takes over the whole screen instead of editing inline
  // among the thumbnail/category/Post button: the video/photo shrinks to
  // a small reminder up top, the caption field fills the space below it,
  // and everything else (category, error/progress state, the Post button
  // itself) is hidden until "Done". A real device's keyboard is native-
  // only, but the LAYOUT this makes room for it is equally real here —
  // KeyboardAvoidingView still does the right thing on iOS. A real,
  // separate component (not inlined here) so its own cursor-position
  // state (see CaptionFullScreenEditor's own doc comment) is freshly
  // initialized every time this branch is (re-)entered, not just once for
  // the whole screen's lifetime.
  if (isCaptionFocused) {
    return (
      <CaptionFullScreenEditor
        caption={caption}
        onChangeCaption={handleCaptionChange}
        onDone={handleDoneCaptionEditing}
        isBusy={isBusy}
        photo={photo}
        player={player}
        mentionSuggestionsList={mentionSuggestionsList}
        captionToolbar={captionToolbar}
      />
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
          onChangeText={handleCaptionChange}
          onFocus={() => setIsCaptionFocused(true)}
          multiline
          numberOfLines={3}
          maxLength={REEL_CAPTION_MAX_LENGTH}
          editable={!isBusy}
          style={styles.captionInput}
        />

        {captionToolbar}

        {/* Mentioning-someone suggestions — appears the moment the
            caption ends in "@" plus at least one real character (see
            detectActiveMentionQuery), pushes the category picker below it
            down rather than floating over it, so there's no absolute-
            positioning/measurement to keep in sync with the caption box's
            own (variable, multiline) height. */}
        {mentionSuggestionsList}
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

type CaptionFullScreenEditorProps = {
  caption: string;
  onChangeCaption: (text: string) => void;
  onDone: () => void;
  isBusy: boolean;
  photo: SelectedReelPhoto | null;
  player: VideoPlayer;
  mentionSuggestionsList: ReactNode;
  captionToolbar: ReactNode;
};

/**
 * The full-screen caption editor's own body — a real, separate component
 * (not inlined into CreateReelScreen's render) specifically so its own
 * `selection` state below is freshly initialized every time the viewer
 * re-enters this mode, not just once for CreateReelScreen's entire
 * lifetime: React only re-runs a `useState` lazy initializer on a fresh
 * mount, and this component genuinely (re)mounts each time
 * `isCaptionFocused` flips back to true (its parent swaps between this
 * and the normal form, not a persisting instance toggling visibility).
 *
 * Without this, a freshly-mounted, non-empty, `autoFocus`-ed multiline
 * TextInput defaults its cursor to the very START of the existing text —
 * confirmed live: reopening the editor and continuing to type inserted
 * new characters BEFORE the caption already there instead of after it.
 * Explicitly controlling `selection`, seeded to "the end" on mount and
 * then kept in sync via `onSelectionChange` on every subsequent real
 * cursor move, is what makes reopening the editor resume typing where
 * you actually left off.
 */
function CaptionFullScreenEditor({
  caption,
  onChangeCaption,
  onDone,
  isBusy,
  photo,
  player,
  mentionSuggestionsList,
  captionToolbar,
}: CaptionFullScreenEditorProps) {
  const [selection, setSelection] = useState(() => ({ start: caption.length, end: caption.length }));

  // Derived fresh every render from the current caption + cursor position
  // — never stored in its own state, so there's no separate "is it stale"
  // question the way mentionQuery has to guard against (see
  // handleSelectMention's own comment in the parent). Only a real caret
  // (no selected text range) counts as "editing a hashtag" — a multi-
  // character selection has no single well-defined cursor position to
  // walk outward from.
  const activeHashtag = selection.start === selection.end ? getActiveHashtag(caption, selection.start) : null;
  const [hashtagSuggestions, setHashtagSuggestions] = useState<Hashtag[]>([]);
  const hashtagDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hashtagGenerationRef = useRef(0);

  // Same debounce + generation-counter shape as the mention search effect
  // in the parent (see its own doc comment) — a query lands here only
  // after HASHTAG_AUTOCOMPLETE_DEBOUNCE_MS of no further cursor/text
  // change, and a response that arrives after a newer one was already
  // requested is discarded rather than clobbering it. Previous
  // suggestions are deliberately left on screen while a new query is in
  // flight (no `setHashtagSuggestions([])` before the fetch) — avoids the
  // large-spinner/flicker the spec explicitly asks to avoid; they're only
  // cleared once there's genuinely nothing to autocomplete (empty query —
  // no active hashtag, a bare "#", or the "#" itself deleted).
  useEffect(() => {
    if (hashtagDebounceRef.current) clearTimeout(hashtagDebounceRef.current);
    const activeQuery = activeHashtag?.query ?? '';
    if (!activeQuery) {
      hashtagGenerationRef.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hashtagSuggestions is derived from the debounced activeQuery, not a separate data source; clearing it the instant the active hashtag goes away (rather than only on the next debounce fire) is correct here, same reasoning as the mention suggestion list's own identical case above.
      setHashtagSuggestions([]);
      return;
    }
    const generation = ++hashtagGenerationRef.current;
    hashtagDebounceRef.current = setTimeout(async () => {
      const results = await searchHashtagsRanked(activeQuery);
      if (generation !== hashtagGenerationRef.current) return; // superseded by a newer keystroke/cursor move
      setHashtagSuggestions(results.slice(0, HASHTAG_SUGGESTION_LIMIT));
    }, HASHTAG_AUTOCOMPLETE_DEBOUNCE_MS);
    return () => {
      if (hashtagDebounceRef.current) clearTimeout(hashtagDebounceRef.current);
    };
  }, [activeHashtag?.query]);

  /**
   * Replaces ONLY the active "#token" (see replaceActiveHashtag's own doc
   * comment) with the tapped hashtag's canonical name, then moves the
   * (still controlled — see this component's own top doc comment) cursor
   * to right after it. Never touches any other hashtag, word, emoji, or
   * line break elsewhere in the caption.
   */
  const handleSelectHashtag = (hashtag: Hashtag) => {
    if (!activeHashtag) return; // shouldn't happen — this list only shows while a hashtag is active
    const { text, cursor } = replaceActiveHashtag(caption, activeHashtag, hashtag.name);
    onChangeCaption(text);
    setSelection({ start: cursor, end: cursor });
    setHashtagSuggestions([]);
  };

  // Closes the moment the cursor leaves the active hashtag (activeHashtag
  // goes null) or there's nothing to show yet — not separately tied to
  // input blur/focus: unlike the mention list, gating this on blur risks
  // a real platform race (blur can fire before a suggestion row's own
  // onPress, cancelling the tap before it registers — the exact "tapping
  // a suggestion must not unexpectedly dismiss things" failure mode this
  // feature explicitly must avoid). "Composer closes"/"Done" tapped both
  // already close this by unmounting the whole editor.
  const hashtagSuggestionsList =
    activeHashtag && hashtagSuggestions.length > 0 ? (
      <View style={styles.hashtagList}>
        {hashtagSuggestions.map((hashtag, index) => (
          <Pressable
            key={hashtag.name}
            onPress={() => handleSelectHashtag(hashtag)}
            style={[styles.hashtagRow, index > 0 && styles.hashtagRowBorder]}
            accessibilityRole="button"
            accessibilityLabel={`Hashtag ${hashtag.name}, ${formatPostCount(hashtag.postCount)}`}
          >
            <Text style={styles.hashtagName} numberOfLines={1}>
              #{hashtag.name}
            </Text>
            <Text style={styles.hashtagCount}>{formatPostCount(hashtag.postCount)}</Text>
          </Pressable>
        ))}
      </View>
    ) : null;

  return (
    <SafeAreaView style={styles.captionFullScreen} edges={['top', 'bottom']}>
      <KeyboardAvoidingView style={styles.captionFullScreenFlex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.captionFullScreenHeader}>
          <View style={styles.captionFullScreenThumbnailWrap}>
            {photo ? (
              <Image source={{ uri: photo.uri }} style={styles.captionFullScreenThumbnail} resizeMode="cover" />
            ) : (
              <VideoView
                style={styles.captionFullScreenThumbnail}
                player={player}
                contentFit="cover"
                nativeControls={false}
                allowsPictureInPicture={false}
              />
            )}
          </View>
          <Pressable onPress={onDone} style={styles.captionDoneButton} accessibilityRole="button" accessibilityLabel="Done editing caption">
            <Text style={styles.captionDoneButtonText}>Done</Text>
          </Pressable>
        </View>

        <TextInput
          style={styles.captionFullScreenInput}
          placeholder="Add a caption..."
          placeholderTextColor={Colors.textSecondary}
          value={caption}
          onChangeText={onChangeCaption}
          multiline
          autoFocus
          selection={selection}
          onSelectionChange={(event) => setSelection(event.nativeEvent.selection)}
          maxLength={REEL_CAPTION_MAX_LENGTH}
          editable={!isBusy}
        />

        {/* mentionSuggestionsList/captionToolbar carry no horizontal
            padding of their own — normally they sit inside
            HeaderScreenLayout's own padded content box, which this
            full-screen view doesn't have, so this wrapper supplies the
            same inset the input above already has. */}
        <View style={styles.captionFullScreenFooter}>
          {hashtagSuggestionsList}
          {mentionSuggestionsList}
          {captionToolbar}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
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
  // ---- full-screen caption editor (isCaptionFocused) ----
  captionFullScreen: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  captionFullScreenFlex: {
    flex: 1,
  },
  captionFullScreenHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
  },
  // Same 9:14 media aspect ratio as the normal thumbnailWrap above, just
  // much smaller — a reminder of what you're captioning, not something
  // meant to be looked at while writing.
  captionFullScreenThumbnailWrap: {
    width: 44,
    aspectRatio: 9 / 14,
    borderRadius: Radius.md,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  captionFullScreenThumbnail: {
    flex: 1,
  },
  captionDoneButton: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  captionDoneButtonText: {
    color: Colors.accent,
    fontSize: 16,
    fontWeight: '700',
  },
  captionFullScreenInput: {
    flex: 1,
    color: Colors.text,
    fontSize: 17,
    lineHeight: 24,
    textAlignVertical: 'top',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  captionFullScreenFooter: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  charCount: {
    marginLeft: 'auto',
    color: Colors.textSecondary,
    fontSize: 12,
  },
  captionToolbarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  captionToolbarButton: {
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  captionToolbarButtonText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  // The @ mention suggestion list — same rounded-surface-with-border
  // treatment as every other small dropdown/menu in this app.
  mentionList: {
    marginTop: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  mentionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  mentionRowBorder: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  mentionRowText: {
    flexShrink: 1,
  },
  mentionDisplayName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  mentionUsername: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  // The "#" hashtag suggestion list — same rounded-surface-with-border
  // treatment as mentionList above, just a two-line row (name + post
  // count) instead of an avatar row, matching the hashtag discovery
  // page's own header (Step 2's formatPostCount, reused as-is here).
  hashtagList: {
    marginTop: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  hashtagRow: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: 2,
  },
  hashtagRowBorder: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  hashtagName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  hashtagCount: {
    color: Colors.textSecondary,
    fontSize: 12,
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
