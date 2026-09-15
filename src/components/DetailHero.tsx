import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import type { Timestamp } from 'firebase/firestore';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { MediaCard } from '@/components/MediaCard';
import { Pill } from '@/components/Pill';
import { INTERESTS } from '@/constants/interests';
import { Colors, Spacing, Typography } from '@/constants/theme';
import { isHappeningNow } from '@/utils/dateWindows';

const HERO_HEIGHT = 340;

type DetailHeroProps = {
  title: string;
  categoryId: string;
  startsAt: Timestamp;
  endsAt: Timestamp;
  /** Omit entirely to hide the More button (matches content/[contentId].tsx's existing "no options menu on your own content" rule). */
  onOptionsPress?: () => void;
  /** Step 36 — an Event's own optional cover photo. Omit for Activity (no such field exists) or an Event that never had one; MediaCard falls back to the gradient/emoji exactly as it always has. */
  coverPhotoURL?: string;
};

/**
 * Full-bleed media-first hero shared by Event and Activity detail (Step
 * 29). Uses the real category emoji over the Step 26 gradient/glow
 * MediaCard fallback when there's no real cover photo — Activity still
 * has no image field of its own, and an Event without one falls back the
 * same way; Step 36 wires in a real Event coverPhotoURL when present. A
 * top scrim for the real Back/More controls (the only hero actions — no
 * fake Save/Share/Calendar/Ticket), and a bottom scrim carrying the real
 * category + title. LIVE/Ended uses the exact same `isHappeningNow` check
 * EventCard already uses — never an invented status.
 */
export function DetailHero({ title, categoryId, startsAt, endsAt, onOptionsPress, coverPhotoURL }: DetailHeroProps) {
  const category = INTERESTS.find((interest) => interest.id === categoryId);
  const now = new Date();
  const live = isHappeningNow({ startsAt, endsAt }, now);
  const ended = endsAt.toMillis() <= now.getTime();

  return (
    <MediaCard source={coverPhotoURL} emoji={category?.emoji} height={HERO_HEIGHT} radius={0}>
      <LinearGradient colors={['rgba(10, 10, 13, 0.75)', 'transparent']} style={styles.topScrim} pointerEvents="none" />
      <View style={styles.topRow} pointerEvents="box-none">
        <Pressable onPress={() => router.back()} style={styles.iconButton} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={22} color={Colors.text} />
        </Pressable>
        {onOptionsPress ? (
          <Pressable onPress={onOptionsPress} style={styles.iconButton} hitSlop={8} accessibilityRole="button" accessibilityLabel="More options">
            <Ionicons name="ellipsis-horizontal" size={20} color={Colors.text} />
          </Pressable>
        ) : (
          <View style={styles.iconButton} />
        )}
      </View>

      {live || ended ? (
        <View style={styles.statusRow} pointerEvents="none">
          <Pill label={live ? 'LIVE' : 'Ended'} tone={live ? 'live' : 'neutral'} />
        </View>
      ) : null}

      <LinearGradient colors={['transparent', 'rgba(10, 10, 13, 0.95)']} style={styles.bottomScrim} pointerEvents="none">
        {category ? (
          <Text style={styles.categoryLabel}>
            {category.emoji} {category.label}
          </Text>
        ) : null}
        <Text style={styles.title} numberOfLines={3}>
          {title}
        </Text>
      </LinearGradient>
    </MediaCard>
  );
}

const styles = StyleSheet.create({
  topScrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 80,
  },
  topRow: {
    position: 'absolute',
    top: Spacing.sm,
    left: Spacing.sm,
    right: Spacing.sm,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(10, 10, 13, 0.4)',
  },
  statusRow: {
    position: 'absolute',
    top: 52,
    left: Spacing.md,
  },
  bottomScrim: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.xxl,
    paddingBottom: Spacing.md,
    gap: 2,
  },
  categoryLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  title: {
    color: Colors.text,
    ...Typography.screenTitle,
  },
});
