import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ContentCard } from '@/components/ContentCard';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { SectionHeader } from '@/components/SectionHeader';
import { getPlaceCategory } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchPlaceContent } from '@/services/content';
import { fetchPlace } from '@/services/places';
import type { Content } from '@/types/content';
import type { Place } from '@/types/place';
import { formatCityDisplayName } from '@/utils/cityDisplay';

type LoadStatus = 'loading' | 'loaded' | 'error';

export default function PlaceDetailScreen() {
  const { placeId } = useLocalSearchParams<{ placeId: string }>();
  const { user } = useAuth();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [place, setPlace] = useState<Place | null>(null);
  const [content, setContent] = useState<Content[]>([]);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    try {
      const [placeResult, contentResult] = await Promise.all([fetchPlace(placeId), fetchPlaceContent(placeId)]);
      if (!placeResult) {
        setStatus('error');
        return;
      }
      setPlace(placeResult);
      setContent(contentResult);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [placeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const category = place ? getPlaceCategory(place.categoryId) : undefined;

  return (
    <HeaderScreenLayout title={place?.name ?? 'Place'}>
      {status === 'loading' ? (
        <View style={styles.centered}>
          <Text style={styles.mutedText}>Loading…</Text>
        </View>
      ) : status === 'error' || !place ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.errorTitle}>Couldn&apos;t load this place.</Text>
          <Button label="Try again" onPress={load} />
        </View>
      ) : (
        <View style={styles.container}>
          <View style={styles.header}>
            <View style={styles.iconCircle}>
              <Ionicons name={category?.icon ?? 'location-outline'} size={28} color={Colors.accent} />
            </View>
            <Text style={styles.name}>{place.name}</Text>
            {category ? <Text style={styles.category}>{category.label}</Text> : null}
            <View style={styles.locationRow}>
              <Ionicons name="location" size={14} color={Colors.accent} />
              <Text style={styles.locationText}>
                {place.address}, {formatCityDisplayName(place.cityName)}
              </Text>
            </View>
          </View>

          <View>
            <SectionHeader title="What's happening here" />
            {content.length === 0 ? (
              <View style={styles.emptyPanel}>
                <Text style={styles.emptyTitle}>Nothing happening here yet.</Text>
                <Text style={styles.emptyBody}>Be the first to share something happening at {place.name}.</Text>
                {user ? <Button label="Create" onPress={() => router.push('/create')} /> : null}
              </View>
            ) : (
              <View style={styles.contentList}>
                {content.map((item) => (
                  <ContentCard key={item.contentId} item={item} currentUid={user?.uid ?? null} />
                ))}
              </View>
            )}
          </View>
        </View>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.xxl,
  },
  mutedText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  errorTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  container: {
    gap: Spacing.lg,
  },
  header: {
    alignItems: 'center',
    gap: 4,
  },
  iconCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: Spacing.sm,
  },
  name: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  category: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xs,
  },
  locationText: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
  emptyPanel: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  emptyTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyBody: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
  contentList: {
    // Cancels out HeaderScreenLayout's own paddingHorizontal so ContentCard's
    // built-in marginHorizontal is the only inset — matching how cards look
    // everywhere else they're used (Home, Following, public profile).
    marginHorizontal: -Spacing.xl,
  },
});
