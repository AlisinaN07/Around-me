import { useMemo, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COUNTRIES, type Country } from '@/constants/countries';
import { Colors, Radius, Spacing } from '@/constants/theme';

type CountryPickerProps = {
  countryCode: string;
  onSelect: (country: Country) => void;
};

export function CountryPicker({ countryCode, onSelect }: CountryPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');

  const selected = COUNTRIES.find((country) => country.code === countryCode);

  const filtered = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return COUNTRIES;
    return COUNTRIES.filter((country) => country.name.toLowerCase().includes(trimmed));
  }, [query]);

  return (
    <>
      <Pressable
        style={styles.trigger}
        onPress={() => setIsOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Select country"
      >
        <Text style={selected ? styles.triggerValue : styles.triggerPlaceholder}>
          {selected ? selected.name : 'Select country'}
        </Text>
      </Pressable>

      <Modal visible={isOpen} animationType="slide" onRequestClose={() => setIsOpen(false)}>
        <SafeAreaView style={styles.modalSafeArea}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Select country</Text>
            <Pressable onPress={() => setIsOpen(false)} hitSlop={12} accessibilityRole="button">
              <Text style={styles.modalClose}>Close</Text>
            </Pressable>
          </View>

          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder="Search countries"
            placeholderTextColor={Colors.textSecondary}
            autoCorrect={false}
            autoCapitalize="none"
          />

          <FlatList
            data={filtered}
            keyExtractor={(item) => item.code}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => (
              <Pressable
                style={styles.row}
                onPress={() => {
                  onSelect(item);
                  setQuery('');
                  setIsOpen(false);
                }}
              >
                <Text style={styles.rowText}>{item.name}</Text>
              </Pressable>
            )}
          />
        </SafeAreaView>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  triggerValue: {
    color: Colors.text,
    fontSize: 16,
  },
  triggerPlaceholder: {
    color: Colors.textSecondary,
    fontSize: 16,
  },
  modalSafeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
  },
  modalTitle: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '700',
  },
  modalClose: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: '600',
  },
  search: {
    marginHorizontal: Spacing.xl,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    color: Colors.text,
    fontSize: 16,
  },
  row: {
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowText: {
    color: Colors.text,
    fontSize: 16,
  },
});
