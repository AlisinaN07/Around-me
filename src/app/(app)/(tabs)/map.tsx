import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { MapPlaceExplorer } from '@/components/MapPlaceExplorer';
import { NativeMapScreen } from '@/components/NativeMapScreen';
import { Colors, Layout, Spacing } from '@/constants/theme';
import { useProfile } from '@/hooks/useProfile';
import { formatCityDisplayName } from '@/utils/cityDisplay';

/**
 * The Map tab. iOS (Step 14) gets a real native Apple Map (NativeMapScreen)
 * using the real Place coordinates built in Step 13; web and Android keep
 * the Step 13 Place explorer/list (MapPlaceExplorer) — Android map support
 * is a deliberate later step (Google Maps credentials), and `expo-maps`
 * must never be imported outside NativeCityMap.ios.tsx or it would break
 * bundling on those platforms. Both surfaces share the exact same
 * fetch/filter logic (see useCityPlaces) — only the presentation differs.
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
            Platform.OS === 'ios' ? (
              <NativeMapScreen cityKey={profile.cityKey} cityLabel={cityLabel} />
            ) : (
              <MapPlaceExplorer cityKey={profile.cityKey} cityLabel={cityLabel} />
            )
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
