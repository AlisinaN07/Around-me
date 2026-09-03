import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthorLink } from '@/components/AuthorLink';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { ActivityContent, EventContent } from '@/types/content';
import { getCityDayWindow, isHappeningNow } from '@/utils/dateWindows';
import { formatEventTime, formatTimePill } from '@/utils/timeFormat';

type EventCardProps = {
  item: ActivityContent | EventContent;
  /** Defaults to `new Date()` — only ever overridden by tests. */
  now?: Date;
  onPress?: () => void;
};

type Badge = { label: string; tone: 'now' | 'soon' };

function getBadge(item: ActivityContent | EventContent, now: Date): Badge | null {
  if (isHappeningNow(item, now)) {
    return { label: 'NOW', tone: 'now' };
  }
  const startMs = item.startsAt.toMillis();
  const today = getCityDayWindow(now);
  if (startMs >= today.start.getTime() && startMs < today.end.getTime()) {
    return { label: now.getHours() >= 17 ? 'TONIGHT' : 'TODAY', tone: 'soon' };
  }
  return null;
}

/**
 * Reusable discovery card for Activities and Events (Happening Now/Today/
 * Upcoming rails, the /events screen). Deliberately shows no invented
 * attendance/popularity/price — real RSVP and participant counts only
 * exist on the detail screen (see EventDetail/ActivityDetail), fetched
 * once per screen rather than once per card in a list.
 */
export function EventCard({ item, now = new Date(), onPress }: EventCardProps) {
  const category = INTERESTS.find((interest) => interest.id === item.categoryId);
  const badge = getBadge(item, now);
  const isActivity = item.type === 'activity';

  return (
    <Pressable
      style={styles.card}
      onPress={onPress ?? (() => router.push(`/content/${item.contentId}`))}
      accessibilityRole="button"
      accessibilityLabel={`${isActivity ? 'Activity' : 'Event'}: ${item.title}`}
    >
      <View style={styles.topRow}>
        <View style={[styles.typeBadge, isActivity ? styles.typeBadgeActivity : styles.typeBadgeEvent]}>
          <Ionicons name={isActivity ? 'people-outline' : 'calendar-outline'} size={11} color={Colors.background} />
          <Text style={styles.typeBadgeText}>{isActivity ? 'Activity' : 'Event'}</Text>
        </View>
        {badge ? (
          <View style={[styles.timeBadge, badge.tone === 'now' && styles.timeBadgeNow]}>
            <Text style={styles.timeBadgeText}>{badge.label}</Text>
          </View>
        ) : null}
      </View>

      <Text style={styles.title} numberOfLines={2}>
        {item.title}
      </Text>

      <Text style={styles.time} numberOfLines={1}>
        {/* The badge above already says NOW/TODAY/TONIGHT, so just the clock
            time avoids repeating "Today" — further-out items fall back to
            formatEventTime's full "Tomorrow, 19:00" / "Fri, 19:00" label. */}
        {badge ? formatTimePill(item.startsAt.toDate()) : formatEventTime(item.startsAt.toDate(), now)}
      </Text>

      {item.placeId ? (
        <Pressable
          onPress={(event) => {
            event.stopPropagation();
            router.push(`/place/${item.placeId}`);
          }}
          hitSlop={4}
          style={styles.placeRow}
          accessibilityRole="button"
          accessibilityLabel={`View ${item.placeName}`}
        >
          <Ionicons name="location" size={12} color={Colors.accent} />
          <Text style={styles.placeLinkText} numberOfLines={1}>
            {item.placeName}
          </Text>
        </Pressable>
      ) : (
        <View style={styles.placeRow}>
          <Ionicons name="location-outline" size={12} color={Colors.textSecondary} />
          <Text style={styles.placeText} numberOfLines={1}>
            {item.placeName}
          </Text>
        </View>
      )}

      <View style={styles.bottomRow}>
        <AuthorLink uid={item.authorUid} style={styles.authorLink}>
          <Text style={styles.authorText} numberOfLines={1}>
            @{item.authorUsername}
          </Text>
        </AuthorLink>
        {category ? (
          <Text style={styles.categoryText} numberOfLines={1}>
            {category.emoji} {category.label}
          </Text>
        ) : null}
      </View>

      {isActivity ? (
        <View style={styles.joinPill}>
          <Text style={styles.joinPillText}>Join</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const CARD_WIDTH = 188;

const styles = StyleSheet.create({
  card: {
    width: CARD_WIDTH,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.sm,
    gap: 4,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  typeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  typeBadgeActivity: {
    backgroundColor: Colors.textSecondary,
  },
  typeBadgeEvent: {
    backgroundColor: Colors.accent,
  },
  typeBadgeText: {
    color: Colors.background,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  timeBadge: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  timeBadgeNow: {
    backgroundColor: Colors.error,
    borderColor: Colors.error,
  },
  timeBadgeText: {
    color: Colors.text,
    fontSize: 10,
    fontWeight: '700',
  },
  title: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    marginTop: 2,
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  placeText: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  placeLinkText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 2,
    gap: Spacing.xs,
  },
  authorLink: {
    flexShrink: 1,
  },
  authorText: {
    color: Colors.textSecondary,
    fontSize: 11,
  },
  categoryText: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: '600',
    flexShrink: 0,
  },
  joinPill: {
    alignSelf: 'flex-start',
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    marginTop: 2,
  },
  joinPillText: {
    color: Colors.accent,
    fontSize: 10,
    fontWeight: '700',
  },
});
