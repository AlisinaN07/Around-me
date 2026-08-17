import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { AuthorLink } from '@/components/AuthorLink';
import { Button } from '@/components/Button';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
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
        <Text style={styles.mutedText}>Loading…</Text>
      ) : status === 'error' ? (
        <View style={styles.centered}>
          <Text style={styles.errorText}>Couldn&apos;t load this list.</Text>
          <Button label="Try again" onPress={load} />
        </View>
      ) : profiles.length === 0 ? (
        <Text style={styles.mutedText}>{emptyText}</Text>
      ) : (
        <View style={styles.list}>
          {profiles.map((profile) => (
            <AuthorLink key={profile.uid} uid={profile.uid} style={styles.row}>
              <Avatar name={profile.displayName} size={40} />
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
          ))}
        </View>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  mutedText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  centered: {
    alignItems: 'center',
    gap: Spacing.sm,
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  list: {
    gap: Spacing.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
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
