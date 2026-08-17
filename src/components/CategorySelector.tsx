import { Pressable, StyleSheet, Text, View } from 'react-native';

import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';

type CategorySelectorProps = {
  label?: string;
  value: string | null;
  onChange: (categoryId: string) => void;
  error?: string;
};

/** Single-select category grid. UI shows emoji + label; Firestore stores only the stable id. */
export function CategorySelector({ label = 'Category', value, onChange, error }: CategorySelectorProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.grid}>
        {INTERESTS.map((interest) => {
          const isSelected = value === interest.id;
          return (
            <Pressable
              key={interest.id}
              onPress={() => onChange(interest.id)}
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
  label: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
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
