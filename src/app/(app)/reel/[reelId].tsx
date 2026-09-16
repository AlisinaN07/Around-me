import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { ReelFeed } from '@/components/ReelFeed';
import { Colors } from '@/constants/theme';
import { fetchProfileReels, fetchReel, fetchReelsByMusicHash } from '@/services/reels';
import type { Reel } from '@/types/reel';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Single-Post detail route — reached from the Profile grid, share links,
 * search, and SoundSheet's own grid. Renders through the exact same
 * ReelFeed/ReelFeedItem the Home feed uses, so a Post opened from anywhere
 * looks and behaves identically to Home: full-screen video, the same
 * action rail (Like/Comment/Save/Share/Options, the "+" follow badge), and
 * the same ReelCommentsSheet — never the separate compact "shrunk video +
 * comments listed below" layout this screen used before.
 *
 * Not just the one tapped Reel, either — swiping up/down moves through a
 * whole list the tapped Reel belongs to, positioned to open exactly on
 * it. Which list depends on how this screen was reached:
 *  - Normally (Profile grid, share links, search): that Reel's author's
 *    own Post list (fetchProfileReels, the same query the Profile grid
 *    itself is built from) — swiping moves through the rest of that
 *    author's Posts.
 *  - From SoundSheet's grid (`musicHash` present in the URL): every
 *    currently-published Reel sharing that exact sound
 *    (fetchReelsByMusicHash, the same query SoundSheet's own grid is
 *    built from) — swiping moves through the OTHER posts using this
 *    sound, never that author's unrelated posts. With only one post using
 *    a sound (SoundSheet showed a single tile), that list has exactly one
 *    entry, so swiping here correctly shows nothing more — not the
 *    author's other, unrelated Posts.
 * Only the header differs (a plain back button here, vs. Home's city/mode
 * header), via ReelFeed's own topOverlay slot.
 */
export default function ReelDetailScreen() {
  const { reelId, musicHash } = useLocalSearchParams<{ reelId: string; musicHash?: string }>();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [reels, setReels] = useState<Reel[]>([]);
  const [initialIndex, setInitialIndex] = useState(0);

  const load = useCallback(async () => {
    setStatus('loading');
    setReels([]);
    try {
      const target = await fetchReel(reelId);
      if (!target || target.status !== 'published') {
        setStatus('error');
        return;
      }
      const siblingReels = musicHash ? await fetchReelsByMusicHash(musicHash) : await fetchProfileReels(target.authorUid);
      const index = siblingReels.findIndex((candidate) => candidate.reelId === reelId);
      if (index === -1) {
        // Defensive only — same sound/author, same published status, so
        // this shouldn't normally happen (the tapped Reel just fell
        // outside the sibling query's own bounded cap). Still show the
        // Reel that was actually tapped rather than silently landing
        // somewhere else.
        setReels([target, ...siblingReels]);
        setInitialIndex(0);
      } else {
        setReels(siblingReels);
        setInitialIndex(index);
      }
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [reelId, musicHash]);

  // Stale-while-revalidate — same key-comparison pattern already proven on
  // Home/Events/Profile (see their own doc comments). `reelId`/`musicHash`
  // are the whole of what `load` depends on (fetchReel/fetchProfileReels/
  // fetchReelsByMusicHash are all viewer-independent public reads — no
  // uid/scope dimension exists here the way it does on Home/Events), so
  // the key is just the two of them together. A refocus with an unchanged
  // key (the ordinary "swiped into this Reel, tapped the author, came
  // back" case) is a no-op: `reels` and `initialIndex` are left exactly as
  // they are, so ReelFeed's own scroll position survives untouched.
  // Deliberately a skip, not a live silent revalidate — ReelFeed resets its
  // internal activeIndex to 0 on ANY `reels` array-reference change (see
  // its own effect), so replacing `reels` here even with identical data
  // would still snap playback back to this list's first item; skipping
  // the fetch entirely avoids that regardless. A genuine key change (a
  // different reelId/musicHash) still triggers `load()` for real.
  const loadedKeyRef = useRef<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      const key = `${reelId}:${musicHash ?? ''}`;
      if (loadedKeyRef.current === key) return;
      loadedKeyRef.current = key;
      load();
    }, [reelId, musicHash, load])
  );

  // Deleting a Post here removes it from the still-visible list (same
  // author, so their other Posts stay swipeable) — only when NOTHING is
  // left does this navigate away (same back-else-Profile fallback the old
  // single-Reel detail screen used).
  const handleReelDeleted = (deletedReelId: string) => {
    const remaining = reels.filter((candidate) => candidate.reelId !== deletedReelId);
    if (remaining.length === 0) {
      if (router.canGoBack()) {
        router.back();
      } else {
        router.replace('/profile');
      }
      return;
    }
    setReels(remaining);
  };

  return (
    <ReelFeed
      reels={reels}
      status={status}
      errorTitle="Couldn't load this post."
      onReload={load}
      onReelDeleted={handleReelDeleted}
      initialIndex={initialIndex}
      onSwipeBack={() => router.back()}
      topOverlay={
        <View style={styles.backRow}>
          <Pressable onPress={() => router.back()} hitSlop={8} style={styles.backButton} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={22} color={Colors.text} />
          </Pressable>
        </View>
      }
      emptyState={<EmptyState bare icon="alert-circle-outline" title="This post is no longer available." />}
    />
  );
}

const styles = StyleSheet.create({
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
