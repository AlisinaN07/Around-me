import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';

import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { ProfileTabBar } from '@/components/ProfileTabBar';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { Spacing } from '@/constants/theme';
import { getHashtag, normalizeHashtag } from '@/services/hashtags';
import { getRecentPostsForHashtag, getTopPostsForHashtag, setReelFeedHandoff } from '@/services/reels';
import type { Hashtag } from '@/types/hashtag';
import type { Reel } from '@/types/reel';
import { formatPostCount } from '@/utils/postCount';

type LoadStatus = 'loading' | 'loaded' | 'error';
type HashtagTab = 'top' | 'recent';

const TABS: { id: HashtagTab; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'recent', label: 'Recent' },
];

// Suggested 12-20 range from the spec — matches HASHTAG_PAGE_SIZE in
// src/services/reels.ts (kept as its own local constant rather than a
// shared export: this screen doesn't need to agree on an exact number
// with reels.ts, just stay in the same ballpark it already defaults to).
const PAGE_SIZE = 15;

/**
 * Real hashtag discovery page (replaces the Step 1 placeholder) — reached
 * by tapping any "#hashtag" span in a Reel caption (HighlightedText) or a
 * deep link. Header shows the hashtag + its post count
 * (hashtags/{hashtag}.postCount, defaulting to 0 when the doc doesn't
 * exist yet — a hashtag with zero posts is a normal, non-error state, not
 * a crash), then Top/Recent tabs (ProfileTabBar, the same underline tab
 * bar Profile's own content tabs use) over a post grid (ReelPreviewCard,
 * the same tile Profile's Posts grid uses) — deliberately no bespoke post
 * card or tab component for this one screen.
 *
 * The route param is always re-normalized here via the Step 1
 * normalizeHashtag utility (never a second copy of that logic) so
 * `/hashtag/Football`, `/hashtag/FOOTBALL` and `/hashtag/football` all
 * resolve to the same canonical `football` — both for display and for the
 * Firestore reads below.
 *
 * Recent and Top both come from src/services/reels.ts
 * (getRecentPostsForHashtag/getTopPostsForHashtag) — see those functions'
 * own doc comments for why they live there instead of hashtags.ts, how
 * Recent is cursor-paginated, and how Top ranks a single bounded candidate
 * pool with the existing scoreContentQuality helper rather than a new
 * ranking formula. Both tabs' first page loads together with the hashtag
 * doc up front (three bounded reads, once per visit) so switching tabs
 * back and forth never re-fetches anything; only Recent's own "Load more"
 * (a real Firestore page) and Top's "Load more" (revealing more of the
 * already-fetched ranked pool, zero extra reads) touch the network again.
 */
export default function HashtagScreen() {
  const { hashtag: rawParam } = useLocalSearchParams<{ hashtag: string }>();

  const rawDecoded = useMemo(() => {
    try {
      return decodeURIComponent(rawParam ?? '');
    } catch {
      return rawParam ?? '';
    }
  }, [rawParam]);
  // Empty when the param can't be normalized into a real hashtag at all
  // (e.g. a malformed deep link) — every read below is guarded against
  // this, and the page still renders (an empty/zero-post state), never
  // crashes.
  const normalized = useMemo(() => normalizeHashtag(rawDecoded) ?? '', [rawDecoded]);
  const displayName = normalized || rawDecoded.replace(/^#+/, '').trim() || 'hashtag';

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [tab, setTab] = useState<HashtagTab>('top');
  const [hashtagDoc, setHashtagDoc] = useState<Hashtag | null>(null);

  const [topPosts, setTopPosts] = useState<Reel[]>([]);
  const [topVisibleCount, setTopVisibleCount] = useState(PAGE_SIZE);

  const [recentPosts, setRecentPosts] = useState<Reel[]>([]);
  const [recentCursor, setRecentCursor] = useState<QueryDocumentSnapshot<DocumentData> | undefined>(undefined);
  const [loadingMoreRecent, setLoadingMoreRecent] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    if (!normalized) {
      setHashtagDoc(null);
      setTopPosts([]);
      setTopVisibleCount(PAGE_SIZE);
      setRecentPosts([]);
      setRecentCursor(undefined);
      setStatus('loaded');
      return;
    }
    try {
      const [doc, top, recentPage] = await Promise.all([
        getHashtag(normalized),
        getTopPostsForHashtag(normalized),
        getRecentPostsForHashtag(normalized, { limitCount: PAGE_SIZE }),
      ]);
      setHashtagDoc(doc);
      setTopPosts(top);
      setTopVisibleCount(PAGE_SIZE);
      setRecentPosts(recentPage.items);
      setRecentCursor(recentPage.cursor);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [normalized]);

  useEffect(() => {
    // load() sets status synchronously before its own first await, same
    // reasoning as every other one-shot-load screen in this app (see e.g.
    // events/section.tsx's own identical disable comment).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const canLoadMoreTop = topVisibleCount < topPosts.length;
  const canLoadMoreRecent = recentCursor !== undefined;
  const canLoadMore = tab === 'top' ? canLoadMoreTop : canLoadMoreRecent;

  const handleLoadMore = useCallback(async () => {
    if (tab === 'top') {
      setTopVisibleCount((count) => Math.min(count + PAGE_SIZE, topPosts.length));
      return;
    }
    if (!recentCursor || loadingMoreRecent) return;
    setLoadingMoreRecent(true);
    try {
      const page = await getRecentPostsForHashtag(normalized, { cursor: recentCursor });
      setRecentPosts((prev) => [...prev, ...page.items]);
      setRecentCursor(page.cursor);
    } catch {
      // Best-effort — the button stays visible (recentCursor is untouched)
      // so the user can just tap it again, same as ErrorState's own retry.
    } finally {
      setLoadingMoreRecent(false);
    }
  }, [tab, topPosts.length, recentCursor, loadingMoreRecent, normalized]);

  const displayedPosts = tab === 'top' ? topPosts.slice(0, topVisibleCount) : recentPosts;

  // Hands the exact list currently on screen to the Reel detail route (see
  // setReelFeedHandoff's own doc comment) so tapping post B there opens
  // the real feed viewer already positioned on B, swiping through the
  // SAME order shown here — never a duplicate post viewer.
  const openPost = (reel: Reel) => {
    setReelFeedHandoff(displayedPosts);
    router.push(`/reel/${reel.reelId}`);
  };

  return (
    <HeaderScreenLayout
      title={`#${displayName}`}
      subtitle={formatPostCount(hashtagDoc?.postCount ?? 0)}
      stickyBelowHeader={status === 'loaded' ? <ProfileTabBar tabs={TABS} value={tab} onChange={setTab} /> : undefined}
    >
      {status === 'error' ? (
        <ErrorState title="Couldn't load this hashtag." onRetry={load} />
      ) : status === 'loading' ? (
        <LoadingState size="large" />
      ) : displayedPosts.length === 0 ? (
        <EmptyState icon="pricetag-outline" title="No posts yet" body={`Be the first to post something with #${displayName}`} />
      ) : (
        <>
          <View style={styles.postsGrid}>
            {displayedPosts.map((reel) => (
              <ReelPreviewCard key={reel.reelId} reel={reel} onPress={() => openPost(reel)} />
            ))}
          </View>
          {canLoadMore ? (
            <Button label="Load more" variant="secondary" loading={tab === 'recent' && loadingMoreRecent} onPress={handleLoadMore} />
          ) : null}
        </>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  // Same flex-start + explicit gap grid Profile's own Posts tab uses (see
  // that screen's own postsGrid comment for why not `space-between`).
  postsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-start',
    columnGap: Spacing.sm,
    rowGap: Spacing.sm,
  },
});
