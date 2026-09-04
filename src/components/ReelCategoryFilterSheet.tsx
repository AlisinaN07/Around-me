import { Ionicons } from '@expo/vector-icons';
import { Modal, Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing, Typography } from '@/constants/theme';

type ReelCategoryFilterSheetProps = {
  visible: boolean;
  /** null means "All". */
  selectedCategoryId: string | null;
  onSelect: (categoryId: string | null) => void;
  onClose: () => void;
};

/**
 * Simple category filter sheet for the Reel feed (Step 25) — one active
 * category or "All", using the existing stable interest ids (see
 * src/constants/interests.ts). Client/query-level discovery only, not a
 * personalization or preferences system.
 */
export function ReelCategoryFilterSheet({ visible, selectedCategoryId, onSelect, onClose }: ReelCategoryFilterSheetProps) {
  const handleSelect = (categoryId: string | null) => {
    onSelect(categoryId);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
        <Pressable style={styles.sheet} onPress={(event) => event.stopPropagation()}>
          <Text style={styles.title}>Filter by category</Text>
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            <Row label="All" emoji="✨" selected={selectedCategoryId === null} onPress={() => handleSelect(null)} />
            {INTERESTS.map((interest) => (
              <Row
                key={interest.id}
                label={interest.label}
                emoji={interest.emoji}
                selected={selectedCategoryId === interest.id}
                onPress={() => handleSelect(interest.id)}
              />
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, emoji, selected, onPress }: { label: string; emoji: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.row}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={styles.rowEmoji}>{emoji}</Text>
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
    maxHeight: '70%',
    backgroundColor: Colors.surfaceElevated,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingTop: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.xl,
  },
  title: {
    color: Colors.text,
    ...Typography.sectionTitle,
    marginBottom: Spacing.sm,
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
  },
  rowLabel: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
});
