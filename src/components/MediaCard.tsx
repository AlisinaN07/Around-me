import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Image, StyleSheet, Text, View, type ImageSourcePropType } from 'react-native';

import { Colors, Radius } from '@/constants/theme';

type MediaCardProps = {
  /** Omit when no real media exists — content/{contentId} has no image field today (Step 22 audit). Never pass a fabricated URL. */
  source?: ImageSourcePropType | string | null;
  /**
   * A real category emoji (see src/constants/interests.ts) to show large in
   * the fallback — preferred over `fallbackIcon` when the caller has one,
   * since it reads as more premium/intentional than a generic outline icon
   * (Step 26). Never invent an emoji unrelated to the item's real category.
   */
  emoji?: string;
  fallbackIcon?: keyof typeof Ionicons.glyphMap;
  height: number;
  radius?: number;
  children?: ReactNode;
};

/**
 * Cover-image container with a graceful no-media fallback (Step 24, glow
 * fallback added Step 26) — the shared base for any media-first card.
 * Content types with no image field today (Post/Activity/Event) render a
 * dark gradient + soft accent glow + category emoji/icon instead of a
 * placeholder stock photo or an invented URL, per the "no hardcoded demo
 * data" rule. `source` stays fully optional and unused today — real media
 * can be wired in later without changing this component's shape.
 */
export function MediaCard({ source, emoji, fallbackIcon = 'image-outline', height, radius = Radius.lg, children }: MediaCardProps) {
  const resolvedSource = typeof source === 'string' ? { uri: source } : source;
  return (
    <View style={[styles.container, { height, borderRadius: radius }]}>
      {resolvedSource ? (
        <Image source={resolvedSource} style={StyleSheet.absoluteFill} resizeMode="cover" />
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
