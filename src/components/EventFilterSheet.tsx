import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { KARLSTAD_LAUNCH_CATEGORIES } from '@/constants/launchCategories';
import { Colors, Radius, Spacing, Typography } from '@/constants/theme';

type EventFilterSheetProps = {
  visible: boolean;
  /** null means "All categories". */
  categoryFilter: string | null;
  onChangeCategoryFilter: (categoryId: string | null) => void;
  onClose: () => void;
};

/**
 * Events-tab filter sheet (Step 26). Category-only since Step 41.2B — the
 * former All/Events/Activities type filter existed solely to separate
 * Events from the now-retired legacy Activity content type; with Events
 * discovery Event-only, that distinction no longer means anything, so it
 * was removed rather than kept as a filter with a single meaningful value.
 *
 * Backdrop is a SIBLING of the sheet (not a wrapping Pressable around it)
 * — same structure as OptionsMenu — rather than a Pressable-wraps-Pressable
 * backdrop, which used to render a `<button>` nested inside a `<button>`
 * on web (a real hydration-error warning, confirmed live via the Browser
 * pane console) since the sheet itself, and every CategoryRow inside it,
 * are Pressables too. The sheet's old `onPress={stopPropagation}` trick
 * is gone along with it — with the backdrop no longer an ancestor, taps on
 * the sheet never reach it in the first place.
 */
export function EventFilterSheet({ visible, categoryFilter, onChangeCategoryFilter, onClose }: EventFilterSheetProps) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" />
        <View style={styles.sheet}>
          <Text style={styles.title}>Filter</Text>

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
        </View>
      </View>
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
