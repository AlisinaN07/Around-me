import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { MediaCard } from '@/components/MediaCard';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { resolveReelThumbnailUrl } from '@/services/reels';
import type { Reel } from '@/types/reel';
import { formatTimeAgo } from '@/utils/timeFormat';

/**
 * A compact preview for one published Reel — used on Profile's unified
 * Posts tab (own and public, Step 41.2C). Shows the real cover frame the
 * author chose at capture time (see Reel.thumbnailStoragePath's own doc
 * comment) — a legacy Reel published before that field existed simply has
 * an empty/missing path, so this falls back to the same dark-gradient +
 * accent-glow placeholder introduced for Event cards in Step 26 (via
 * MediaCard) rather than assuming a thumbnail is always there.
 *
 * `style` is optional and additive to the default 3-column grid tile
 * width below — Step 41.2C's merged Posts list overrides it to a
 * full-row layout so a video Post can sit in the same vertical stack as a
 * legacy text Post's ContentCard, without this component needing to know
 * anything about that context.
 *
 * `onPress` is optional and overrides the default "open this Reel" tap —
 * used by a saved-SOUND card (Profile's Saved tab) and SoundSheet's own
 * grid, where the same square thumbnail needs a different action (open
 * the Sound sheet, or nothing extra beyond SoundSheet's own wrapping
 * Pressable) instead of navigating straight to the Reel.
 */
export function ReelPreviewCard({ reel, style, onPress }: { reel: Reel; style?: StyleProp<ViewStyle>; onPress?: () => void }) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Resets fresh whenever the underlying Reel (or its thumbnail path)
    // changes — same prop-driven-reset pattern as ReportModal/ReelFeedItem.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThumbnailUrl(null);
    if (reel.thumbnailStoragePath) {
      // Step 5E — see resolveReelThumbnailUrl's own doc comment: branches
      // on this Reel's OWN persisted thumbnailStorageProvider, not on the
      // app's current config, so a mixed feed of Firebase- and
      // R2-backed thumbnails both resolve correctly here.
      resolveReelThumbnailUrl(reel).then((url) => {
        if (!cancelled) setThumbnailUrl(url);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [reel.thumbnailStoragePath, reel.thumbnailStorageProvider, reel.thumbnailUrl]);

  return (
    <Pressable
      style={[styles.card, style]}
      onPress={onPress ?? (() => router.push(`/reel/${reel.reelId}`))}
      accessibilityRole="button"
      accessibilityLabel="View post"
    >
      <MediaCard source={thumbnailUrl} fallbackIcon="videocam" height="100%" radius={Radius.md}>
        <View style={styles.overlay}>
          <View style={styles.playBadge}>
            <Ionicons name="play" size={16} color={Colors.text} />
          </View>
          {reel.caption ? (
            <Text style={styles.caption} numberOfLines={3}>
              {reel.caption}
            </Text>
          ) : null}
          {reel.publishedAt ? <Text style={styles.time}>{formatTimeAgo(reel.publishedAt.toDate())}</Text> : null}
        </View>
      </MediaCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '31%',
    aspectRatio: 9 / 16,
  },
  overlay: {
    flex: 1,
    justifyContent: 'space-between',
    padding: Spacing.sm,
  },
  playBadge: {
    alignSelf: 'flex-start',
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(11, 11, 15, 0.55)',
  },
  caption: {
    color: Colors.text,
    fontSize: 11,
    lineHeight: 14,
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 10,
  },
});
