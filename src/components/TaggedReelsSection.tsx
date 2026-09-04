import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MediaCard } from '@/components/MediaCard';
import { Colors, Radius, Spacing, Typography } from '@/constants/theme';
import type { Reel } from '@/types/reel';

type TaggedReelsSectionProps = {
  /** The Place these Reels are tagged at — drives the "Tagged at {name}" label. */
  placeName: string | null;
  /** Real, already-fetched Reels only — never a placeholder. Renders nothing when empty. */
  reels: Reel[];
};

/**
 * Future visual architecture for Step 29's core "Tagged at {Place}"
 * product concept (see README "Event Detail — Tagged at {Place}"): these
 * would be ORDINARY user-generated Reels from the normal Home feed that
 * happen to be tagged to the same Place/venue as this Event — never a
 * special "Event Reel" content type, and never rendered here as fake data.
 *
 * Deliberately unused in production as of Step 29: `Reel` has no
 * `placeId` field yet (Step 29 explicitly does not add one), so no real
 * caller can ever pass a non-empty `reels` array today. This component
 * exists purely so the visual slot — label logic, card shape, tap
 * routing — is ready the moment real tagging architecture is built,
 * without inventing any Reel data now.
 */
export function TaggedReelsSection({ placeName, reels }: TaggedReelsSectionProps) {
  if (reels.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.title}>{placeName ? `Tagged at ${placeName}` : 'Tagged Reels'}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.rail}>
        {reels.map((reel) => (
          <Pressable
            key={reel.reelId}
            style={styles.card}
            onPress={() => router.push(`/reel/${reel.reelId}`)}
            accessibilityRole="button"
            accessibilityLabel="View Reel"
          >
            <MediaCard fallbackIcon="videocam" height="100%" radius={Radius.md}>
              <View style={styles.overlay}>
                <Ionicons name="play" size={14} color={Colors.text} />
              </View>
            </MediaCard>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: Spacing.sm,
  },
  title: {
    color: Colors.text,
    ...Typography.sectionTitle,
  },
  rail: {
    gap: Spacing.sm,
  },
  card: {
    width: 110,
    aspectRatio: 9 / 16,
  },
  overlay: {
    flex: 1,
    padding: Spacing.xs,
  },
});
