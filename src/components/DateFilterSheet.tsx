import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Radius, Spacing, Typography } from '@/constants/theme';
import { getCityDayWindow, type DateWindow } from '@/utils/dateWindows';

/**
 * Always a range — a single day is simply `start === end` (the first tap
 * already commits that; see handleDayPress's own doc comment). Per
 * explicit feedback the earlier Day/Week/Range mode picker was removed —
 * this one picker now covers a single day, a custom range, or (by
 * dragging the range across a whole week) a week, without asking the
 * viewer to pick a mode first.
 */
export type DateFilterSelection = { start: Date; end: Date };

const SHORT_DATE_FORMAT: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

// Monday-first month grid labels.
const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfDay(date: Date): Date {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

/** The concrete [start, end) window a selection resolves to — what callers actually filter events by. */
export function dateFilterWindow(selection: DateFilterSelection): DateWindow {
  return { start: getCityDayWindow(selection.start).start, end: getCityDayWindow(selection.end).end };
}

/** Short trigger-pill/chip label — "Sep 25" for a single day, "Sep 22 – 26" for a range. */
export function dateFilterLabel(selection: DateFilterSelection): string {
  if (isSameDay(selection.start, selection.end)) {
    return selection.start.toLocaleDateString(undefined, SHORT_DATE_FORMAT);
  }
  return `${selection.start.toLocaleDateString(undefined, SHORT_DATE_FORMAT)} – ${selection.end.toLocaleDateString(undefined, SHORT_DATE_FORMAT)}`;
}

/** Monday-first month grid, padded with null cells so every row is exactly 7 long. */
function buildMonthGrid(year: number, month: number): (Date | null)[][] {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // 0=Mon..6=Sun
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) cells.push(new Date(year, month, day));
  while (cells.length % 7 !== 0) cells.push(null);
  const rows: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}

type DateFilterSheetProps = {
  visible: boolean;
  value: DateFilterSelection | null;
  onChange: (selection: DateFilterSelection | null) => void;
  onClose: () => void;
};

/**
 * A real calendar date filter (per explicit request), not just a pill
 * list. Deliberately a from-scratch month grid rather than a calendar
 * library — none is already a dependency here (see package.json), and
 * every other menu/sheet in this app (OptionsMenu, EventFilterSheet,
 * SoundSheet) is similarly hand-built to this app's own visual system
 * rather than a generic library's.
 *
 * Backdrop is a SIBLING of the sheet (not a wrapping Pressable around it)
 * — same structure as OptionsMenu — deliberately avoiding the nested
 * <button>-in-<button> issue EventFilterSheet's own wrapping-Pressable
 * backdrop used to have on web (now fixed there too).
 */
export function DateFilterSheet({ visible, value, onChange, onClose }: DateFilterSheetProps) {
  // The month currently on screen — starts on whatever's already
  // selected, or today with nothing selected yet.
  const [displayedMonth, setDisplayedMonth] = useState(() => {
    const base = value ? value.start : new Date();
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  // A tapped start date waiting for its end date. Cleared once a full
  // range commits.
  const [pendingRangeStart, setPendingRangeStart] = useState<Date | null>(null);

  const grid = useMemo(() => buildMonthGrid(displayedMonth.getFullYear(), displayedMonth.getMonth()), [displayedMonth]);
  const today = useMemo(() => startOfDay(new Date()), []);

  const changeMonth = (delta: number) => {
    setDisplayedMonth((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  };

  /**
   * The first tap on a date immediately commits it as a single-day
   * selection (`start === end`) — so picking one specific day needs no
   * second tap or separate mode. A second tap (while that first date is
   * still the pending start) extends it into a real range, in whichever
   * order the two dates were tapped. Tapping again after a range is
   * already committed starts a brand new selection from that tap rather
   * than extending the old one.
   */
  const handleDayPress = (date: Date) => {
    if (!pendingRangeStart) {
      setPendingRangeStart(date);
      onChange({ start: date, end: date });
      return;
    }
    const start = pendingRangeStart < date ? pendingRangeStart : date;
    const end = pendingRangeStart < date ? date : pendingRangeStart;
    onChange({ start, end });
    setPendingRangeStart(null);
  };

  const isSelected = (date: Date): boolean => {
    if (!value) return false;
    const { start, end } = dateFilterWindow(value);
    return date.getTime() >= start.getTime() && date.getTime() < end.getTime();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.container}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
          <View style={styles.sheet}>
            <Text style={styles.title}>Filter by date</Text>
            <Text style={styles.hint}>
              {pendingRangeStart ? 'Pick an end date, or leave it as one day.' : 'Pick a date, or two for a range.'}
            </Text>

            <View style={styles.monthHeader}>
              <Pressable onPress={() => changeMonth(-1)} accessibilityRole="button" accessibilityLabel="Previous month" hitSlop={8}>
                <Ionicons name="chevron-back" size={20} color={Colors.text} />
              </Pressable>
              <Text style={styles.monthLabel}>{displayedMonth.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</Text>
              <Pressable onPress={() => changeMonth(1)} accessibilityRole="button" accessibilityLabel="Next month" hitSlop={8}>
                <Ionicons name="chevron-forward" size={20} color={Colors.text} />
              </Pressable>
            </View>

            <View style={styles.weekdayRow}>
              {WEEKDAY_LABELS.map((label) => (
                <Text key={label} style={styles.weekdayLabel}>
                  {label}
                </Text>
              ))}
            </View>

            {grid.map((row, rowIndex) => (
              <View key={rowIndex} style={styles.weekRow}>
                {row.map((date, cellIndex) => {
                  if (!date) return <View key={cellIndex} style={styles.dayCell} />;
                  const selected = isSelected(date);
                  const isToday = isSameDay(date, today);
                  return (
                    <Pressable
                      key={cellIndex}
                      onPress={() => handleDayPress(date)}
                      style={[styles.dayCell, selected && styles.dayCellSelected]}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                    >
                      <Text style={[styles.dayText, isToday && styles.dayTextToday, selected && styles.dayTextSelected]}>
                        {date.getDate()}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ))}

            <View style={styles.footerRow}>
              <Pressable
                onPress={() => {
                  onChange(null);
                  setPendingRangeStart(null);
                }}
                style={styles.clearButton}
                accessibilityRole="button"
              >
                <Text style={styles.clearButtonText}>Clear</Text>
              </Pressable>
              <Pressable onPress={onClose} style={styles.doneButton} accessibilityRole="button">
                <Text style={styles.doneButtonText}>Done</Text>
              </Pressable>
            </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  sheetWrap: {
    pointerEvents: 'box-none',
  },
  sheet: {
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.lg,
    gap: Spacing.sm,
  },
  title: {
    color: Colors.text,
    ...Typography.sectionTitle,
  },
  hint: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  monthHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: Spacing.xs,
  },
  monthLabel: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  weekdayRow: {
    flexDirection: 'row',
  },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  weekRow: {
    flexDirection: 'row',
  },
  dayCell: {
    flex: 1,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayCellSelected: {
    backgroundColor: Colors.accentMuted,
    borderRadius: Radius.full,
  },
  dayText: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  dayTextToday: {
    color: Colors.accent,
  },
  dayTextSelected: {
    color: Colors.accent,
    fontWeight: '800',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Spacing.sm,
  },
  clearButton: {
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  clearButtonText: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  doneButton: {
    borderRadius: Radius.full,
    backgroundColor: Colors.accent,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.sm,
  },
  doneButtonText: {
    color: Colors.background,
    fontSize: 14,
    fontWeight: '700',
  },
});
