import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';

type CategoryChipProps = {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  selected: boolean;
  onPress: () => void;
};

export function CategoryChip({ label, icon, selected, onPress }: CategoryChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Ionicons name={icon} size={14} color={selected ? Colors.background : Colors.textSecondary} />
      <Text style={[styles.label, selected && styles.labelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  label: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  labelSelected: {
    color: Colors.background,
  },
});
