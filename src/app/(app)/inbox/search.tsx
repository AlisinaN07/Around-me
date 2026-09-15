import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { EmptyState } from '@/components/EmptyState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchFollowingUids } from '@/services/following';
import { fetchPublicProfile } from '@/services/publicProfile';
import type { PublicProfile } from '@/types/social';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * A dedicated full-screen search over exactly the people you follow —
 * reached by tapping the search icon on Inbox (src/app/(app)/(tabs)/inbox.tsx).
 * Deliberately NOT the global username search (src/app/(app)/search.tsx,
 * reached from Home instead, which queries `publicProfiles` directly and
 * lands on a Public Profile): this one fetches your own following list
 * ONCE up front (the same bounded fetchFollowingUids this app already
 * uses everywhere else) and filters it locally per keystroke, and tapping
 * a result opens a chat with them directly — the obvious action from an
 * Inbox, not a detour through their Profile first.
 */
export default function InboxFollowingSearchScreen() {
  const { user } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [profiles, setProfiles] = useState<PublicProfile[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    // Resets fresh on mount — this screen is always a fresh push, never
    // reused across visits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus('loading');
    (async () => {
      try {
        const followedUids = await fetchFollowingUids(user.uid);
        const fetched = await Promise.all(followedUids.map((uid) => fetchPublicProfile(uid)));
        if (cancelled) return;
        setProfiles(fetched.filter((profile): profile is PublicProfile => profile !== null));
        setStatus('loaded');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const filteredProfiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter((profile) => profile.displayName.toLowerCase().includes(q) || profile.username.toLowerCase().includes(q));
  }, [profiles, query]);

  return (
    <HeaderScreenLayout title="Search">
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={18} color={Colors.textSecondary} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search people you follow"
          placeholderTextColor={Colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
        {query.length > 0 ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={18} color={Colors.textSecondary} />
          </Pressable>
        ) : null}
      </View>

      {status === 'loading' ? (
        <LoadingState size="small" />
      ) : status === 'error' ? (
        <EmptyState bare icon="alert-circle-outline" title="Couldn't load your following list" />
      ) : profiles.length === 0 ? (
        <EmptyState bare icon="people-outline" title="You aren't following anyone yet" />
      ) : filteredProfiles.length === 0 ? (
        <EmptyState bare icon="search-outline" title="No people found" />
      ) : (
        <View style={styles.list}>
          {filteredProfiles.map((profile, index) => (
            <Pressable
              key={profile.uid}
              onPress={() => router.push(`/chat/${profile.uid}`)}
              style={[styles.row, index === filteredProfiles.length - 1 && styles.rowLast]}
              accessibilityRole="button"
              accessibilityLabel={`Message ${profile.displayName}`}
            >
              <Avatar name={profile.displayName} photoURL={profile.photoURL} size={52} />
              <View style={styles.rowText}>
                <Text style={styles.displayName} numberOfLines={1}>
                  {profile.displayName}
                </Text>
                <Text style={styles.username} numberOfLines={1}>
                  @{profile.username}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  searchIcon: {
    marginTop: 1,
  },
  searchInput: {
    flex: 1,
    minHeight: 48,
    color: Colors.text,
    fontSize: 15,
  },
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
