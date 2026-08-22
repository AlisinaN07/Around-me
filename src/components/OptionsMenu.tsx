import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Radius, Spacing } from '@/constants/theme';

export type OptionsMenuOption = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
};

type OptionsMenuProps = {
  visible: boolean;
  onClose: () => void;
  options: OptionsMenuOption[];
};

/** A small bottom-sheet action list — used for Block/Report style overflow menus. */
export function OptionsMenu({ visible, onClose, options }: OptionsMenuProps) {
  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <View style={styles.container}>
        {/* Sibling to the sheet, not a wrapping parent — a Pressable
            wrapping the row Pressables would render as a <button>
            containing nested <button> elements on web. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
        />
        <SafeAreaView style={styles.sheetWrap} edges={['bottom']}>
          <View style={styles.sheet}>
            {options.map((option, index) => (
              <Pressable
                key={option.label}
                onPress={() => {
                  onClose();
                  option.onPress();
                }}
                style={[styles.row, index > 0 && styles.rowBorder]}
                accessibilityRole="button"
              >
                <Text style={[styles.rowText, option.destructive && styles.rowTextDestructive]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <Pressable onPress={onClose} style={styles.cancelRow} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
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
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
    gap: Spacing.sm,
    pointerEvents: 'box-none',
  },
  sheet: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    overflow: 'hidden',
  },
  row: {
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  rowText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '600',
  },
  rowTextDestructive: {
    color: Colors.error,
  },
  cancelRow: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    paddingVertical: Spacing.md,
    alignItems: 'center',
  },
  cancelText: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
});
