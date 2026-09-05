import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ProfileList } from '@/components/UserList';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { searchPublicProfilesByUsername } from '@/services/publicProfile';
import type { PublicProfile } from '@/types/social';
import { normalizeUsernameSearchQuery } from '@/utils/username';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

type SearchStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Global people search (Step 37) — searches `publicProfiles` by
 * `usernameLower` prefix only. Deliberately no display-name search, no
 * recommendations, no Active-City scoping (see README) — this is
 * intentionally the simplest possible username-discovery loop: type a
 * username, tap a result, land on the real Public Profile, which already
 * owns Follow/Message/Block/Report.
 */
export default function SearchScreen() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [results, setResults] = useState<PublicProfile[]>([]);

  // Fetched once per screen visit (not once per keystroke query) — the
  // same bounded, existing `fetchMyBlockedUserIds` mechanism Home already
  // uses for its own client-side content filtering. My own outgoing
  // blocks only; there is deliberately no efficient way to check whether
  // someone has blocked ME without an extra read per result, so that
  // direction is left to Public Profile's own existing block guard (see
  // README "Block semantics").
  const blockedUidsRef = useRef<Set<string>>(new Set());

  // Debounce timer + a monotonically increasing generation counter: if
  // "al" is still in flight when "ali" fires, "al"'s response arrives
  // later but its generation no longer matches the latest one issued, so
  // it's discarded instead of overwriting "ali"'s results.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (user) {
      fetchMyBlockedUserIds(user.uid).then((uids) => {
        blockedUidsRef.current = new Set(uids);
      });
    }
  }, [user]);

  const runSearch = (normalizedQuery: string) => {
    const generation = ++generationRef.current;
    setStatus('loading');
    searchPublicProfilesByUsername(normalizedQuery)
      .then((profiles) => {
        if (generation !== generationRef.current) return; // stale — a newer query has already superseded this one
        const visible = profiles.filter(
          (profile) => profile.uid !== user?.uid && !blockedUidsRef.current.has(profile.uid)
        );
        setResults(visible);
        setStatus('loaded');
      })
      .catch(() => {
        if (generation !== generationRef.current) return;
        setStatus('error');
      });
  };

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const normalized = normalizeUsernameSearchQuery(query);
    if (normalized.length < MIN_QUERY_LENGTH) {
      // Bumping the generation here discards any in-flight query so a
      // slow response can't repopulate results after the user deleted
      // back down below the minimum length.
      generationRef.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- status/results are derived from the debounced query, not from a separate data source; reverting them the instant the query drops below the minimum length (rather than only on the next debounce fire) is the correct behavior here, not an effect antipattern.
      setStatus('idle');
      setResults([]);
      return;
    }

    debounceRef.current = setTimeout(() => runSearch(normalized), DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const handleRetry = () => {
    const normalized = normalizeUsernameSearchQuery(query);
    if (normalized.length >= MIN_QUERY_LENGTH) runSearch(normalized);
  };

  return (
    <HeaderScreenLayout title="Search">
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={18} color={Colors.textSecondary} style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search people"
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

      {status === 'idle' ? (
        <EmptyState bare icon="search-outline" title="Find people on Around Me" body="Search by username." />
      ) : status === 'loading' ? (
        <LoadingState size="small" />
      ) : status === 'error' ? (
        <ErrorState title="Couldn't load results" onRetry={handleRetry} />
      ) : results.length === 0 ? (
        <EmptyState bare icon="person-outline" title="No people found" />
      ) : (
        <ProfileList profiles={results} />
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
});
