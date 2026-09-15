import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { setPendingPreselectedSound } from '@/services/reelCameraHandoff';
import { fetchReelsByMusicHash, resolveOwnSoundOrigin } from '@/services/reels';
import { isPostSaved, savePost, unsavePost } from '@/services/saved';
import { addReelToMyStory, resolveSoundAudioUrl } from '@/services/stories';
import { fetchPublicProfile } from '@/services/publicProfile';
import type { Reel, SelectedReelMusic } from '@/types/reel';
import type { PublicProfile } from '@/types/social';

type LoadStatus = 'loading' | 'loaded' | 'error';

// How far (px) a drag on the header/grabber zone has to travel before it
// counts as a deliberate swipe rather than an accidental wobble — same
// threshold value and reasoning as SwipeBackEdge's own SWIPE_BACK_THRESHOLD.
const SWIPE_TOGGLE_THRESHOLD = 60;

type SoundSheetProps = {
  visible: boolean;
  /**
   * The Reel this sheet was opened from/about — a video, with either
   * picked music (a real musicHash/soundOriginAuthorUid already) or its
   * own captured audio (musicSourceType 'none', musicHash still '' until
   * resolveOwnSoundOrigin runs below — see this component's own doc
   * comment). ReelFeedItem never renders the trigger that opens this
   * sheet for a photo (no audio at all) or for picked music with no
   * resolved origin yet. Also exactly what "Add to Story" reshares.
   */
  reel: Reel;
  onClose: () => void;
  onToast: (message: string) => void;
};

/**
 * The "whose sound is this" bottom sheet — origin account, every
 * currently-published Reel sharing that exact sound (oldest/"Original"
 * first), and two real actions: "Use audio" (starts a brand new post
 * pre-loaded with this exact sound — see reelCameraHandoff's
 * pendingPreselectedSound) and "Add to Story" (reshares THIS sheet's own
 * `reel` — the one that was actually playing when it was opened — as the
 * viewer's own new Story; see addReelToMyStory's own doc comment in
 * functions/src/index.ts for why that has to be a trusted backend call).
 * No "Save" toggle here is fake: it's a real users/{uid}/saved entry
 * (targetType 'sound', targetId the musicHash), browsable later from the
 * Saved tab on Profile (src/app/(app)/(tabs)/profile.tsx).
 *
 * A Reel with its own captured audio (no picked music) gets the exact
 * same Save/Use-audio experience as real picked music — just resolved
 * LAZILY, the first time anyone actually opens this sheet for it (see
 * resolveOwnSoundOrigin's own doc comment in functions/src/index.ts for
 * why that has to be on-demand rather than run on every ordinary video's
 * publish). `musicHash`/`originAuthorUid` below start from whatever the
 * Reel prop already carries and only ever move from empty to resolved
 * within this component's own lifetime — never back.
 */
export function SoundSheet({ visible, reel, onClose, onToast }: SoundSheetProps) {
  const { user } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [originProfile, setOriginProfile] = useState<PublicProfile | null>(null);
  const [soundReels, setSoundReels] = useState<Reel[]>([]);
  const [isSaved, setIsSaved] = useState(false);
  const [isSaveSubmitting, setIsSaveSubmitting] = useState(false);
  const [isUsingAudio, setIsUsingAudio] = useState(false);
  const [isAddingToStory, setIsAddingToStory] = useState(false);
  const [musicHash, setMusicHash] = useState(reel.musicHash);
  const [originAuthorUid, setOriginAuthorUid] = useState(reel.soundOriginAuthorUid || reel.authorUid);
  // Two sizes only, toggled by the swipe gesture on the grabber/header
  // drag zone below — starts collapsed (the normal partial-height sheet)
  // every time this sheet opens fresh, same as status/originProfile/etc.
  const [isExpanded, setIsExpanded] = useState(false);

  // Swipe UP on the drag zone while collapsed → expand to full height;
  // swipe RIGHT on it while expanded → fold back down to the normal
  // partial sheet. Recreated whenever isExpanded changes so each gesture
  // always checks against the CURRENT size, not the one from when this
  // sheet first mounted — same reasoning as SwipeBackEdge's own
  // onBack-dependent panResponder.
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          isExpanded
            ? gesture.dx > 10 && gesture.dx > Math.abs(gesture.dy) * 1.5
            : gesture.dy < -10 && Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.5,
        onPanResponderRelease: (_event, gesture) => {
          if (isExpanded) {
            if (gesture.dx >= SWIPE_TOGGLE_THRESHOLD) setIsExpanded(false);
          } else if (gesture.dy <= -SWIPE_TOGGLE_THRESHOLD) {
            setIsExpanded(true);
          }
        },
      }),
    [isExpanded]
  );

  // Loads fresh every time the sheet actually opens for this sound —
  // never stale data left over from a previously-viewed one.
  useEffect(() => {
    if (!visible || !user) return;
    let cancelled = false;
    // Resets fresh every time the sheet opens — same prop-driven-reset
    // pattern as ReelFeedItem/ReportModal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsExpanded(false);

    (async () => {
      let hash = musicHash;
      let originUid = originAuthorUid;

      // Own captured audio, never resolved before — resolve it now,
      // exactly once, before doing anything else. A failure here just
      // means `hash` stays '' and this falls through to the degraded
      // "just this one Reel, no Save/Use-audio" view below, same as
      // before this sheet supported resolving own audio at all.
      if (!hash && reel.musicSourceType !== 'device') {
        const result = await resolveOwnSoundOrigin(reel.reelId);
        if (cancelled) return;
        if (result.ok) {
          hash = result.musicHash;
          originUid = result.originAuthorUid;
          setMusicHash(hash);
          setOriginAuthorUid(originUid);
        }
      }

      if (!hash) {
        const profile = await fetchPublicProfile(originUid);
        if (cancelled) return;
        setOriginProfile(profile);
        setSoundReels([reel]);
        setIsSaved(false);
        setStatus('loaded');
        return;
      }

      const [profile, reels, saved] = await Promise.all([
        fetchPublicProfile(originUid),
        fetchReelsByMusicHash(hash),
        isPostSaved(user.uid, 'sound', hash),
      ]);
      if (cancelled) return;
      setOriginProfile(profile);
      setSoundReels(reels);
      setIsSaved(saved);
      setStatus('loaded');
    })().catch(() => {
      if (!cancelled) setStatus('error');
    });

    return () => {
      cancelled = true;
    };
    // musicHash/originAuthorUid are deliberately NOT dependencies — this
    // effect reads their current value once per open and may itself set
    // them; re-running when they change would just loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, reel, user]);

  const handleClose = () => {
    setStatus('loading');
    setOriginProfile(null);
    setSoundReels([]);
    setIsExpanded(false);
    onClose();
  };

  const handleOpenReel = (reelId: string) => {
    // Deliberately doesn't call handleClose() here — this sheet's mount
    // point (ReelFeedItem/Profile) gates the actual Modal `visible` prop
    // on its own screen's focus state (useIsFocused), not just this
    // `visible` prop alone, so pushing this new screen hides it exactly
    // the same way tapping the backdrop would, but WITHOUT forgetting it
    // was open — coming back here (router.back()) refocuses that screen
    // and this sheet reappears on its own, still showing this same sound.
    //
    // musicHash tags this navigation so the detail screen swipes through
    // the OTHER posts sharing this sound (see its own doc comment) rather
    // than defaulting to that Reel's author's unrelated Posts. Omitted
    // when musicHash itself never resolved (the degraded, single-Reel
    // view) — same as the Save/Use-audio gates above.
    router.push(musicHash ? { pathname: '/reel/[reelId]', params: { reelId, musicHash } } : `/reel/${reelId}`);
  };

  const handleToggleSave = async () => {
    if (!user || isSaveSubmitting || !musicHash) return;
    const wasSaved = isSaved;
    setIsSaveSubmitting(true);
    const result = wasSaved ? await unsavePost(user.uid, 'sound', musicHash) : await savePost(user.uid, 'sound', musicHash);
    setIsSaveSubmitting(false);
    if (!result.ok) {
      onToast(result.message);
      return;
    }
    setIsSaved(!wasSaved);
    onToast(wasSaved ? 'Removed from saved' : 'Sound saved');
  };

  const handleUseAudio = async () => {
    if (isUsingAudio || !musicHash) return;
    const origin = soundReels[0];
    if (!origin) return;
    setIsUsingAudio(true);
    const url = await resolveSoundAudioUrl(musicHash);
    setIsUsingAudio(false);
    if (!url) {
      onToast("This sound isn't available to reuse right now.");
      return;
    }
    const candidate: SelectedReelMusic = {
      uri: url,
      title: origin.musicTitle,
      fileSizeBytes: origin.musicFileSizeBytes,
      mimeType: origin.musicStorageContentType,
      durationMs: origin.musicDurationMs > 0 ? origin.musicDurationMs : null,
    };
    setPendingPreselectedSound(candidate);
    handleClose();
    router.push('/create/reel/camera');
  };

  const handleAddToStory = async () => {
    if (isAddingToStory) return;
    setIsAddingToStory(true);
    const result = await addReelToMyStory(reel.reelId);
    setIsAddingToStory(false);
    onToast(result.ok ? 'Added to your Story' : result.message);
    if (result.ok) handleClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} accessibilityRole="button" accessibilityLabel="Close" />

        <View style={[styles.sheetOuter, isExpanded && styles.sheetOuterExpanded]}>
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            {/* The drag handle — swipe up here to expand to full height,
                swipe right here (once expanded) to fold back down. Only
                the grabber/header zone carries panHandlers, never the
                grid below, so this never fights the grid's own vertical
                ScrollView for a touch. */}
            <View {...panResponder.panHandlers}>
              <View style={styles.grabberRow}>
                <View style={styles.grabber} />
              </View>

              {status === 'loaded' && originProfile ? (
                <View style={styles.header}>
                  <View style={styles.headerAvatarRing}>
                    <Avatar name={originProfile.displayName} photoURL={originProfile.photoURL} size={64} />
                  </View>
                  <View style={styles.headerText}>
                    <Text style={styles.headerTitle}>Original audio</Text>
                    <Text style={styles.headerSubtitle} numberOfLines={1}>
                      {originProfile.displayName} · {soundReels.length} post{soundReels.length === 1 ? '' : 's'}
                    </Text>
                  </View>
                  {/* Only once musicHash actually resolved — either real
                      picked music, or this Reel's own audio successfully
                      hashed above. Never shown while that failed/is
                      unresolved — nothing real to save yet. */}
                  {!musicHash ? null : (
                    <Pressable
                      onPress={handleToggleSave}
                      disabled={isSaveSubmitting}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={isSaved ? 'Remove from saved' : 'Save sound'}
                    >
                      <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={24} color={isSaved ? Colors.accent : Colors.text} />
                    </Pressable>
                  )}
                </View>
              ) : null}
            </View>

            {status === 'loading' ? (
              <View style={styles.centered}>
                <ActivityIndicator color={Colors.textSecondary} />
              </View>
            ) : status === 'error' || !originProfile ? (
              <View style={styles.centered}>
                <Text style={styles.errorText}>Couldn&apos;t load this sound.</Text>
              </View>
            ) : (
              <>
                <ScrollView style={styles.gridScroll} showsVerticalScrollIndicator={false}>
                  <View style={styles.grid}>
                    {soundReels.map((item, index) => (
                      <View key={item.reelId} style={styles.gridItem}>
                        {index === 0 ? (
                          <View style={styles.originBadge} pointerEvents="none">
                            <Text style={styles.originBadgeText}>Original</Text>
                          </View>
                        ) : null}
                        <ReelPreviewCard reel={item} onPress={() => handleOpenReel(item.reelId)} style={styles.gridCard} />
                      </View>
                    ))}
                  </View>
                </ScrollView>

                <View style={styles.actionsRow}>
                  <View style={styles.actionButtonWrap}>
                    <Pressable
                      onPress={handleAddToStory}
                      disabled={isAddingToStory}
                      style={styles.secondaryButton}
                      accessibilityRole="button"
                      accessibilityLabel="Add to Story"
                    >
                      {isAddingToStory ? (
                        <ActivityIndicator size="small" color={Colors.text} />
                      ) : (
                        <>
                          <Ionicons name="add-circle-outline" size={18} color={Colors.text} />
                          <Text style={styles.secondaryButtonText}>Add to Story</Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                  {/* Same musicHash-resolved gate as Save above — once
                      resolved, a permanent copy always exists (see
                      resolveOwnSoundOrigin/muxReelMusic/renderPhotoToVideo). */}
                  {!musicHash ? null : (
                    <View style={styles.actionButtonWrap}>
                      <Pressable
                        onPress={handleUseAudio}
                        disabled={isUsingAudio}
                        style={styles.primaryButton}
                        accessibilityRole="button"
                        accessibilityLabel="Use audio"
                      >
                        {isUsingAudio ? (
                          <ActivityIndicator size="small" color={Colors.background} />
                        ) : (
                          <>
                            <Ionicons name="videocam" size={18} color={Colors.background} />
                            <Text style={styles.primaryButtonText}>Use audio</Text>
                          </>
                        )}
                      </Pressable>
                    </View>
                  )}
                </View>
              </>
            )}
          </SafeAreaView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  // A fixed height (not maxHeight) — otherwise this View shrink-wraps to
  // its content and never actually reaches the full sheet size the user
  // expects; gridScroll below (flex: 1) is what makes the grid stretch to
  // fill whatever room that leaves above the actions row.
  sheetOuter: {
    height: '75%',
  },
  // Swiped-up state — near-full-screen, leaving just enough at the very
  // top to still show a sliver of the reel behind it (and keep the
  // rounded top corners meaningful) rather than a flush 100%.
  sheetOuterExpanded: {
    height: '94%',
  },
  sheet: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    overflow: 'hidden',
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  grabberRow: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.border,
  },
  centered: {
    minHeight: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingBottom: Spacing.md,
  },
  headerAvatarRing: {
    borderWidth: 2,
    borderColor: Colors.accent,
    borderRadius: Radius.full,
    padding: 2,
  },
  headerText: {
    flex: 1,
    gap: 3,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 19,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  // Stretches to fill whatever vertical room sheetOuter's fixed height
  // leaves above the actions row (rather than a hardcoded maxHeight),
  // scrolling if there are more sound-sharing posts than fit.
  gridScroll: {
    width: '100%',
    flex: 1,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: Spacing.sm,
    rowGap: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  // Width lives here, not on gridCard below — this View is the flex-wrap
  // child with a real, well-defined width; ReelPreviewCard's own
  // Pressable has no intrinsic size of its own to resolve a percentage
  // against, so putting '48.5%' there instead collapsed to a few px.
  gridItem: {
    position: 'relative',
    width: '31.3%',
  },
  // Fills gridItem above. aspectRatio overrides ReelPreviewCard's default
  // 9/16 (full-height reel frame) with a shorter crop, two 20% height
  // trims deep (0.5625 / 0.8 / 0.8 = 0.87890625) — so this grid reads
  // more like a thumbnail strip than a stack of full reel previews.
  gridCard: {
    width: '100%',
    aspectRatio: 0.87890625,
  },
  originBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    zIndex: 1,
    backgroundColor: Colors.accent,
    borderRadius: Radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  originBadgeText: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '800',
  },
  actionsRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingTop: Spacing.md,
  },
  actionButtonWrap: {
    flex: 1,
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    height: 44,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  secondaryButtonText: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    height: 44,
    borderRadius: Radius.full,
    backgroundColor: Colors.text,
  },
  primaryButtonText: {
    color: Colors.background,
    fontSize: 14,
    fontWeight: '700',
  },
});
