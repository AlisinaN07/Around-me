import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { Image, StyleSheet, View, type ImageSourcePropType } from 'react-native';

import { Colors, Radius } from '@/constants/theme';

type MediaCardProps = {
  /** Omit when no real media exists — content/{contentId} has no image field today (Step 22 audit). Never pass a fabricated URL. */
  source?: ImageSourcePropType | string | null;
  fallbackIcon?: keyof typeof Ionicons.glyphMap;
  height: number;
  radius?: number;
  children?: ReactNode;
};

/**
 * Cover-image container with a graceful no-media fallback (Step 24) — the
 * shared base for any future media-first card. Content types with no
 * image field today (Post/Activity/Event) render the fallback tone
 * instead of a placeholder stock photo or an invented URL, per the
 * "no hardcoded demo data" rule for this step.
 */
export function MediaCard({ source, fallbackIcon = 'image-outline', height, radius = Radius.lg, children }: MediaCardProps) {
  const resolvedSource = typeof source === 'string' ? { uri: source } : source;
  return (
    <View style={[styles.container, { height, borderRadius: radius }]}>
      {resolvedSource ? (
        <Image source={resolvedSource} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.fallback]}>
          <Ionicons name={fallbackIcon} size={28} color={Colors.textMuted} />
        </View>
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
    backgroundColor: Colors.surfaceSoft,
  },
});
