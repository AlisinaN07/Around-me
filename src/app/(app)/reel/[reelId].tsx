import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import { AuthorLink } from '@/components/AuthorLink';
import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ReelEngagementSection } from '@/components/ReelEngagementSection';
import { ReportModal } from '@/components/ReportModal';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { blockUser, isUserBlocked, unblockUser } from '@/services/blocks';
import { fetchReel, resolveReelPlaybackUrl } from '@/services/reels';
import type { Reel } from '@/types/reel';
import { formatTimeAgo } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';
type UrlStatus = 'loading' | 'ready' | 'error';

const CATEGORY_LABEL_BY_ID = new Map(INTERESTS.map((interest) => [interest.id, `${interest.emoji} ${interest.label}`]));
const PLAYER_HEIGHT = 480;

export default function ReelDetailScreen() {
  const { reelId } = useLocalSearchParams<{ reelId: string }>();
  const { user } = useAuth();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [reel, setReel] = useState<Reel | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [urlStatus, setUrlStatus] = useState<UrlStatus>('loading');
  const [playbackFailed, setPlaybackFailed] = useState(false);

  const [amIBlockingThem, setAmIBlockingThem] = useState(false);
  const [isBlockSubmitting, setIsBlockSubmitting] = useState(false);
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
  const [isBlockConfirmOpen, setIsBlockConfirmOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);

  const isOwnReel = !!user && !!reel && reel.authorUid === user.uid;

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const result = await fetchReel(reelId);
      if (!result || result.status !== 'published') {
        setStatus('error');
        return;
      }
      setReel(result);
      if (user && result.authorUid !== user.uid) {
        const blocked = await isUserBlocked(user.uid, result.authorUid);
        setAmIBlockingThem(blocked);
      }
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [reelId, user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const resolveUrl = useCallback(async () => {
    if (!reel) return;
    setUrlStatus('loading');
    setPlaybackFailed(false);
    const url = await resolveReelPlaybackUrl(reel.storagePath);
    if (url) {
      setPlaybackUrl(url);
      setUrlStatus('ready');
    } else {
      setUrlStatus('error');
    }
  }, [reel]);

  useEffect(() => {
    if (reel) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      resolveUrl();
    }
  }, [reel, resolveUrl]);

  const player = useVideoPlayer(playbackUrl, (p) => {
    p.loop = true;
    p.muted = true;
  });

  useEffect(() => {
    const subscription = player.addListener('statusChange', ({ status: playerStatus }) => {
      if (playerStatus === 'error') {
        setPlaybackFailed(true);
      }
    });
    return () => subscription.remove();
  }, [player]);

  useEffect(() => {
    if (urlStatus === 'ready' && !playbackFailed) {
      player.play();
    }
  }, [urlStatus, playbackFailed, player]);

  const handleRetryPlayback = async () => {
    // Forces the player to actually release and recreate (see
    // ReelFeedItem's preload strategy for why passing null as the
    // useVideoPlayer source triggers this) rather than reusing a player
    // instance that already failed to load.
    setPlaybackUrl(null);
    await resolveUrl();
  };

  const handleConfirmBlock = async () => {
    if (!user || !reel || isBlockSubmitting) return;
    setIsBlockSubmitting(true);
    const result = await blockUser(user.uid, reel.authorUid);
    setIsBlockSubmitting(false);
    setIsBlockConfirmOpen(false);
    if (result.ok) {
      setAmIBlockingThem(true);
    }
  };

  const handleUnblock = async () => {
    if (!user || !reel || isBlockSubmitting) return;
    setIsBlockSubmitting(true);
    const result = await unblockUser(user.uid, reel.authorUid);
    setIsBlockSubmitting(false);
    if (result.ok) {
      setAmIBlockingThem(false);
    }
  };

  const optionsMenuOptions: OptionsMenuOption[] = amIBlockingThem
    ? [
        { label: `Unblock ${reel?.authorDisplayName ?? 'this user'}`, onPress: handleUnblock },
        { label: 'Report reel', onPress: () => setIsReportOpen(true) },
      ]
    : [
        { label: `Block ${reel?.authorDisplayName ?? 'this user'}`, onPress: () => setIsBlockConfirmOpen(true), destructive: true },
        { label: 'Report reel', onPress: () => setIsReportOpen(true) },
      ];

  const categoryLabel = reel ? CATEGORY_LABEL_BY_ID.get(reel.categoryId) : undefined;

  return (
    <HeaderScreenLayout
      title="Reel"
      headerRight={
        status === 'loaded' && reel && !isOwnReel ? (
          <Pressable
            onPress={() => setIsOptionsMenuOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="More options"
            style={styles.overflowButton}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={Colors.textSecondary} />
          </Pressable>
        ) : undefined
      }
    >
      {status === 'loading' ? (
        <View style={styles.centered}>
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      ) : status === 'error' || !reel ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.errorTitle}>Couldn&apos;t load this Reel.</Text>
          <Button label="Try again" onPress={load} />
        </View>
      ) : (
        <View style={styles.container}>
          <View style={styles.playerWrap}>
            {urlStatus === 'ready' && playbackUrl && !playbackFailed ? (
              <VideoView style={StyleSheet.absoluteFill} player={player} contentFit="contain" nativeControls allowsPictureInPicture={false} />
            ) : (
              <View style={[StyleSheet.absoluteFill, styles.mediaFallback]}>
                {urlStatus === 'loading' ? (
                  <ActivityIndicator color={Colors.textSecondary} />
                ) : (
                  <View style={styles.playbackErrorState}>
                    <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
                    <Text style={styles.playbackErrorText}>Couldn&apos;t play this Reel</Text>
                    <Pressable onPress={handleRetryPlayback} accessibilityRole="button">
                      <Text style={styles.retryLink}>Retry</Text>
                    </Pressable>
                  </View>
                )}
              </View>
            )}
          </View>

          <AuthorLink uid={reel.authorUid} style={styles.authorRow}>
            <Avatar name={reel.authorDisplayName} size={40} />
            <View>
              <Text style={styles.authorName}>{reel.authorDisplayName}</Text>
              <Text style={styles.authorUsername}>@{reel.authorUsername}</Text>
            </View>
          </AuthorLink>

          {reel.caption ? <Text style={styles.caption}>{reel.caption}</Text> : null}

          <View style={styles.metaRow}>
            {categoryLabel ? (
              <View style={styles.categoryPill}>
                <Text style={styles.categoryText}>{categoryLabel}</Text>
              </View>
            ) : null}
            {reel.publishedAt ? <Text style={styles.time}>{formatTimeAgo(reel.publishedAt.toDate())}</Text> : null}
          </View>

          <ReelEngagementSection reelId={reel.reelId} />
        </View>
      )}

      <OptionsMenu visible={isOptionsMenuOpen} onClose={() => setIsOptionsMenuOpen(false)} options={optionsMenuOptions} />

      <ConfirmDialog
        visible={isBlockConfirmOpen}
        title={reel ? `Block ${reel.authorDisplayName}?` : ''}
        message="They won't be able to follow, like or comment on your content, or message you while blocked."
        confirmLabel="Block"
        isSubmitting={isBlockSubmitting}
        onConfirm={handleConfirmBlock}
        onCancel={() => setIsBlockConfirmOpen(false)}
      />

      {user && reel ? (
        <ReportModal
          visible={isReportOpen}
          onClose={() => setIsReportOpen(false)}
          reporterUid={user.uid}
          target={{ type: 'reel', reelId: reel.reelId }}
        />
      ) : null}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.xxl,
  },
  loadingText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  errorTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  overflowButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    gap: Spacing.sm,
  },
  playerWrap: {
    width: '100%',
    height: PLAYER_HEIGHT,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
  },
  mediaFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  playbackErrorState: {
    alignItems: 'center',
    gap: Spacing.xs,
  },
  playbackErrorText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  retryLink: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  authorName: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  authorUsername: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  caption: {
    color: Colors.text,
    fontSize: 15,
    lineHeight: 21,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  categoryPill: {
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  categoryText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
});
