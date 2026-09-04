import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';
import { formatDatePill, formatTimePill } from '@/utils/timeFormat';

type DateTimeFieldProps = {
  label: string;
  value: Date;
  onChange: (date: Date) => void;
  minimumDate?: Date;
  error?: string;
};

function mergeDatePart(base: Date, datePart: Date): Date {
  const next = new Date(base);
  next.setFullYear(datePart.getFullYear(), datePart.getMonth(), datePart.getDate());
  return next;
}

function mergeTimePart(base: Date, timePart: Date): Date {
  const next = new Date(base);
  next.setHours(timePart.getHours(), timePart.getMinutes(), 0, 0);
  return next;
}

/**
 * Native (iOS/Android) date + time picker. Android opens the system dialog
 * imperatively (its recommended API); iOS expands an inline spinner below
 * the pill, closed with a "Done" button — no modal library needed for
 * either. See DateTimeField.web.tsx for the browser-preview equivalent.
 */
export function DateTimeField({ label, value, onChange, minimumDate, error }: DateTimeFieldProps) {
  const [openPicker, setOpenPicker] = useState<'date' | 'time' | null>(null);

  const openDatePicker = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value,
        mode: 'date',
        minimumDate,
        onChange: (event, selected) => {
          if (event.type === 'set' && selected) {
            onChange(mergeDatePart(value, selected));
          }
        },
      });
      return;
    }
    setOpenPicker((current) => (current === 'date' ? null : 'date'));
  };

  const openTimePicker = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value,
        mode: 'time',
        is24Hour: true,
        onChange: (event, selected) => {
          if (event.type === 'set' && selected) {
            onChange(mergeTimePart(value, selected));
          }
        },
      });
      return;
    }
    setOpenPicker((current) => (current === 'time' ? null : 'time'));
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.pillRow}>
        <Pressable
          style={[styles.pill, error && styles.pillError]}
          onPress={openDatePicker}
          accessibilityRole="button"
          accessibilityLabel={`${label} date, ${formatDatePill(value)}`}
        >
          <Ionicons name="calendar-outline" size={15} color={Colors.textSecondary} />
          <Text style={styles.pillText}>{formatDatePill(value)}</Text>
        </Pressable>
        <Pressable
          style={[styles.pill, error && styles.pillError]}
          onPress={openTimePicker}
          accessibilityRole="button"
          accessibilityLabel={`${label} time, ${formatTimePill(value)}`}
        >
          <Ionicons name="time-outline" size={15} color={Colors.textSecondary} />
          <Text style={styles.pillText}>{formatTimePill(value)}</Text>
        </Pressable>
      </View>

      {Platform.OS === 'ios' && openPicker && (
        <View style={styles.inlinePicker}>
          <DateTimePicker
            value={value}
            mode={openPicker}
            display="spinner"
            minimumDate={openPicker === 'date' ? minimumDate : undefined}
            onChange={(_event, selected) => {
              if (!selected) return;
              onChange(openPicker === 'date' ? mergeDatePart(value, selected) : mergeTimePart(value, selected));
            }}
            themeVariant="dark"
          />
          <Pressable style={styles.doneButton} onPress={() => setOpenPicker(null)} accessibilityRole="button">
            <Text style={styles.doneLabel}>Done</Text>
          </Pressable>
        </View>
      )}

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
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  pillError: {
    borderColor: Colors.error,
  },
  pillText: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  inlinePicker: {
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    paddingBottom: Spacing.sm,
  },
  doneButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
  },
  doneLabel: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: '700',
  },
  errorText: {
    color: Colors.error,
    fontSize: 12,
  },
});
