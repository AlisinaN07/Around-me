import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';
import { INTERESTS } from '@/constants/interests';

type InterestPillsProps = {
  /** Real `profile.interests` ids — never invented. Renders nothing if empty. */
  interestIds: string[];
};

/** Real interest pills for a profile header (Step 27) — reused by own and public profile. */
export function InterestPills({ interestIds }: InterestPillsProps) {
  const items = interestIds.map((id) => INTERESTS.find((interest) => interest.id === id)).filter((interest) => !!interest);
  if (items.length === 0) return null;

  return (
    <View style={styles.wrap}>
      {items.map((interest) => (
        <View key={interest.id} style={styles.pill}>
          <Text style={styles.emoji}>{interest.emoji}</Text>
          <Text style={styles.label}>{interest.label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.lg,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
  },
  emoji: {
    fontSize: 13,
  },
  label: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '600',
  },
});
