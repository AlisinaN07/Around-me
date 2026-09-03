import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { VideoView, useVideoPlayer } from 'expo-video';

import { AuthorLink } from '@/components/AuthorLink';
import { Avatar } from '@/components/Avatar';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { INTERESTS } from '@/constants/interests';
import { resolveReelPlaybackUrl } from '@/services/reels';
import type { Reel } from '@/types/reel';

type ReelFeedItemProps = {
  reel: Reel;
  height: number;
  isActive: boolean;
  isOwnReel: boolean;
  onOpenOptions: () => void;
};

const CATEGORY_LABEL_BY_ID = new Map(INTERESTS.map((interest) => [interest.id, `${interest.emoji} ${interest.label}`]));

/**
 * One page of the vertical Reels feed. Owns its own video player instance
 * (only ever plays when `isActive`) — see ReelsScreen for how activity is
 * tracked and how only one item is ever active at a time.
 */
export function ReelFeedItem({ reel, height, isActive, isOwnReel, onOpenOptions }: ReelFeedItemProps) {
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [urlStatus, setUrlStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [muted, setMuted] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // Resets fresh whenever the item's own reel (and therefore its
    // storagePath) changes — the same prop-driven-reset pattern already
    // used in ReportModal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUrlStatus('loading');
    resolveReelPlaybackUrl(reel.storagePath).then((url) => {
      if (cancelled) return;
      if (url) {
        setPlaybackUrl(url);
        setUrlStatus('ready');
      } else {
        setUrlStatus('error');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [reel.storagePath]);

  const player = useVideoPlayer(playbackUrl, (p) => {
    p.loop = true;
    // Muted by default — browser autoplay policy blocks unmuted autoplay
    // (see the Step 18 spec's web-autoplay note). The mute control below
    // lets the viewer opt into sound once a video is already playing.
    p.muted = true;
  });

  useEffect(() => {
    if (isActive && urlStatus === 'ready') {
      player.play();
    } else {
      player.pause();
    }
  }, [isActive, urlStatus, player]);

  const categoryLabel = CATEGORY_LABEL_BY_ID.get(reel.categoryId);

  return (
    <View style={[styles.page, { height }]}>
      {urlStatus === 'ready' && playbackUrl ? (
        <VideoView
          style={StyleSheet.absoluteFill}
          player={player}
          contentFit="cover"
          nativeControls={false}
          allowsPictureInPicture={false}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.mediaFallback]}>
          {urlStatus === 'loading' ? (
            <ActivityIndicator color={Colors.textSecondary} />
          ) : (
            <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
          )}
        </View>
      )}

      <Pressable
        style={styles.muteButton}
        onPress={() => {
          const next = !muted;
          setMuted(next);
          // expo-video's player is an imperative external handle (a
          // SharedObject) — setting properties like `muted` directly is
          // its documented API, not React state; this mutation belongs in
          // an event handler, not a render body or effect.
          // eslint-disable-next-line react-hooks/immutability
          player.muted = next;
        }}
        accessibilityRole="button"
        accessibilityLabel={muted ? 'Unmute' : 'Mute'}
      >
        <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={18} color={Colors.text} />
      </Pressable>

      {!isOwnReel && (
        <Pressable style={styles.optionsButton} onPress={onOpenOptions} accessibilityRole="button" accessibilityLabel="Reel options">
          <Ionicons name="ellipsis-horizontal" size={20} color={Colors.text} />
        </Pressable>
      )}

      <View style={styles.overlay} pointerEvents="box-none">
        <AuthorLink uid={reel.authorUid} style={styles.authorRow}>
          <Avatar name={reel.authorDisplayName} size={36} />
          <View>
            <Text style={styles.authorName}>{reel.authorDisplayName}</Text>
            <Text style={styles.authorUsername}>@{reel.authorUsername}</Text>
          </View>
        </AuthorLink>

        {reel.caption ? <Text style={styles.caption}>{reel.caption}</Text> : null}

        {categoryLabel ? (
          <View style={styles.categoryChip}>
            <Text style={styles.categoryText}>{categoryLabel}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    width: '100%',
    backgroundColor: Colors.background,
    justifyContent: 'flex-end',
  },
  mediaFallback: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  muteButton: {
    position: 'absolute',
    top: Spacing.lg,
    right: Spacing.lg,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
  },
  optionsButton: {
    position: 'absolute',
    top: Spacing.lg,
    right: Spacing.lg + 44,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
  },
  overlay: {
    padding: Spacing.lg,
    gap: Spacing.sm,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    alignSelf: 'flex-start',
  },
  authorName: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  authorUsername: {
    color: 'rgba(245, 245, 247, 0.75)',
    fontSize: 13,
  },
  caption: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 20,
  },
  categoryChip: {
    alignSelf: 'flex-start',
    borderRadius: Radius.full,
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  categoryText: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
});
