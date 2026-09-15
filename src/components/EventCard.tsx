import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';

import { AuthorLink } from '@/components/AuthorLink';
import { DateBadge } from '@/components/DateBadge';
import { EventActionButtons } from '@/components/EventActionButtons';
import { MediaCard } from '@/components/MediaCard';
import { Pill } from '@/components/Pill';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing, Typography } from '@/constants/theme';
import type { ActivityContent, EventContent, EventResponseStatus } from '@/types/content';
import { getCityDayWindow, isHappeningNow } from '@/utils/dateWindows';
import { formatEventTime, formatTimePill } from '@/utils/timeFormat';

type EventCardVariant = 'compact' | 'hero' | 'row' | 'upcoming';

type EventCardProps = {
  item: ActivityContent | EventContent;
  /** Defaults to `new Date()` — only ever overridden by tests. */
  now?: Date;
  onPress?: () => void;
  /**
   * 'compact' (default) is the original discovery-rail/grid card used by
   * Place detail's "Happening now"/"Upcoming" rails — kept pixel-identical
   * so that screen needs zero changes for Step 26. 'hero'/'row'/'upcoming'
   * are the new Events-tab layouts (Happening Now / Today-or-Tonight /
   * This Weekend & Coming Up).
   */
  variant?: EventCardVariant;
  /**
   * Step 41.2G — Profile Activities only. When set, the 'row' variant
   * shows a static "Interested"/"Going" badge instead of the live,
   * viewer's-own-response EventActionButtons control: an Activities item
   * displays the PROFILE OWNER's response, which is never the viewer's own
   * state and is never itself tappable here (the real, actionable control
   * still lives only on the Event detail screen). Ignored by every other
   * variant — fully backward-compatible, existing callers are unaffected.
   */
  responseStatus?: EventResponseStatus;
};

/** Step 36 — an Event's own optional cover photo, or undefined for an Activity (no such field exists on ActivityContent) or an Event that never had one. MediaCard's own `source` prop has been ready for real media since Step 26; this is the first content type to actually supply one. */
function eventCoverSource(item: ActivityContent | EventContent): string | undefined {
  return item.type === 'event' ? item.coverPhotoURL : undefined;
}

type Badge = { label: string; tone: 'now' | 'soon' };

function getBadge(item: ActivityContent | EventContent, now: Date, liveLabel: string): Badge | null {
  if (isHappeningNow(item, now)) {
    return { label: liveLabel, tone: 'now' };
  }
  const startMs = item.startsAt.toMillis();
  const today = getCityDayWindow(now);
  if (startMs >= today.start.getTime() && startMs < today.end.getTime()) {
    return { label: now.getHours() >= 17 ? 'TONIGHT' : 'TODAY', tone: 'soon' };
  }
  return null;
}

export function EventCard({ item, now = new Date(), onPress, variant = 'compact', responseStatus }: EventCardProps) {
  if (variant === 'hero') return <HeroCard item={item} now={now} onPress={onPress} />;
  if (variant === 'row') return <RowCard item={item} now={now} onPress={onPress} responseStatus={responseStatus} />;
  if (variant === 'upcoming') return <UpcomingCard item={item} now={now} onPress={onPress} />;
  return <CompactCard item={item} now={now} onPress={onPress} />;
}

type VariantCardProps = { item: ActivityContent | EventContent; now: Date; onPress?: () => void };

/**
 * Happening Now — large horizontal card. Media on top (real fallback, no
 * stock imagery), LIVE pill overlaid only when the item is genuinely
 * happening now, then category/title/place/real actions below.
 */
function HeroCard({ item, now, onPress }: VariantCardProps) {
  const category = INTERESTS.find((interest) => interest.id === item.categoryId);
  const badge = getBadge(item, now, 'LIVE');
  const isActivity = item.type === 'activity';

  return (
    <Pressable
      style={styles.heroCard}
      onPress={onPress ?? (() => router.push(`/content/${item.contentId}`))}
      accessibilityRole="button"
      accessibilityLabel={`${isActivity ? 'Activity' : 'Event'}: ${item.title}`}
    >
      <MediaCard source={eventCoverSource(item)} emoji={category?.emoji} height={128} radius={Radius.lg}>
        {badge ? (
          <View style={styles.heroBadgeOverlay}>
            <Pill label={badge.label} tone={badge.tone === 'now' ? 'live' : 'neutral'} />
          </View>
        ) : null}
      </MediaCard>

      <View style={styles.heroBody}>
        <View style={styles.heroMetaRow}>
          <View style={[styles.typeBadge, isActivity ? styles.typeBadgeActivity : styles.typeBadgeEvent]}>
            <Ionicons name={isActivity ? 'people-outline' : 'calendar-outline'} size={10} color={Colors.background} />
            <Text style={styles.typeBadgeText}>{isActivity ? 'Activity' : 'Event'}</Text>
          </View>
          {category ? <Text style={styles.heroCategory}>{category.emoji} {category.label}</Text> : null}
        </View>

        <Text style={styles.heroTitle} numberOfLines={2}>
          {item.title}
        </Text>

        <View style={styles.metaLine}>
          <Ionicons name="time-outline" size={12} color={Colors.textSecondary} />
          <Text style={styles.metaText} numberOfLines={1}>
            {badge ? formatTimePill(item.startsAt.toDate()) : formatEventTime(item.startsAt.toDate(), now)}
          </Text>
        </View>

        <PlaceRow item={item} textStyle={styles.metaText} linkStyle={styles.metaLink} iconSize={12} />

        <View style={styles.heroActions}>
          <EventActionButtons item={item} direction="row" />
        </View>
      </View>
    </Pressable>
  );
}

/**
 * Today/Tonight — compact horizontal row. Left thumbnail, middle
 * time/title/place/category, right real action(s) (two stacked pills for
 * an Event, one for an Activity — narrow row width can't fit two
 * side-by-side Event pills legibly).
 *
 * Step 41.2G: when `responseStatus` is passed (Profile Activities only),
 * the trailing control is a static Interested/Going Pill instead of the
 * live EventActionButtons — see EventCardProps' own doc comment for why.
 */
function RowCard({ item, now, onPress, responseStatus }: VariantCardProps & { responseStatus?: EventResponseStatus }) {
  const category = INTERESTS.find((interest) => interest.id === item.categoryId);
  const badge = getBadge(item, now, 'LIVE');
  const isActivity = item.type === 'activity';

  return (
    <Pressable
      style={styles.rowCard}
      onPress={onPress ?? (() => router.push(`/content/${item.contentId}`))}
      accessibilityRole="button"
      accessibilityLabel={`${isActivity ? 'Activity' : 'Event'}: ${item.title}`}
    >
      <MediaCard source={eventCoverSource(item)} emoji={category?.emoji} height={64} radius={Radius.md} />

      <View style={styles.rowBody}>
        <Text style={styles.rowTime} numberOfLines={1}>
          {badge ? badge.label : formatTimePill(item.startsAt.toDate())}
        </Text>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <PlaceRow item={item} textStyle={styles.rowMetaText} linkStyle={styles.rowMetaLink} iconSize={11} />
        {category ? (
          <Text style={styles.rowCategory} numberOfLines={1}>
            {category.emoji} {category.label}
          </Text>
        ) : null}
      </View>

      {responseStatus ? (
        <Pill
          label={responseStatus === 'going' ? 'Going' : 'Interested'}
          tone={responseStatus === 'going' ? 'success' : 'accent'}
          icon={responseStatus === 'going' ? 'checkmark-circle' : 'star'}
        />
      ) : (
        <EventActionButtons item={item} direction="column" compact />
      )}
    </Pressable>
  );
}

/**
 * This Weekend / Coming Up — two-column card. Media with a date badge
 * overlay, title/place/category, real action below.
 */
function UpcomingCard({ item, now, onPress }: VariantCardProps) {
  const category = INTERESTS.find((interest) => interest.id === item.categoryId);
  const isActivity = item.type === 'activity';

  return (
    <Pressable
      style={styles.upcomingCard}
      onPress={onPress ?? (() => router.push(`/content/${item.contentId}`))}
      accessibilityRole="button"
      accessibilityLabel={`${isActivity ? 'Activity' : 'Event'}: ${item.title}`}
    >
      <MediaCard source={eventCoverSource(item)} emoji={category?.emoji} height={90} radius={Radius.lg}>
        <View style={styles.upcomingDateOverlay}>
          <DateBadge date={item.startsAt.toDate()} />
        </View>
      </MediaCard>

      <Text style={styles.upcomingTitle} numberOfLines={2}>
        {item.title}
      </Text>
      <Text style={styles.metaText} numberOfLines={1}>
        {formatEventTime(item.startsAt.toDate(), now)}
      </Text>
      <PlaceRow item={item} textStyle={styles.metaText} linkStyle={styles.metaLink} iconSize={12} />
      {category ? (
        <Text style={styles.rowCategory} numberOfLines={1}>
          {category.emoji} {category.label}
        </Text>
      ) : null}

      <View style={styles.upcomingActions}>
        <EventActionButtons item={item} direction="row" compact />
      </View>
    </Pressable>
  );
}

function PlaceRow({
  item,
  textStyle,
  linkStyle,
  iconSize,
}: {
  item: ActivityContent | EventContent;
  textStyle: StyleProp<TextStyle>;
  linkStyle: StyleProp<TextStyle>;
  iconSize: number;
}) {
  if (item.placeId) {
    return (
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
        <Ionicons name="location" size={iconSize} color={Colors.accent} />
        <Text style={linkStyle} numberOfLines={1}>
          {item.placeName}
        </Text>
      </Pressable>
    );
  }
  return (
    <View style={styles.placeRow}>
      <Ionicons name="location-outline" size={iconSize} color={Colors.textSecondary} />
      <Text style={textStyle} numberOfLines={1}>
        {item.placeName}
      </Text>
    </View>
  );
}

/**
 * Reusable discovery card for Activities and Events — the original Step 22
 * design, used unchanged by Place detail's "Happening now"/"Upcoming"
 * rails (src/app/(app)/place/[placeId].tsx). Deliberately shows no
 * invented attendance/popularity/price — real RSVP and participant counts
 * only exist on the detail screen (see EventDetail/ActivityDetail), fetched
 * once per screen rather than once per card in a list.
 */
function CompactCard({ item, now, onPress }: VariantCardProps) {
  const category = INTERESTS.find((interest) => interest.id === item.categoryId);
  const badge = getBadge(item, now, 'NOW');
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
        {badge ? <Pill label={badge.label} tone={badge.tone === 'now' ? 'live' : 'neutral'} /> : null}
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

      <PlaceRow item={item} textStyle={styles.placeText} linkStyle={styles.placeLinkText} iconSize={12} />

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
  // ---- compact (original, Place detail) ----
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
  title: {
    color: Colors.text,
    ...Typography.cardTitle,
    fontSize: 14,
    marginTop: 2,
  },
  time: {
    color: Colors.textSecondary,
    ...Typography.caption,
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

  // ---- shared meta text (new variants) ----
  metaLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  metaText: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  metaLink: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },

  // ---- hero (Happening Now) ----
  heroCard: {
    width: 260,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    overflow: 'hidden',
  },
  heroBadgeOverlay: {
    position: 'absolute',
    top: Spacing.sm,
    left: Spacing.sm,
  },
  heroBody: {
    padding: Spacing.sm,
    gap: 4,
  },
  heroMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heroCategory: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  heroTitle: {
    color: Colors.text,
    ...Typography.cardTitle,
    fontSize: 15,
  },
  heroActions: {
    marginTop: Spacing.xs,
  },

  // ---- row (Today/Tonight) ----
  rowCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowTime: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  rowTitle: {
    color: Colors.text,
    ...Typography.cardTitle,
    fontSize: 14,
  },
  rowMetaText: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  rowMetaLink: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  rowCategory: {
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '600',
  },

  // ---- upcoming (This Weekend / Coming Up) ----
  upcomingCard: {
    flexBasis: '48%',
    flexGrow: 1,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.sm,
    gap: 4,
  },
  upcomingDateOverlay: {
    position: 'absolute',
    top: Spacing.xs,
    left: Spacing.xs,
  },
  upcomingTitle: {
    color: Colors.text,
    ...Typography.cardTitle,
    fontSize: 14,
    marginTop: 2,
  },
  upcomingActions: {
    marginTop: 2,
  },
});
