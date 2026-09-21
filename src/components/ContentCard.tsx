import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthorLink } from '@/components/AuthorLink';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import type { Content } from '@/types/content';
import { formatEventTime, formatTimeAgo } from '@/utils/timeFormat';

type ContentCardProps = {
  item: Content;
  /** Signed-in user's own uid, to show the "You" indicator — never used for anything else. */
  currentUid: string | null;
  /**
   * Hides the author name/username/You-badge row. Defaults to true (every
   * existing call site keeps its current look). Profile screens (own and
   * other users') pass false for tabs that only ever show that SAME
   * profile's own authored content (Posts, Events) — the profile header
   * above already establishes whose content this is, so repeating their
   * name on every single card is redundant there. Reposts/Saved keep the
   * default: those items can be authored by someone else entirely, so the
   * author identity is still real information, not decoration.
   */
  showAuthor?: boolean;
  /**
   * Hides the "EVENT"/"POST"/"ACTIVITY" type pill, keeping the category
   * pill (if any). Defaults to true. The Business Profile Events tabs
   * (Live/Upcoming/Past — see (tabs)/profile.tsx and user/[uid]/index.tsx)
   * pass false: every card there is already known to be an Event, so
   * repeating that on each one is redundant, same reasoning as
   * showAuthor. Every mixed-type list (Reposts, Saved, Place feed) keeps
   * the default, where the type genuinely varies card to card.
   */
  showTypeBadge?: boolean;
};

const TYPE_LABEL: Record<Content['type'], string> = {
  post: 'Post',
  activity: 'Activity',
  event: 'Event',
};

/**
 * The type ("EVENT") + category ("🎵 Music") pill pair — shared by both
 * places it can render: its own row under the header (showAuthor), or
 * inline within the header itself, left-aligned against the time
 * (!showAuthor — see ContentCard's own render for why: no author row left
 * to anchor a separate line under).
 */
function TypeAndCategoryBadges({
  item,
  category,
  inline = false,
  showType = true,
}: {
  item: Content;
  category: (typeof INTERESTS)[number] | undefined;
  inline?: boolean;
  showType?: boolean;
}) {
  if (!showType && !category) return null;
  return (
    <View style={[styles.metaRow, inline && styles.metaRowInline]}>
      {showType && (
        <View style={styles.typeBadge}>
          <Text style={styles.typeBadgeText}>{TYPE_LABEL[item.type]}</Text>
        </View>
      )}
      {category && (
        <View style={styles.categoryPill}>
          <Text style={styles.categoryText}>
            {category.emoji} {category.label}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Renders a real content/{contentId} document — no invented engagement numbers, ever. */
export function ContentCard({ item, currentUid, showAuthor = true, showTypeBadge = true }: ContentCardProps) {
  const isOwn = currentUid !== null && item.authorUid === currentUid;
  const category = INTERESTS.find((interest) => interest.id === item.categoryId);
  const timeLabel = item.type === 'post' ? formatTimeAgo(item.createdAt.toDate()) : formatEventTime(item.startsAt.toDate());
  // Step 36's optional Event cover photo (no such field on Post/Activity).
  // Shown as this card's own background, everywhere an Event renders as a
  // ContentCard, with a dark overlay underneath every text element so it
  // stays readable over a busy photo — same idea as EventCard's MediaCard-
  // based cards and DetailHero's scrims, just a flat tint here rather than
  // a top/bottom gradient, since this card's text isn't confined to one
  // edge (header, title/description, and place all need contrast).
  const coverPhotoURL = item.type === 'event' ? item.coverPhotoURL : undefined;

  return (
    <Pressable
      style={styles.card}
      onPress={() => router.push(`/content/${item.contentId}`)}
      accessibilityRole="button"
      accessibilityLabel={`View ${item.type}`}
    >
      {coverPhotoURL ? (
        <>
          <Image source={{ uri: coverPhotoURL }} style={StyleSheet.absoluteFill} resizeMode="cover" />
          <View style={[StyleSheet.absoluteFill, styles.coverOverlay]} pointerEvents="none" />
        </>
      ) : null}

      <View style={styles.header}>
        {showAuthor ? (
          <View style={styles.authorRow}>
            <AuthorLink uid={item.authorUid} style={styles.authorLink}>
              <Text style={styles.authorName} numberOfLines={1}>
                {item.authorDisplayName}
              </Text>
              <Text style={styles.username} numberOfLines={1}>
                @{item.authorUsername}
              </Text>
            </AuthorLink>
            {isOwn && (
              <View style={styles.youBadge}>
                <Text style={styles.youText}>You</Text>
              </View>
            )}
          </View>
        ) : (
          // No author row to anchor the type/category badges under their
          // own separate line — they move up onto the same row as the
          // time instead, left-aligned against it.
          <TypeAndCategoryBadges item={item} category={category} showType={showTypeBadge} inline />
        )}
        <Text style={styles.time}>{timeLabel}</Text>
      </View>

      {showAuthor && <TypeAndCategoryBadges item={item} category={category} showType={showTypeBadge} />}

      {item.type === 'post' ? (
        // Clamped to one line, same reasoning as description below —
        // this is a browsing-list card, not the full detail screen
        // (which this card's own onPress already opens for the
        // untruncated text), so every card in the list should read as
        // one compact row regardless of how long its own text is.
        <Text style={styles.body} numberOfLines={1}>
          {item.body}
        </Text>
      ) : (
        <>
          <Text style={styles.title}>{item.title}</Text>
          {/* Clamped to one line — an unbounded description used to blow
              this card up to the length of its own text (visible once an
              Event/Activity had a genuinely long one), dwarfing every
              other card in the same list. Full text is one tap away on
              the real detail screen (this card's own onPress). */}
          <Text style={styles.description} numberOfLines={1}>
            {item.description}
          </Text>
        </>
      )}

      {item.placeName ? (
        <View style={styles.placeRow}>
          <Ionicons name="location-outline" size={13} color={Colors.textSecondary} />
          <Text style={styles.place} numberOfLines={1}>
            {item.placeName}
          </Text>
        </View>
      ) : null}

      {item.type === 'activity' && item.maxParticipants ? (
        <Text style={styles.meta}>Up to {item.maxParticipants} people</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Deliberately no marginBottom here — vertical spacing between cards is
  // the LIST's job (every real caller already wraps these in a container
  // with its own gap/rowGap: profile.tsx and user/[uid]/index.tsx's
  // contentList, place/[placeId].tsx's contentList, postsGrid's rowGap).
  // Adding a margin here too used to double that spacing.
  card: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginHorizontal: Spacing.lg,
    gap: Spacing.xs,
    // Keeps the absolutely-positioned cover photo below (when present)
    // clipped to the card's own rounded corners instead of poking out as
    // a sharp rectangle.
    overflow: 'hidden',
  },
  // Flat tint, not a gradient — this card's text isn't confined to one
  // edge the way DetailHero's is, so the whole photo needs even, uniform
  // darkening for every line of text to stay readable. Same base color as
  // this app's other dark scrims (Colors.background, #0A0A0D).
  coverOverlay: {
    backgroundColor: 'rgba(10, 10, 13, 0.72)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  authorLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  authorName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
    flexShrink: 1,
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 13,
    flexShrink: 1,
  },
  youBadge: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 1,
  },
  youText: {
    color: Colors.accent,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  time: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 0,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginTop: 2,
  },
  // Sits inside the header row itself (next to `time`, same baseline) —
  // metaRow's own marginTop is meant for spacing below the header, which
  // would misalign it here instead.
  metaRowInline: {
    marginTop: 0,
    flexShrink: 1,
  },
  typeBadge: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  typeBadgeText: {
    color: Colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  categoryPill: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  categoryText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '600',
  },
  body: {
    color: Colors.text,
    fontSize: 15,
    lineHeight: 21,
    marginTop: Spacing.xs,
  },
  title: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginTop: Spacing.xs,
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  placeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xs,
  },
  place: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  meta: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
});
