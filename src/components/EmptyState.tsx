import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing, Typography } from '@/constants/theme';

type EmptyStateProps = {
  icon?: keyof typeof Ionicons.glyphMap;
  title: string;
  body?: string;
  action?: ReactNode;
  /** Removes the card background/border for contexts that already provide their own panel chrome. */
  bare?: boolean;
};

/**
 * Shared empty-state panel (Step 24) — consolidates what had grown into
 * five independently-duplicated "emptyPanel" style blocks across Home,
 * Events, Place detail, Inbox, and Reels (see the Step 23 audit, §16).
 * Existing screens are migrated to this incrementally, not all at once.
 */
export function EmptyState({ icon, title, body, action, bare = false }: EmptyStateProps) {
  return (
    <View style={[styles.panel, bare && styles.panelBare]}>
      {icon ? <Ionicons name={icon} size={28} color={Colors.textSecondary} /> : null}
      <Text style={styles.title}>{title}</Text>
      {body ? <Text style={styles.body}>{body}</Text> : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  panelBare: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    padding: Spacing.lg,
  },
  title: {
    color: Colors.text,
    textAlign: 'center',
    ...Typography.cardTitle,
  },
  body: {
    color: Colors.textSecondary,
    textAlign: 'center',
    ...Typography.bodySecondary,
  },
});
