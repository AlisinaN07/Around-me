import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';

type DateBadgeProps = {
  date: Date;
};

/**
 * Compact weekday/day/month badge for Upcoming/This Weekend cards (Step
 * 26) — real startsAt only, no invented ticket-style date design. Uses the
 * device locale via `toLocaleDateString(undefined, ...)`, the same
 * convention already used by src/utils/timeFormat.ts, so this doesn't
 * start a separate localization approach.
 */
export function DateBadge({ date }: DateBadgeProps) {
  const weekday = date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
  const month = date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase();

  return (
    <View style={styles.badge}>
      <Text style={styles.weekday}>{weekday}</Text>
      <Text style={styles.day}>{date.getDate()}</Text>
      <Text style={styles.month}>{month}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignItems: 'center',
    backgroundColor: 'rgba(10, 10, 13, 0.85)',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.xs,
    paddingVertical: 4,
    minWidth: 44,
  },
  weekday: {
    color: Colors.textSecondary,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  day: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '800',
    lineHeight: 20,
  },
  month: {
    color: Colors.accent,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
});
