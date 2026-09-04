import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { SegmentedControl } from '@/components/SegmentedControl';
import { KARLSTAD_LAUNCH_CATEGORIES } from '@/constants/launchCategories';
import { Colors, Radius, Spacing, Typography } from '@/constants/theme';

export type EventTypeFilter = 'all' | 'events' | 'activities';

const TYPE_FILTER_OPTIONS: { id: EventTypeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'events', label: 'Events' },
  { id: 'activities', label: 'Activities' },
];

type EventFilterSheetProps = {
  visible: boolean;
  typeFilter: EventTypeFilter;
  onChangeTypeFilter: (value: EventTypeFilter) => void;
  /** null means "All categories". */
  categoryFilter: string | null;
  onChangeCategoryFilter: (categoryId: string | null) => void;
  onClose: () => void;
};

/**
 * Events-tab filter sheet (Step 26) — the exact same real filters the
 * previous inline SegmentedControl + category chip row offered (All/
 * Events/Activities, and the real Karlstad launch category shortlist),
 * just moved behind a header filter icon so the screen itself stays
 * visual/scannable instead of spending vertical space on filter chrome up
 * front. No speculative filters (price/distance/popularity/etc. — none of
 * that data exists).
 */
export function EventFilterSheet({
  visible,
  typeFilter,
  onChangeTypeFilter,
  categoryFilter,
  onChangeCategoryFilter,
  onClose,
}: EventFilterSheetProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <Text style={styles.title}>Filter</Text>

          <SegmentedControl options={TYPE_FILTER_OPTIONS} value={typeFilter} onChange={onChangeTypeFilter} />

          <Text style={styles.subtitle}>Category</Text>
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            <CategoryRow label="All categories" emoji="✨" selected={categoryFilter === null} onPress={() => onChangeCategoryFilter(null)} />
            {KARLSTAD_LAUNCH_CATEGORIES.map((category) => (
              <CategoryRow
                key={category.interestId}
                label={category.label}
                selected={categoryFilter === category.interestId}
                onPress={() => onChangeCategoryFilter(category.interestId)}
              />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function CategoryRow({ label, emoji, selected, onPress }: { label: string; emoji?: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.row} accessibilityRole="button" accessibilityState={{ selected }}>
      {emoji ? <Text style={styles.rowEmoji}>{emoji}</Text> : <Ionicons name="pricetag-outline" size={16} color={Colors.textSecondary} style={styles.rowIcon} />}
      <Text style={styles.rowLabel}>{label}</Text>
      {selected ? <Ionicons name="checkmark" size={20} color={Colors.accent} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  sheet: {
    maxHeight: '75%',
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
    gap: Spacing.sm,
  },
  title: {
    color: Colors.text,
    ...Typography.sectionTitle,
  },
  subtitle: {
    color: Colors.textSecondary,
    ...Typography.caption,
    marginTop: Spacing.xs,
  },
  list: {
    flexGrow: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowEmoji: {
    fontSize: 18,
    width: 20,
    textAlign: 'center',
  },
  rowIcon: {
    width: 20,
    textAlign: 'center',
  },
  rowLabel: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
});
