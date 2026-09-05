import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { AuthorLink } from '@/components/AuthorLink';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Spacing } from '@/constants/theme';
import type { PublicProfile } from '@/types/social';
import { formatCityDisplayName } from '@/utils/cityDisplay';

type LoadStatus = 'loading' | 'loaded' | 'error';

type UserListProps = {
  title: string;
  emptyText: string;
  fetcher: () => Promise<PublicProfile[]>;
};

/** Shared list UI for Followers/Following — a title, a fetch function, and nothing else differs between them. */
export function UserList({ title, emptyText, fetcher }: UserListProps) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const list = await fetcher();
      setProfiles(list);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [fetcher]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <HeaderScreenLayout title={title}>
      {status === 'loading' ? (
        <LoadingState size="large" />
      ) : status === 'error' ? (
        <ErrorState title="Couldn't load this list" onRetry={load} />
      ) : profiles.length === 0 ? (
        <EmptyState icon="people-outline" title={emptyText} />
      ) : (
        <ProfileList profiles={profiles} />
      )}
    </HeaderScreenLayout>
  );
}

/**
 * Shared profile-row list — the same Avatar/name/@username/city row used
 * by Followers/Following, reused as-is by global People Search (Step 37)
 * so both surfaces render identically rather than maintaining two visual
 * copies of the same row.
 */
export function ProfileList({ profiles }: { profiles: PublicProfile[] }) {
  return (
    <View style={styles.list}>
      {profiles.map((profile, index) => (
        <ProfileRow key={profile.uid} profile={profile} isLast={index === profiles.length - 1} />
      ))}
    </View>
  );
}

export function ProfileRow({ profile, isLast }: { profile: PublicProfile; isLast?: boolean }) {
  return (
    <AuthorLink uid={profile.uid} style={[styles.row, isLast && styles.rowLast]}>
      <Avatar name={profile.displayName} size={52} />
      <View style={styles.rowText}>
        <Text style={styles.displayName} numberOfLines={1}>
          {profile.displayName}
        </Text>
        <Text style={styles.username} numberOfLines={1}>
          @{profile.username}
          {profile.cityName ? ` · ${formatCityDisplayName(profile.cityName)}` : ''}
        </Text>
      </View>
    </AuthorLink>
  );
}

const styles = StyleSheet.create({
  list: {
    marginHorizontal: -Spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  displayName: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
});
