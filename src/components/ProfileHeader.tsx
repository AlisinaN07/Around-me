import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { StatItem } from '@/components/StatItem';
import { Colors, Layout, Radius, Spacing, Typography } from '@/constants/theme';

const AVATAR_SIZE = 96;
// A dedicated blue, not one of the shared theme's own tokens — this badge
// is the one place in the app that needs a neutral "verified/official"
// blue (matching the convention real platforms use for a business/
// verified mark), distinct from Colors.accent's own red brand color,
// which would read as just another accent highlight here rather than a
// distinct status indicator.
const BUSINESS_BADGE_COLOR = '#3B82F6';
// How tall the visible cover banner is. Bigger than a plain "card behind
// the avatar" — it reaches down to just above the display name, so the
// photo (and its fade) fills the whole space behind the avatar instead of
// cutting off partway and leaving a plain black gap before the name.
const COVER_HEIGHT = 200;
// Where the identity block (avatar + name + everything below) starts,
// measured from the top of the cover — this is what actually controls the
// avatar's position, independent of COVER_HEIGHT now that the cover is
// absolutely positioned behind it (see the render below). Chosen so the
// avatar sits the same place it always has: half-overlapping a banner,
// same as before this was decoupled.
const IDENTITY_TOP_OFFSET = 88;

type ProfileHeaderProps = {
  displayName: string;
  /** True for a Business account (see isBusinessAccount) — shows a small blue "B" badge right next to the display name, the one visual marker distinguishing a company account from a Personal one on this shared header. Defaults to false so an unmigrated caller keeps the exact same look as before this existed. */
  isBusiness?: boolean;
  username: string;
  cityLabel: string;
  /** Real, already-resolved profile photo download URL — see UserProfile.photoURL. Falls back to the initials Avatar when empty/absent. */
  photoURL?: string;
  /**
   * Real, already-resolved cover/banner download URL — see
   * UserProfile.coverPhotoURL. Renders no banner at all when empty/absent
   * (never a placeholder), leaving the header exactly as it looked before
   * this existed.
   */
  coverPhotoURL?: string;
  /**
   * How much horizontal padding the caller's own screen already applies
   * before this component (e.g. Spacing.lg on the own Profile tab,
   * Spacing.xl on the public profile's HeaderScreenLayout) — the cover
   * banner cancels exactly that much with a negative margin so it reaches
   * the true screen edges on both sides instead of sitting inset like a
   * card. Ignored when there's no cover to show. Defaults to 0 (no bleed)
   * so an unmigrated caller keeps the old contained-card look.
   */
  coverEdgeInset?: number;
  /** Real, bounded profile content count — see the caller for its exact source/limit. */
  postsCount: number;
  /** Label for the postsCount stat — 'Posts' by default. A Business account's Profile passes 'Events' along with an events count instead, since its Profile is Events-only (see (tabs)/profile.tsx and user/[uid]/index.tsx). */
  postsLabel?: string;
  followersCount: number;
  followingCount: number;
  /**
   * Lifetime-earned, non-self Post Likes received (Step 41.2H.4) —
   * authoritative only when present. `undefined` means the count isn't
   * (yet) ready/available for this load and the whole stat is hidden;
   * there is deliberately no default of 0, since 0 is only ever a real
   * value once the caller has an actual server-verified count (see
   * src/services/profileLiked.ts).
   */
  likedCount?: number;
  onPressFollowers?: () => void;
  onPressFollowing?: () => void;
  /** Absolutely-positioned top-right slot — settings gear (own) or overflow menu (public, non-self). */
  headerRight?: ReactNode;
};

/**
 * Shared identity block — cover banner, avatar, name, username, city,
 * Posts/Following/Followers/Liked stats (Step 27, cover banner added
 * later). Bio renders separately, further down each caller's own screen
 * (below Edit profile / Follow-Message — see profile.tsx and
 * user/[uid]/index.tsx) rather than here, per later feedback that it
 * read better there than tucked right under the city. Used by both the
 * own Profile tab and the public profile route so they read as one
 * visual system rather than two (Step 27 Section 19). Carries no online-status
 * indicator — that doesn't exist in the real schema. The one real
 * exception is `isBusiness`'s own small "B" badge next to the name: not a
 * third-party verification mark, just this app's own honest "this is a
 * company account" fact (see accountType in src/types/user.ts).
 */
export function ProfileHeader({
  displayName,
  isBusiness = false,
  username,
  cityLabel,
  photoURL,
  coverPhotoURL,
  coverEdgeInset = 0,
  postsCount,
  postsLabel = 'Posts',
  followersCount,
  followingCount,
  likedCount,
  onPressFollowers,
  onPressFollowing,
  headerRight,
}: ProfileHeaderProps) {
  const hasCover = !!coverPhotoURL;

  // On a wide web viewport, `page`/`content`'s own maxWidth caps out at
  // Layout.maxContentWidth and gets centered (see profile.tsx/HeaderScreenLayout)
  // — that adds an extra gap OUTSIDE the padded content on both sides that
  // coverEdgeInset alone (which only cancels the padding INSIDE it) can't
  // reach. This measures that outer gap directly from the real window width
  // so the cover still bleeds to the true screen edge no matter how wide the
  // window is. On native and on a narrow/mobile web viewport this is 0 —
  // the content never gets capped there in the first place.
  const { width: windowWidth } = useWindowDimensions();
  const outerCenteringGap = Math.max(0, (windowWidth - Layout.maxContentWidth) / 2);
  const coverBleed = coverEdgeInset + outerCenteringGap;

  return (
    <View style={styles.container}>
      {hasCover ? (
        // Absolutely positioned (not in flow) so its own height, driven by
        // COVER_HEIGHT, is completely independent of where the identity
        // block below starts — growing the banner never pushes the avatar/
        // name down with it. left/right (rather than a width + negative
        // margin) is what lets it bleed past coverEdgeInset here: with no
        // explicit width, the box's edges ARE the left/right values, so it
        // sizes itself to exactly fill the gap between them.
        <View style={[styles.coverWrap, { left: -coverBleed, right: -coverBleed }, coverEdgeInset > 0 && styles.coverWrapEdgeToEdge]}>
          {/* Perf pass — expo-image, memory+disk cached: the same
              coverPhotoURL renders here on every visit to this profile
              (own or someone else's), so a real cache means it's instant
              after the first load. contentFit="cover" matches the plain
              <Image>'s own prior default resizeMode exactly. */}
          <Image source={{ uri: coverPhotoURL }} style={styles.cover} contentFit="cover" cachePolicy="memory-disk" />
          {/* Fades the cover's own bottom edge into the page background
              instead of a hard cutoff — same scrim technique DetailHero
              uses for its hero image. */}
          <LinearGradient
            colors={['transparent', 'rgba(10, 10, 13, 0.75)', Colors.background]}
            locations={[0, 0.55, 1]}
            style={styles.coverFade}
            pointerEvents="none"
          />
          {/* Positioned relative to the (possibly bled-out) cover itself,
              not the container, so it stays anchored to the banner's own
              true edge regardless of coverEdgeInset. */}
          {headerRight ? <View style={styles.headerRightOnCover}>{headerRight}</View> : null}
        </View>
      ) : headerRight ? (
        <View style={styles.headerRight}>{headerRight}</View>
      ) : null}

      {/* position: 'relative' + a higher zIndex than coverWrap's, so this
          paints on top of the absolutely-positioned cover behind it
          instead of getting hidden under it — positioned elements stack
          above plain in-flow ones by default regardless of DOM order. */}
      <View style={[styles.identity, hasCover && styles.identityWithCover]}>
        {hasCover ? (
          <View style={styles.avatarRing}>
            <Avatar name={displayName || '?'} photoURL={photoURL} size={AVATAR_SIZE} />
          </View>
        ) : (
          <Avatar name={displayName || '?'} photoURL={photoURL} size={AVATAR_SIZE} />
        )}

        <View style={styles.nameRow}>
          <Text style={styles.displayName} numberOfLines={1}>
            {displayName}
          </Text>
          {isBusiness ? (
            <View style={styles.businessBadge} accessibilityLabel="Business account">
              <Text style={styles.businessBadgeText}>B</Text>
            </View>
          ) : null}
        </View>
        {username ? <Text style={styles.username}>@{username}</Text> : null}
        {cityLabel ? (
          <View style={styles.locationRow}>
            <Ionicons name="location" size={14} color={Colors.accent} />
            <Text style={styles.locationText} numberOfLines={1}>
              {cityLabel}
            </Text>
          </View>
        ) : null}

        <View style={styles.statsRow}>
          <StatItem value={postsCount} label={postsLabel} />
          <View style={styles.statDivider} />
          <StatItem value={followingCount} label="Following" onPress={onPressFollowing} />
          <View style={styles.statDivider} />
          <StatItem value={followersCount} label="Followers" onPress={onPressFollowers} />
          {likedCount !== undefined ? (
            <>
              <View style={styles.statDivider} />
              <StatItem value={likedCount} label="Liked" />
            </>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 4,
    // The absolutely-positioned coverWrap below anchors to this box, so it
    // needs to actually be a positioning context — 'relative' is View's
    // own default, stated explicitly here since it matters.
    position: 'relative',
  },
  // Positioned (not in normal flow) so its height is independent of the
  // identity block's own position — see COVER_HEIGHT/IDENTITY_TOP_OFFSET's
  // doc comments above. left/right are set inline per-render (plain 0, or
  // -coverBleed to reach past coverEdgeInset) — with no explicit width,
  // the box just fills whatever gap those two edges leave.
  coverWrap: {
    position: 'absolute',
    top: 0,
    height: COVER_HEIGHT,
    borderRadius: Radius.lg,
    overflow: 'hidden',
    backgroundColor: Colors.surface,
    zIndex: 0,
  },
  coverWrapEdgeToEdge: {
    borderRadius: 0,
  },
  cover: {
    width: '100%',
    height: '100%',
  },
  // Starts around the avatar's own vertical middle (well above the name)
  // and darkens the rest of the way down — a bigger, stronger fade than a
  // thin strip at the very bottom, with a middle color stop (see the
  // LinearGradient's own `colors`/`locations` above) so the darkening
  // reads as a real blend rather than a flat linear wash.
  coverFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 160,
  },
  headerRight: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  // Sits over the banner image instead of the plain background — same
  // corner, just inset a little so it doesn't touch the true screen edge.
  headerRightOnCover: {
    position: 'absolute',
    top: Spacing.sm,
    right: Spacing.sm,
  },
  identity: {
    alignItems: 'center',
    gap: 4,
    paddingTop: Spacing.sm,
    // See the render method's own comment: this needs to paint above the
    // absolutely-positioned coverWrap, which coverEdgeInset > 0 aside would
    // otherwise sit on top of it by default (positioned elements stack
    // above static ones regardless of DOM order).
    position: 'relative',
    zIndex: 1,
  },
  // Starts the avatar at IDENTITY_TOP_OFFSET instead of the plain top
  // padding above — a fixed position, deliberately NOT derived from
  // COVER_HEIGHT, so resizing the banner never moves the avatar/name.
  identityWithCover: {
    paddingTop: IDENTITY_TOP_OFFSET,
  },
  // A plain ring in the page background color, purely to separate the
  // avatar visually from a busy cover image behind it — not a status
  // indicator of any kind.
  avatarRing: {
    padding: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: Spacing.sm,
    // identity's own alignItems: 'center' would otherwise let this row
    // stretch to the width of whatever's widest in the column (the stats
    // row, the cover-bled banner, ...) — constraining it to its own
    // content keeps the badge hugging the name instead of drifting off to
    // the right edge of that wider box.
    alignSelf: 'center',
    maxWidth: '100%',
  },
  displayName: {
    color: Colors.text,
    ...Typography.screenTitle,
    // Lets a long name truncate (numberOfLines={1} above) before it ever
    // pushes the badge next to it off-screen.
    flexShrink: 1,
  },
  businessBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: BUSINESS_BADGE_COLOR,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  businessBadgeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  locationText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    // `identity`'s own alignItems: 'center' shrink-wraps every other child
    // in this block (avatar, name, city, ...) — this row needs to ignore
    // that so justifyContent above has room to spread the stats out,
    // rather than bunching them in the middle. Full-width (100%) read as
    // too wide once built; 80% keeps the spread-out look while pulling
    // both edges in — still centered, via identity's own alignItems.
    width: '80%',
    marginTop: Spacing.lg,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: Colors.border,
  },
});
