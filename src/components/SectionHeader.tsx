import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing, Typography } from '@/constants/theme';

type SectionHeaderProps = {
  title: string;
  /** Optional content next to the title — e.g. a "LIVE" pill for Happening Now (Step 26). */
  badge?: ReactNode;
  actionLabel?: string;
  onActionPress?: () => void;
};

export function SectionHeader({ title, badge, actionLabel, onActionPress }: SectionHeaderProps) {
  return (
    <View style={styles.container}>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        {badge}
      </View>
      {actionLabel ? (
        <Pressable onPress={onActionPress} hitSlop={8} accessibilityRole="button">
          <Text style={styles.action}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  title: {
    color: Colors.text,
    ...Typography.sectionTitle,
  },
  action: {
    color: Colors.accent,
    ...Typography.caption,
  },
});
