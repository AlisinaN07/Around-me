import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { Colors, Radius, Spacing, Typography } from '@/constants/theme';

type ErrorStateProps = {
  title: string;
  onRetry: () => void;
  retryLabel?: string;
  bare?: boolean;
};

/** Shared error+retry panel (Step 24) — consolidates the icon/title/"Try again" pattern repeated across screens. */
export function ErrorState({ title, onRetry, retryLabel = 'Try again', bare = false }: ErrorStateProps) {
  return (
    <View style={[styles.panel, bare && styles.panelBare]}>
      <Ionicons name="cloud-offline-outline" size={28} color={Colors.textSecondary} />
      <Text style={styles.title}>{title}</Text>
      <Button label={retryLabel} onPress={onRetry} />
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
});
