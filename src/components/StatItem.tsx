import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing, Typography } from '@/constants/theme';

type StatItemProps = {
  value: number | string;
  label: string;
  onPress?: () => void;
};

/** Number-over-label stat — profile counts (Posts/Following/Followers) and similar. Real values only. */
export function StatItem({ value, label, onPress }: StatItemProps) {
  const Container = onPress ? Pressable : View;
  return (
    <Container
      onPress={onPress}
      style={styles.item}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={onPress ? `${value} ${label}` : undefined}
    >
      <Text style={styles.value}>{value}</Text>
      <Text style={styles.label}>{label}</Text>
    </Container>
  );
}

const styles = StyleSheet.create({
  item: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: Spacing.sm,
  },
  value: {
    color: Colors.text,
    ...Typography.stat,
  },
  label: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
});
