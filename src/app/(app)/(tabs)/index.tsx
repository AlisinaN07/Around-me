import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CategoryChip } from '@/components/CategoryChip';
import { FeedCard } from '@/components/FeedCard';
import { HappeningNowCard } from '@/components/HappeningNowCard';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { SectionHeader } from '@/components/SectionHeader';
import { Colors, Layout, Spacing } from '@/constants/theme';
import { AROUND_YOU_FIXTURES, CATEGORY_FILTERS, HAPPENING_NOW_FIXTURES, REEL_PREVIEW_FIXTURES } from '@/fixtures/homeFeed';
import { useProfile } from '@/hooks/useProfile';
import { formatCityDisplayName } from '@/utils/cityDisplay';

export default function HomeScreen() {
  const { profile } = useProfile();
  const [selectedCategory, setSelectedCategory] = useState('all');

  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : 'you';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.page}>
          <View style={styles.header}>
            <View style={styles.headerTextGroup}>
              <View style={styles.cityRow}>
                <Ionicons name="location" size={14} color={Colors.accent} />
                <Text style={styles.cityLabel}>Current city</Text>
              </View>
              <Text style={styles.title}>Around {cityLabel}</Text>
            </View>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => {}}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Search"
                style={styles.headerButton}
              >
                <Ionicons name="search-outline" size={22} color={Colors.text} />
              </Pressable>
              <Pressable
                onPress={() => {}}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Notifications"
                style={styles.headerButton}
              >
                <Ionicons name="notifications-outline" size={22} color={Colors.text} />
              </Pressable>
            </View>
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.horizontalScroll}
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

          <View style={styles.section}>
            <SectionHeader title="Happening Now 🔥" actionLabel="See all" onActionPress={() => {}} />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.horizontalScroll}
              contentContainerStyle={styles.horizontalListContent}
            >
              {HAPPENING_NOW_FIXTURES.map((item) => (
                <HappeningNowCard key={item.id} item={item} />
              ))}
            </ScrollView>
          </View>

          <View style={styles.section}>
            <SectionHeader title="Local Reels" actionLabel="See all" onActionPress={() => {}} />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.horizontalScroll}
              contentContainerStyle={styles.horizontalListContent}
            >
              {REEL_PREVIEW_FIXTURES.map((item) => (
                <ReelPreviewCard key={item.id} item={item} />
              ))}
            </ScrollView>
          </View>

          <View style={styles.section}>
            <SectionHeader title="Around You" />
            {AROUND_YOU_FIXTURES.map((item) => (
              <FeedCard key={item.id} item={item} />
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
  },
  headerTextGroup: {
    flexShrink: 1,
    gap: 2,
  },
  cityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  cityLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  title: {
    color: Colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  headerActions: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  horizontalScroll: {
    flexGrow: 0,
    flexShrink: 0,
  },
  chipsRow: {
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  section: {
    marginTop: Spacing.lg,
  },
  horizontalListContent: {
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
  },
});
