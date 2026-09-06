import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MediaCard } from '@/components/MediaCard';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { Reel } from '@/types/reel';
import { formatTimeAgo } from '@/utils/timeFormat';

/**
 * A compact preview for one published Reel — used on Profile's Reels tab
 * (own and public). No thumbnail generation (explicitly out of scope for
 * Step 19): the same dark-gradient + accent-glow fallback introduced for
 * Event cards in Step 26 (via MediaCard) stands in for a real video
 * frame, so this never has to load/decode any video just to render a
 * grid — a premium "media-first" look without inventing media.
 */
export function ReelPreviewCard({ reel }: { reel: Reel }) {
  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/reel/${reel.reelId}`)}
      accessibilityRole="button"
      accessibilityLabel="View post"
    >
      <MediaCard fallbackIcon="videocam" height="100%" radius={Radius.md}>
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
