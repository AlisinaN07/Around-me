import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { ReelFeed } from '@/components/ReelFeed';
import { Colors } from '@/constants/theme';
import { fetchProfileReels, fetchReel } from '@/services/reels';
import type { Reel } from '@/types/reel';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Single-Post detail route — reached from the Profile grid, share links,
 * and search. Renders through the exact same ReelFeed/ReelFeedItem the
 * Home feed uses, so a Post opened from anywhere looks and behaves
 * identically to Home: full-screen video, the same action rail (Like/
 * Comment/Save/Share/Options, the "+" follow badge), and the same
 * ReelCommentsSheet — never the separate compact "shrunk video + comments
 * listed below" layout this screen used before.
 *
 * Not just the one tapped Reel, either — the whole feed here is that
 * Reel's author's own Post list (fetchProfileReels, the same query the
 * Profile grid itself is built from), positioned to open exactly on the
 * one that was tapped, so swiping up/down moves through the rest of that
 * author's Posts — own profile or someone else's, same behavior either
 * way. Only the header differs (a plain back button here, vs. Home's
 * city/mode header), via ReelFeed's own topOverlay slot.
 */
export default function ReelDetailScreen() {
  const { reelId } = useLocalSearchParams<{ reelId: string }>();
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
      const profileReels = await fetchProfileReels(target.authorUid);
      const index = profileReels.findIndex((candidate) => candidate.reelId === reelId);
      if (index === -1) {
        // Defensive only — same author, same published status, so this
        // shouldn't normally happen (the tapped Reel just fell outside
        // fetchProfileReels' own bounded cap). Still show the Reel that
        // was actually tapped rather than silently landing somewhere else.
        setReels([target, ...profileReels]);
        setInitialIndex(0);
      } else {
        setReels(profileReels);
        setInitialIndex(index);
      }
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [reelId]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
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
