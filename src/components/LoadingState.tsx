import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';

type LoadingStateProps = {
  size?: 'small' | 'large';
};

/** Shared centered loading indicator — replaces ad hoc "Loading…" text across several screens. */
export function LoadingState({ size = 'small' }: LoadingStateProps) {
  return (
    <View style={styles.container}>
      <ActivityIndicator color={Colors.textSecondary} size={size} />
    </View>
  );
}

type SkeletonBlockProps = {
  width: number | `${number}%`;
  height: number;
};

/** A single skeleton placeholder block, for screens that show shape-of-content while loading. */
export function SkeletonBlock({ width, height }: SkeletonBlockProps) {
  return <View style={[styles.skeleton, { width, height }]} />;
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: Spacing.xxl,
  },
  skeleton: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    opacity: 0.5,
  },
});
