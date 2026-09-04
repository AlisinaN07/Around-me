import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';

type FormFieldProps = TextInputProps & {
  label: string;
  error?: string;
  /** Renders a Show/Hide toggle and treats the field as a password field. */
  secureToggle?: boolean;
  /** Static text rendered before the input, e.g. "@" for a username field. */
  prefix?: string;
};

export function FormField({ label, error, secureToggle, prefix, style, ...rest }: FormFieldProps) {
  const [isRevealed, setIsRevealed] = useState(false);
  const isDisabled = rest.editable === false;

  return (
    <View style={[styles.container, isDisabled && styles.containerDisabled]}>
      <Text style={styles.label}>{label}</Text>
      <View style={[styles.inputRow, error && styles.inputRowError]}>
        {prefix ? <Text style={styles.prefix}>{prefix}</Text> : null}
        <TextInput
          style={[styles.input, style]}
          placeholderTextColor={Colors.textSecondary}
          secureTextEntry={secureToggle ? !isRevealed : rest.secureTextEntry}
          {...rest}
        />
        {secureToggle && (
          <Pressable
            onPress={() => setIsRevealed((revealed) => !revealed)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={isRevealed ? 'Hide password' : 'Show password'}
          >
            <Text style={styles.toggleLabel}>{isRevealed ? 'Hide' : 'Show'}</Text>
          </Pressable>
        )}
      </View>
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.xs,
  },
  containerDisabled: {
    opacity: 0.5,
  },
  label: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  inputRowError: {
    borderColor: Colors.error,
  },
  input: {
    flex: 1,
    color: Colors.text,
    fontSize: 16,
    paddingVertical: Spacing.md,
  },
  toggleLabel: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
    marginLeft: Spacing.sm,
  },
  prefix: {
    color: Colors.textSecondary,
    fontSize: 16,
    marginRight: Spacing.xs,
  },
  errorText: {
    color: Colors.error,
    fontSize: 12,
  },
});
