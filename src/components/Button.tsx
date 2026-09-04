import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';

import { Colors, ControlHeight, Gradients, Radius, Spacing, Typography } from '@/constants/theme';

type ButtonVariant = 'primary' | 'secondary';

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  loading?: boolean;
  disabled?: boolean;
};

/**
 * Primary button uses the app's one accent gradient (Step 24 visual
 * direction) — matches the pill-shaped "Going"/CTA buttons in the approved
 * reference screenshots. Secondary stays a flat outlined pill.
 */
export function Button({ label, onPress, variant = 'primary', loading = false, disabled = false }: ButtonProps) {
  const isDisabled = disabled || loading;

  const content = loading ? (
    <ActivityIndicator color={variant === 'primary' ? Colors.text : Colors.text} />
  ) : (
    <Text style={variant === 'primary' ? styles.primaryLabel : styles.secondaryLabel}>{label}</Text>
  );

  if (variant === 'secondary') {
    return (
      <Pressable
        onPress={onPress}
        disabled={isDisabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        style={({ pressed }) => [styles.base, styles.secondary, pressed && !isDisabled && styles.pressed, isDisabled && styles.disabled]}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={onPress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      style={({ pressed }) => [pressed && !isDisabled && styles.pressed, isDisabled && styles.disabled]}
    >
      <LinearGradient colors={Gradients.accent} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={[styles.base, styles.primary]}>
        {content}
      </LinearGradient>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: ControlHeight.lg,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  primary: {
    shadowColor: Colors.accent,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  secondary: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: Colors.border,
  },
  pressed: {
    opacity: 0.85,
  },
  disabled: {
    opacity: 0.5,
  },
  primaryLabel: {
    color: Colors.text,
    ...Typography.button,
  },
  secondaryLabel: {
    color: Colors.text,
    ...Typography.button,
  },
});
