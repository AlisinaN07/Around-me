import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CategoryChip } from '@/components/CategoryChip';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { CATEGORY_FILTERS } from '@/fixtures/homeFeed';
import { useProfile } from '@/hooks/useProfile';
import { formatCityDisplayName } from '@/utils/cityDisplay';

export default function MapScreen() {
  const { profile } = useProfile();
  const [selectedCategory, setSelectedCategory] = useState('all');

  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : 'you';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Around {cityLabel}</Text>
          <Text style={styles.subtitle}>Explore what&apos;s happening across the city.</Text>
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipsScroll}
          contentContainerStyle={styles.chipsRow}
        >
          {CATEGORY_FILTERS.map((category) => (
            <CategoryChip
              key={category.id}
              label={category.label}
              icon={category.icon}
              selected={selectedCategory === category.id}
              onPress={() => setSelectedCategory(category.id)}
            />
          ))}
        </ScrollView>

        <View style={styles.mapPlaceholder}>
          <Ionicons name="map-outline" size={48} color={Colors.textSecondary} />
          <Text style={styles.mapPlaceholderTitle}>Map coming soon</Text>
          <Text style={styles.mapPlaceholderText}>
            A live map of what&apos;s happening around {cityLabel} will show up here.
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    alignSelf: 'center',
  },
  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    gap: 2,
  },
  title: {
    color: Colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  chipsScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  chipsRow: {
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  mapPlaceholder: {
    flex: 1,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.lg,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.xl,
  },
  mapPlaceholderTitle: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700',
    marginTop: Spacing.sm,
  },
  mapPlaceholderText: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
});
