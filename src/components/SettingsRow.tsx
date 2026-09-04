import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';

type SettingsRowProps = {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  /** Optional trailing value/subtitle before the chevron (e.g. a current setting). */
  value?: string;
  onPress: () => void;
  destructive?: boolean;
  /** Hide when the row's own visual (e.g. a loading spinner) makes a chevron redundant. */
  showChevron?: boolean;
  loading?: boolean;
};

/** icon + label + optional value + chevron row for a SettingsSection (Step 27). */
export function SettingsRow({ icon, label, value, onPress, destructive = false, showChevron = true, loading = false }: SettingsRowProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={loading}
      style={styles.row}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <View style={styles.left}>
        <Ionicons name={icon} size={18} color={destructive ? Colors.error : Colors.text} />
        <Text style={[styles.label, destructive && styles.labelDestructive]} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <View style={styles.right}>
        {loading ? (
          <ActivityIndicator size="small" color={Colors.textSecondary} />
        ) : (
          <>
            {value ? (
              <Text style={styles.value} numberOfLines={1}>
                {value}
              </Text>
            ) : null}
            {showChevron ? <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} /> : null}
          </>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    flexShrink: 1,
  },
  label: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
    flexShrink: 1,
  },
  labelDestructive: {
    color: Colors.error,
  },
  right: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  value: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
});
