import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MapPlaceExplorer } from '@/components/MapPlaceExplorer';
import { Colors, Layout, Spacing } from '@/constants/theme';
import { useProfile } from '@/hooks/useProfile';
import { formatCityDisplayName } from '@/utils/cityDisplay';

/**
 * The map/data foundation for Places (Step 13) — a real Firestore-backed
 * city Places discovery screen. No native map rendering yet; MapPlaceExplorer
 * is deliberately the boundary a future native map (Step 14) can occupy
 * without changing how Places are fetched or filtered.
 */
export default function MapScreen() {
  const { profile } = useProfile();
  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : 'you';

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.header}>
            <Text style={styles.title}>Places in {cityLabel}</Text>
            <Text style={styles.subtitle}>Real places around the city — cafés, venues, parks, and more.</Text>
          </View>

          {profile ? (
            <MapPlaceExplorer cityKey={profile.cityKey} cityLabel={cityLabel} />
          ) : null}
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
  content: {
    flex: 1,
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    alignSelf: 'center',
    paddingBottom: Spacing.xxl,
  },
  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.md,
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
});
