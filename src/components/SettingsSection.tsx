import { Children, Fragment, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing, Typography } from '@/constants/theme';

type SettingsSectionProps = {
  title?: string;
  children: ReactNode;
};

/**
 * Rounded dark section card for Settings (Step 27) — a title label above a
 * bordered panel of SettingsRow children, with a thin separator inserted
 * between rows automatically (so callers never have to remember one).
 */
export function SettingsSection({ title, children }: SettingsSectionProps) {
  const rows = Children.toArray(children);
  return (
    <View style={styles.section}>
      {title ? <Text style={styles.title}>{title}</Text> : null}
      <View style={styles.card}>
        {rows.map((row, index) => (
          <Fragment key={index}>
            {index > 0 ? <View style={styles.divider} /> : null}
            {row}
          </Fragment>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: Spacing.sm,
  },
  title: {
    color: Colors.textSecondary,
    ...Typography.label,
    marginHorizontal: Spacing.xs,
  },
  card: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  divider: {
    height: 1,
    backgroundColor: Colors.border,
    marginLeft: Spacing.xl + Spacing.sm,
  },
});
