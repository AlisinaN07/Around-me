import { Ionicons } from '@expo/vector-icons';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { StatItem } from '@/components/StatItem';
import { Colors, Spacing, Typography } from '@/constants/theme';

type ProfileHeaderProps = {
  displayName: string;
  username: string;
  cityLabel: string;
  /** Real, bounded profile content count — see the caller for its exact source/limit. */
  postsCount: number;
  followersCount: number;
  followingCount: number;
  onPressFollowers?: () => void;
  onPressFollowing?: () => void;
  /** Absolutely-positioned top-right slot — settings gear (own) or overflow menu (public, non-self). */
  headerRight?: ReactNode;
};

/**
 * Shared identity block — avatar, name, username, city, Posts/Following/
 * Followers stats (Step 27). Used by both the own Profile tab and the
 * public profile route so they read as one visual system rather than two
 * (Step 27 Section 19). Deliberately carries no bio/likes-total/
 * verification-badge slot — none of that exists in the real schema yet
 * (see README "Profile v1" section).
 */
export function ProfileHeader({
  displayName,
  username,
  cityLabel,
  postsCount,
  followersCount,
  followingCount,
  onPressFollowers,
  onPressFollowing,
  headerRight,
}: ProfileHeaderProps) {
  return (
    <View style={styles.container}>
      {headerRight ? <View style={styles.headerRight}>{headerRight}</View> : null}

      <Avatar name={displayName || '?'} size={96} />

      <Text style={styles.displayName} numberOfLines={1}>
        {displayName}
      </Text>
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
        <StatItem value={postsCount} label="Posts" />
        <View style={styles.statDivider} />
        <StatItem value={followingCount} label="Following" onPress={onPressFollowing} />
        <View style={styles.statDivider} />
        <StatItem value={followersCount} label="Followers" onPress={onPressFollowers} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 4,
    paddingTop: Spacing.sm,
  },
  headerRight: {
    position: 'absolute',
    top: 0,
    right: 0,
  },
  displayName: {
    color: Colors.text,
    ...Typography.screenTitle,
    marginTop: Spacing.sm,
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
    marginTop: Spacing.lg,
  },
  statDivider: {
    width: 1,
    height: 24,
    backgroundColor: Colors.border,
  },
});
