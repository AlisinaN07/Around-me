import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { ProfileList } from '@/components/UserList';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useCity } from '@/providers/CityProvider';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchFollowing } from '@/services/following';
import { normalizeHashtag, searchHashtagsRanked } from '@/services/hashtags';
import { getTrendingHashtagsForCity } from '@/services/hashtagTrends/hashtagTrendService';
import { setPendingSelectedMention } from '@/services/mentionHandoff';
import { searchPublicProfilesByUsername } from '@/services/publicProfile';
import type { Hashtag } from '@/types/hashtag';
import type { TrendingHashtag } from '@/types/hashtagTrend';
import type { PublicProfile } from '@/types/social';
import { formatPostCount } from '@/utils/postCount';
import { normalizeUsernameSearchQuery } from '@/utils/username';

const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 300;

// Hashtag search (Step 4) — a larger bounded server pool than the
// composer's own autocomplete (which favors a tight, fast-typing-friendly
// list — see HASHTAG_SUGGESTION_LIMIT in create/reel/index.tsx), since
// Search is a more deliberate, browse-oriented action and this screen has
// no other per-keystroke Firestore cost competing for the same budget.
// Still well within this feature's own "20-30 candidates" ceiling — never
// the whole collection. Displayed count stays modest (5-10 suggested) so
// the Hashtags section reads as one part of Search, not a takeover.
const HASHTAG_SEARCH_FETCH_LIMIT = 25;
const HASHTAG_SEARCH_DISPLAY_LIMIT = 8;

type SearchStatus = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Global people search (Step 37) — searches `publicProfiles` by
 * `usernameLower` prefix only. Deliberately no display-name search, no
 * recommendations, no Active-City scoping (see README) — this is
 * intentionally the simplest possible username-discovery loop: type a
 * username, tap a result, land on the real Public Profile, which already
 * owns Follow/Message/Block/Report.
 *
 * `?mode=select` (per explicit request — the "@ Mention" button on the
 * Create Post caption screen, src/app/(app)/create/reel/index.tsx) turns
 * this same search into a picker instead: the exact same query, against
 * the exact same publicProfiles collection — followed or not, there is no
 * follow-based filtering on the SEARCH itself either way (Step 37's own
 * locked scope) — but tapping a result hands it back via
 * mentionHandoff.ts and pops this screen, rather than navigating on to
 * their Public Profile. Select mode also gets its own default, BEFORE any
 * query is typed: everyone the viewer already follows, alphabetical by
 * display name (see the followingProfiles state below) — mentioning
 * someone you follow shouldn't require typing their exact username first.
 *
 * Step 4 adds a Hashtags section alongside people results (never shown in
 * `?mode=select`, which is purely about picking a person to mention) —
 * see the hashtagQuery/hashtagResults state below. Deliberately its own
 * separate debounce+generation pair rather than folded into the people-
 * search effect above: both use the exact same DEBOUNCE_MS, so they still
 * fire together in practice, but keeping them apart means Step 4 never
 * risks changing a single line of the already-correct, already-tested
 * people-search path above.
 */
export default function SearchScreen() {
  const { user } = useAuth();
  const { activeScope, activeScopeLabel } = useCity();
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const isSelectMode = mode === 'select';
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<SearchStatus>('idle');
  const [results, setResults] = useState<PublicProfile[]>([]);

  // Trending Hashtags — shown only on the empty-query state (never
  // competing with active People/Hashtag search results below), and only
  // when the active scope is a single, unambiguous city (Step 28's own
  // "do not guess — simply omit the section" instruction: a Country/
  // World/multi-city scope has no one city to attribute a trend list to).
  // Fetched once per city (the service's own short TTL cache — see
  // hashtagTrendService.ts — already avoids re-querying on every
  // remount/focus within that window), never tied to the debounced
  // People/Hashtag search below.
  const trendingCityId = activeScope.kind === 'city' ? activeScope.cityKey : null;
  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([]);

  useEffect(() => {
    if (!trendingCityId || isSelectMode) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- trendingHashtags is derived from trendingCityId, not a separate data source; clearing it the instant there's no single city to trend for (rather than only on the next fetch) is correct here, same reasoning as this file's own hashtagResults-clearing effect above.
      setTrendingHashtags([]);
      return;
    }
    let cancelled = false;
    getTrendingHashtagsForCity(trendingCityId).then((results) => {
      if (!cancelled) setTrendingHashtags(results);
    });
    return () => {
      cancelled = true;
    };
  }, [trendingCityId, isSelectMode]);

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

  // Select mode's own "before you even start typing" default (per
  // explicit request) — everyone the viewer already follows, alphabetical
  // by display name, so mentioning someone you follow never needs typing
  // their exact username first. Fetched once per screen visit, same
  // "not once per keystroke" shape as the blocked-uids fetch just above;
  // only ever shown while `query` is empty (see the render below) — the
  // instant a real search starts, this list gets out of its way rather
  // than mixing with search results.
  const [followingProfiles, setFollowingProfiles] = useState<PublicProfile[]>([]);
  const [followingStatus, setFollowingStatus] = useState<'idle' | 'loading' | 'loaded'>('idle');

  useEffect(() => {
    if (!isSelectMode || !user) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- followingStatus is derived from this fetch, not a separate data source; entering 'loading' the instant the fetch starts (rather than only once it resolves) is the correct behavior here, not an effect antipattern — same reasoning as this file's own mentionQuery-driven search effect.
    setFollowingStatus('loading');
    fetchFollowing(user.uid).then((profiles) => {
      if (cancelled) return;
      const visible = profiles
        .filter((profile) => profile.uid !== user.uid && !blockedUidsRef.current.has(profile.uid))
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
      setFollowingProfiles(visible);
      setFollowingStatus('loaded');
    });
    return () => {
      cancelled = true;
    };
  }, [isSelectMode, user]);

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

  // Hashtags section (Step 4) — never shown in select mode, which is
  // purely about picking a person to mention. Reuses Step 1's own
  // normalizeHashtag directly as the "is there a hashtag-shaped query
  // here at all" gate: it already strips an optional leading "#",
  // lowercases, and validates the same charset a real hashtag must have —
  // so "football", "#football", "Football", and "#FOOTBALL" all collapse
  // to the identical canonical prefix "football" with no separate
  // normalization logic, and a bare "#" (empty after stripping) or
  // anything containing a space/punctuation correctly yields `null`,
  // meaning no hashtag query at all this keystroke — never an unbounded
  // or nonsensical Firestore request.
  const hashtagQuery = isSelectMode ? null : normalizeHashtag(query);
  const [hashtagResults, setHashtagResults] = useState<Hashtag[]>([]);
  const hashtagDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hashtagGenerationRef = useRef(0);

  useEffect(() => {
    if (hashtagDebounceRef.current) clearTimeout(hashtagDebounceRef.current);
    if (!hashtagQuery) {
      // Discards any in-flight hashtag search too (same reasoning as the
      // people-search effect's own identical generation bump above) —
      // covers the query dropping to empty, to a bare "#", or to
      // something that no longer parses as a valid hashtag prefix.
      hashtagGenerationRef.current += 1;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hashtagResults is derived from the debounced hashtagQuery, not a separate data source; clearing it the instant there's no valid hashtag query (rather than only on the next debounce fire) is correct here, same reasoning as the mention/hashtag autocomplete effects in create/reel/index.tsx.
      setHashtagResults([]);
      return;
    }
    const generation = ++hashtagGenerationRef.current;
    hashtagDebounceRef.current = setTimeout(async () => {
      try {
        const matches = await searchHashtagsRanked(hashtagQuery, HASHTAG_SEARCH_FETCH_LIMIT);
        if (generation !== hashtagGenerationRef.current) return; // superseded by a newer keystroke
        setHashtagResults(matches);
      } catch {
        if (generation !== hashtagGenerationRef.current) return;
        // Fails closed and quietly — hashtag search is one part of this
        // screen; a failure here must never block or crash people search,
        // and must never show an intrusive full-screen error just for
        // this one section (per this feature's own spec).
        if (__DEV__) console.warn('Hashtag search failed for prefix', hashtagQuery);
        setHashtagResults([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      if (hashtagDebounceRef.current) clearTimeout(hashtagDebounceRef.current);
    };
  }, [hashtagQuery]);

  // A query the user explicitly started with "#" makes hashtag intent
  // unambiguous — the Hashtags section renders ABOVE people results in
  // that case (never hiding people results, just reordering which shows
  // first) instead of its normal spot below them.
  const hashtagIntentFirst = query.trim().startsWith('#');
  const hashtagSection =
    !isSelectMode && hashtagResults.length > 0 ? (
      <View>
        <Text style={styles.sectionLabel}>Hashtags</Text>
        <HashtagResultList hashtags={hashtagResults.slice(0, HASHTAG_SEARCH_DISPLAY_LIMIT)} />
      </View>
    ) : null;

  /** Select mode only — hands the picked profile back to whoever pushed this screen, then pops back to them. */
  const handleSelect = (profile: PublicProfile) => {
    setPendingSelectedMention(profile);
    router.back();
  };

  return (
    <HeaderScreenLayout title={isSelectMode ? 'Mention someone' : 'Search'}>
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

      {/* Trending Hashtags — empty-query state only, never alongside an
          active People/Hashtag search (Step 27's own placement guidance).
          Tapping a trend reuses the existing hashtag page (Step 2) — same
          route HashtagResultList below already navigates to. */}
      {query.length === 0 && !isSelectMode && trendingHashtags.length > 0 ? (
        <View>
          <Text style={styles.sectionLabel}>Trending in {activeScopeLabel}</Text>
          <TrendingHashtagList hashtags={trendingHashtags} />
        </View>
      ) : null}

      {hashtagIntentFirst ? hashtagSection : null}

      {status === 'idle' && isSelectMode && followingStatus === 'loading' ? (
        <LoadingState size="small" />
      ) : status === 'idle' && isSelectMode && followingProfiles.length > 0 ? (
        <View>
          <Text style={styles.sectionLabel}>Following</Text>
          <SelectableProfileList profiles={followingProfiles} onSelect={handleSelect} />
        </View>
      ) : status === 'idle' ? (
        <EmptyState
          bare
          icon="search-outline"
          title={isSelectMode ? 'Find someone to mention' : 'Find people on Around Me'}
          body="Search by username."
        />
      ) : status === 'loading' ? (
        <LoadingState size="small" />
      ) : status === 'error' ? (
        <ErrorState title="Couldn't load results" onRetry={handleRetry} />
      ) : results.length === 0 ? (
        <EmptyState bare icon="person-outline" title="No people found" />
      ) : isSelectMode ? (
        <SelectableProfileList profiles={results} onSelect={handleSelect} />
      ) : (
        <ProfileList profiles={results} />
      )}

      {hashtagIntentFirst ? null : hashtagSection}
    </HeaderScreenLayout>
  );
}

/**
 * Select-mode's own row list — visually the same Avatar/name/@username
 * row as ProfileList's own ProfileRow (src/components/UserList.tsx), but
 * each row is a plain Pressable calling `onSelect` instead of an
 * AuthorLink that navigates to the Public Profile — tapping a result
 * here is picking them, never a detour to their profile first.
 */
function SelectableProfileList({ profiles, onSelect }: { profiles: PublicProfile[]; onSelect: (profile: PublicProfile) => void }) {
  return (
    <View style={styles.list}>
      {profiles.map((profile, index) => (
        <Pressable
          key={profile.uid}
          onPress={() => onSelect(profile)}
          style={[styles.row, index === profiles.length - 1 && styles.rowLast]}
          accessibilityRole="button"
          accessibilityLabel={`Mention @${profile.username}`}
        >
          <Avatar name={profile.displayName} photoURL={profile.photoURL || undefined} size={52} />
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
  );
}

/**
 * Hashtag search results (Step 4) — reuses the exact same row shell
 * (`styles.list`/`row`/`rowLast`/`rowText`/`displayName`/`username`)
 * ProfileList/SelectableProfileList already use above, just with
 * "#name" + formatPostCount(postCount) as the two text lines instead of a
 * display name + @username — same borders, spacing, typography, and
 * press state as every other Search result row, no new visual pattern.
 * Tapping navigates straight to the existing hashtag discovery page
 * (Step 2) — never a second/duplicate hashtag details screen.
 */
function HashtagResultList({ hashtags }: { hashtags: Hashtag[] }) {
  return (
    <View style={styles.list}>
      {hashtags.map((hashtag, index) => (
        <Pressable
          key={hashtag.name}
          onPress={() => router.push(`/hashtag/${encodeURIComponent(hashtag.name)}`)}
          style={[styles.row, index === hashtags.length - 1 && styles.rowLast]}
          accessibilityRole="button"
          accessibilityLabel={`Hashtag ${hashtag.name}, ${formatPostCount(hashtag.postCount)}`}
        >
          <View style={styles.rowText}>
            <Text style={styles.displayName} numberOfLines={1}>
              #{hashtag.name}
            </Text>
            <Text style={styles.username}>{formatPostCount(hashtag.postCount)}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

/**
 * Trending Hashtags by City and Time Window — same row shell as
 * HashtagResultList above (no new visual pattern for this screen), but an
 * honest WINDOW-scoped count ("N posts today") instead of Step 2's
 * lifetime `postCount` (Step 29's own "do not label lifetime postCount as
 * if it represents the trend window" instruction) — the internal trend
 * SCORE itself is never shown (Step 30). Tapping reuses the exact same
 * `/hashtag/[hashtag]` route as every other hashtag tap in this app —
 * never a second hashtag details screen (Step 31).
 */
function TrendingHashtagList({ hashtags }: { hashtags: TrendingHashtag[] }) {
  return (
    <View style={styles.list}>
      {hashtags.map((trend, index) => (
        <Pressable
          key={trend.hashtag}
          onPress={() => router.push(`/hashtag/${encodeURIComponent(trend.hashtag)}`)}
          style={[styles.row, index === hashtags.length - 1 && styles.rowLast]}
          accessibilityRole="button"
          accessibilityLabel={`Hashtag ${trend.hashtag}, ${trend.recentPostCount} ${trend.recentPostCount === 1 ? 'post' : 'posts'} today`}
        >
          <View style={styles.rowText}>
            <Text style={styles.displayName} numberOfLines={1}>
              #{trend.hashtag}
            </Text>
            <Text style={styles.username}>
              {trend.recentPostCount} {trend.recentPostCount === 1 ? 'post' : 'posts'} today
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
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
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    marginTop: Spacing.lg,
    marginBottom: Spacing.xs,
  },
  // Select mode's own row list — same visual spec as ProfileList's own
  // (src/components/UserList.tsx), kept as a separate copy here rather
  // than exported/shared since the two lists' rows behave differently
  // (navigate vs. select) even though they look identical.
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
