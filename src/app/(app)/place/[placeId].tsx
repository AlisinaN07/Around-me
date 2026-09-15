import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { ContentCard } from '@/components/ContentCard';
import { EventCard } from '@/components/EventCard';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { SectionHeader } from '@/components/SectionHeader';
import { getPlaceCategory } from '@/constants/placeCategories';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchPlaceContent } from '@/services/content';
import { fetchPlace } from '@/services/places';
import type { ActivityContent, Content, EventContent } from '@/types/content';
import type { Place } from '@/types/place';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { isHappeningNow } from '@/utils/dateWindows';

type LoadStatus = 'loading' | 'loaded' | 'error';

function isTimedContent(item: Content): item is ActivityContent | EventContent {
  return item.type === 'activity' || item.type === 'event';
}

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

  // Splits the one bounded fetchPlaceContent result (already capped, see
  // content.ts) into Happening Now / Upcoming / everything else, client-side
  // — no extra queries. A Place typically has few linked items, so this is
  // cheap; the general list below the two rails still shows posts, same as
  // before this split.
  //
  // Step 41.2B: legacy Activity is filtered out entirely here rather than
  // at fetchPlaceContent (left unchanged) — a Place page must not surface
  // Activity in any section, including the general "Posts" list, which is
  // why this excludes it up front rather than just narrowing
  // isTimedContent's happening-now/upcoming check.
  const { happeningNow, upcoming, general } = useMemo(() => {
    const now = new Date();
    const visibleContent = content.filter((item) => item.type !== 'activity');
    const happeningNowItems: (ActivityContent | EventContent)[] = [];
    const upcomingItems: (ActivityContent | EventContent)[] = [];
    const generalItems: Content[] = [];
    for (const item of visibleContent) {
      if (isTimedContent(item)) {
        if (isHappeningNow(item, now)) {
          happeningNowItems.push(item);
          continue;
        }
        if (item.startsAt.toMillis() > now.getTime()) {
          upcomingItems.push(item);
          continue;
        }
      }
      generalItems.push(item);
    }
    upcomingItems.sort((a, b) => a.startsAt.toMillis() - b.startsAt.toMillis());
    return { happeningNow: happeningNowItems, upcoming: upcomingItems, general: generalItems };
  }, [content]);

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

          {content.length === 0 ? (
            <View>
              <SectionHeader title="What's happening here" />
              <View style={styles.emptyPanel}>
                <Text style={styles.emptyTitle}>Nothing happening here yet.</Text>
                <Text style={styles.emptyBody}>Be the first to share something happening at {place.name}.</Text>
                {user ? <Button label="Create" onPress={() => router.push('/create')} /> : null}
              </View>
            </View>
          ) : (
            <>
              {happeningNow.length > 0 ? (
                <View>
                  <SectionHeader title="Happening now 🔥" />
                  <View style={styles.cardRail}>
                    {happeningNow.map((item) => (
                      <EventCard key={item.contentId} item={item} />
                    ))}
                  </View>
                </View>
              ) : null}

              {upcoming.length > 0 ? (
                <View>
                  <SectionHeader title="Upcoming" />
                  <View style={styles.cardRail}>
                    {upcoming.map((item) => (
                      <EventCard key={item.contentId} item={item} />
                    ))}
                  </View>
                </View>
              ) : null}

              {general.length > 0 ? (
                <View>
                  <SectionHeader title="Posts" />
                  <View style={styles.contentList}>
                    {general.map((item) => (
                      <ContentCard key={item.contentId} item={item} currentUid={user?.uid ?? null} />
                    ))}
                  </View>
                </View>
              ) : null}
            </>
          )}
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
    // ContentCard itself carries no vertical margin (see its own styles) —
    // this list, like every other one that renders it, owns the spacing.
    gap: Spacing.md,
  },
  cardRail: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
});
