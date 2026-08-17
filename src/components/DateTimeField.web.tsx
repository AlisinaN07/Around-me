import { createElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';

type DateTimeFieldProps = {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
  minimumDate?: Date;
  error?: string;
};

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function toDateInputValue(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInputValue(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function mergeDateString(base: Date, dateString: string): Date {
  const [year, month, day] = dateString.split('-').map(Number);
  if (!year || !month || !day) return base;
  const next = new Date(base);
  next.setFullYear(year, month - 1, day);
  return next;
}

function mergeTimeString(base: Date, timeString: string): Date {
  const [hours, minutes] = timeString.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return base;
  const next = new Date(base);
  next.setHours(hours, minutes, 0, 0);
  return next;
}

const inputStyle: Record<string, string | number> = {
  flex: 1,
  minWidth: 0,
  border: `1px solid ${Colors.border}`,
  borderRadius: Radius.md,
  backgroundColor: Colors.surface,
  color: Colors.text,
  fontSize: 15,
  fontWeight: 600,
  paddingTop: Spacing.md,
  paddingBottom: Spacing.md,
  paddingLeft: Spacing.md,
  paddingRight: Spacing.md,
  colorScheme: 'dark',
  outline: 'none',
  fontFamily: 'inherit',
};

/**
 * Web equivalent of DateTimeField.tsx — @react-native-community/datetimepicker
 * doesn't support the web platform, so this uses plain HTML date/time inputs
 * (browsers already provide a native picker UI for these) styled to match.
 */
export function DateTimeField({ label, value, onChange, minimumDate, error }: DateTimeFieldProps) {
  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.pillRow}>
        {createElement('input', {
          type: 'date',
          value: toDateInputValue(value),
          min: minimumDate ? toDateInputValue(minimumDate) : undefined,
          style: { ...inputStyle, borderColor: error ? Colors.error : Colors.border },
          onChange: (event: { target: { value: string } }) => {
            if (event.target.value) {
              onChange(mergeDateString(value, event.target.value));
            }
          },
        })}
        {createElement('input', {
          type: 'time',
          value: toTimeInputValue(value),
          style: { ...inputStyle, borderColor: error ? Colors.error : Colors.border },
          onChange: (event: { target: { value: string } }) => {
            if (event.target.value) {
              onChange(mergeTimeString(value, event.target.value));
            }
          },
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
  pillRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  errorText: {
    color: Colors.error,
    fontSize: 12,
  },
});
