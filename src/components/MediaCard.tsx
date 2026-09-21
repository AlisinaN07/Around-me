import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius } from '@/constants/theme';

type MediaCardProps = {
  /** Omit when no real media exists — content/{contentId} has no image field today (Step 22 audit). Never pass a fabricated URL. Always a remote HTTPS URL in practice (a Reel thumbnail or Event coverPhotoURL) — never a local `require()` asset, so this is typed as a plain string rather than RN's broader `ImageSourcePropType`. */
  source?: string | null;
  /**
   * A real category emoji (see src/constants/interests.ts) to show large in
   * the fallback — preferred over `fallbackIcon` when the caller has one,
   * since it reads as more premium/intentional than a generic outline icon
   * (Step 26). Never invent an emoji unrelated to the item's real category.
   */
  emoji?: string;
  fallbackIcon?: keyof typeof Ionicons.glyphMap;
  /** A fixed pixel height, or a percentage string to fill a sized parent (e.g. ReelPreviewCard's aspectRatio box). */
  height: number | `${number}%`;
  radius?: number;
  /** False removes the 1px border — for a full-bleed hero (DetailHero) where a border reads as a stray rectangle around the edge-to-edge photo. Every other caller keeps the default border. */
  bordered?: boolean;
  children?: ReactNode;
};

/**
 * Cover-image container with a graceful no-media fallback (Step 24, glow
 * fallback added Step 26) — the shared base for any media-first card.
 * Content types with no image field render a dark gradient + soft accent
 * glow + category emoji/icon instead of a placeholder stock photo or an
 * invented URL, per the "no hardcoded demo data" rule. `source` was left
 * optional and unused when this component was first built so real media
 * could be wired in later without changing its shape — Step 36 is the
 * first to actually do that, passing an Event's own optional
 * coverPhotoURL (see EventCard.tsx's eventCoverSource helper). Activity
 * and Post still have no image field of their own, so they still always
 * fall through to the gradient/emoji fallback.
 *
 * Perf pass — `expo-image` instead of React Native's own `Image`: this is
 * the shared base every Event card (EventCard.tsx, 3 size variants),
 * Event detail hero (DetailHero.tsx), and Reel grid thumbnail
 * (ReelPreviewCard.tsx) renders through, so a real memory+disk cache here
 * covers all of them from one place. `cachePolicy="memory-disk"` — the
 * URL itself (an Event's coverPhotoURL or a Reel's resolved thumbnail
 * URL) is already a stable, unique key, no custom cache-key needed.
 * `contentFit="cover"` matches the plain `<Image>`'s own prior
 * `resizeMode="cover"` exactly — behavior-neutral.
 */
export function MediaCard({ source, emoji, fallbackIcon = 'image-outline', height, radius = Radius.lg, bordered = true, children }: MediaCardProps) {
  return (
    <View style={[styles.container, { height, borderRadius: radius }, !bordered && styles.borderless]}>
      {source ? (
        <Image source={{ uri: source }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" />
      ) : (
        <LinearGradient colors={[Colors.surfaceSoft, Colors.surface]} style={[StyleSheet.absoluteFill, styles.fallback]}>
          <View style={styles.glow} />
          {emoji ? <Text style={styles.fallbackEmoji}>{emoji}</Text> : <Ionicons name={fallbackIcon} size={28} color={Colors.textMuted} />}
        </LinearGradient>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  borderless: {
    borderWidth: 0,
  },
  fallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    top: '-30%',
    right: '-20%',
    width: '80%',
    height: '140%',
    borderRadius: 999,
    backgroundColor: Colors.accentMuted,
  },
  fallbackEmoji: {
    fontSize: 34,
  },
});
