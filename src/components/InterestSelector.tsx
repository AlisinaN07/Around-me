import { Pressable, StyleSheet, Text, View } from 'react-native';

import { INTERESTS, MAX_INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';

type InterestSelectorProps = {
  value: string[];
  onChange: (interestIds: string[]) => void;
  error?: string;
};

/**
 * Multi-select interest chip grid — extracted from the onboarding
 * interests screen (Step 33) so Edit Profile can reuse the exact same
 * taxonomy/limits instead of a second implementation. Enforces
 * MIN_INTERESTS–MAX_INTERESTS by simply refusing to add a new selection
 * once MAX_INTERESTS is reached; callers are responsible for surfacing the
 * "choose at least MIN_INTERESTS" rule (the constraint differs by context —
 * onboarding blocks Continue, Edit Profile shows a field error).
 */
export function InterestSelector({ value, onChange, error }: InterestSelectorProps) {
  const toggle = (id: string) => {
    if (value.includes(id)) {
      onChange(value.filter((item) => item !== id));
      return;
    }
    if (value.length >= MAX_INTERESTS) {
      return;
    }
    onChange([...value, id]);
  };

  return (
    <View style={styles.container}>
      <View style={styles.grid}>
        {INTERESTS.map((interest) => {
          const isSelected = value.includes(interest.id);
          return (
            <Pressable
              key={interest.id}
              onPress={() => toggle(interest.id)}
              style={[styles.chip, isSelected && styles.chipSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
            >
              <Text style={styles.chipEmoji}>{interest.emoji}</Text>
              <Text style={[styles.chipLabel, isSelected && styles.chipLabelSelected]}>{interest.label}</Text>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.xs,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  chipSelected: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accent,
  },
  chipEmoji: {
    fontSize: 16,
  },
  chipLabel: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  chipLabelSelected: {
    color: Colors.background,
  },
  errorText: {
    color: Colors.error,
    fontSize: 12,
  },
});
