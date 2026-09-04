import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Colors, Spacing, Typography } from '@/constants/theme';

type SocialActionProps = {
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon?: keyof typeof Ionicons.glyphMap;
  /** Omit entirely to hide the count label — never pass a fabricated number. */
  count?: number;
  active?: boolean;
  onPress?: () => void;
  label: string;
  size?: number;
};

/**
 * Vertical icon+count action — the shared primitive behind the like/
 * comment/share rail on Reels and (in future steps) Event/Activity detail.
 * Deliberately renders no count at all when `count` is omitted, rather
 * than a "0" or a placeholder dash — several real actions in this app
 * (e.g. a Reel's share count) aren't tracked, and this component must
 * never imply a number that doesn't exist.
 */
export function SocialAction({ icon, activeIcon, count, active, onPress, label, size = 26 }: SocialActionProps) {
  const iconName = active && activeIcon ? activeIcon : icon;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={styles.action}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
    >
      <Ionicons name={iconName} size={size} color={active ? Colors.accent : Colors.text} />
      {count !== undefined ? <Text style={styles.count}>{count}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  action: {
    alignItems: 'center',
    gap: 4,
    paddingVertical: Spacing.xs,
  },
  count: {
    color: Colors.text,
    ...Typography.caption,
  },
});
