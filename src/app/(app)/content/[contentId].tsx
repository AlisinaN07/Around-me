import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ActivityDetail } from '@/components/ActivityDetail';
import { DetailHero } from '@/components/DetailHero';
import { ErrorState } from '@/components/ErrorState';
import { EventDetail } from '@/components/EventDetail';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState, SkeletonBlock } from '@/components/LoadingState';
import { OptionsMenu } from '@/components/OptionsMenu';
import { PostDetail } from '@/components/PostDetail';
import { ReportModal } from '@/components/ReportModal';
import { Colors, Layout, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchContentById } from '@/services/content';
import type { ActivityContent, Content, EventContent } from '@/types/content';

type LoadStatus = 'loading' | 'loaded' | 'error';

export default function ContentDetailScreen() {
  const { contentId } = useLocalSearchParams<{ contentId: string }>();
  const { user } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [content, setContent] = useState<Content | null>(null);
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
  const [isReportOpen, setIsReportOpen] = useState(false);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    try {
      const result = await fetchContentById(contentId);
      if (!result) {
        setStatus('error');
        return;
      }
      setContent(result);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [contentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const isOwnContent = !!user && !!content && content.authorUid === user.uid;

  // Event/Activity get the Step 29 media-first hero chrome — Back/More
  // are overlaid directly on the hero, not shown in a separate header bar
  // above it, so this branch owns its own SafeAreaView/ScrollView instead
  // of HeaderScreenLayout. Post detail (Step 29 Section 28: not redesigned
  // this step) and the loading/error states — where the content type
  // isn't known yet — keep the original HeaderScreenLayout path, below,
  // completely unchanged in structure.
  if (status === 'loaded' && content && content.type !== 'post') {
    return (
      <>
        <MediaDetailScreen
          content={content}
          isOwnContent={isOwnContent}
          onOptionsPress={() => setIsOptionsMenuOpen(true)}
        />
        <OptionsMenu
          visible={isOptionsMenuOpen}
          onClose={() => setIsOptionsMenuOpen(false)}
          options={[{ label: 'Report', onPress: () => setIsReportOpen(true) }]}
        />
        {user ? (
          <ReportModal
            visible={isReportOpen}
            onClose={() => setIsReportOpen(false)}
            reporterUid={user.uid}
            target={{ type: 'content', contentId: content.contentId }}
          />
        ) : null}
      </>
    );
  }

  const title = content?.type === 'activity' ? 'Activity' : content?.type === 'event' ? 'Event' : 'Post';

  return (
    <HeaderScreenLayout
      title={title}
      headerRight={
        status === 'loaded' && content && !isOwnContent ? (
          <Pressable
            onPress={() => setIsOptionsMenuOpen(true)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="More options"
            style={styles.overflowButton}
          >
            <Ionicons name="ellipsis-horizontal" size={20} color={Colors.textSecondary} />
          </Pressable>
        ) : undefined
      }
    >
      {status === 'loading' ? (
        <View style={styles.loadingShape}>
          <SkeletonBlock width="100%" height={200} />
          <View style={styles.loadingLines}>
            <SkeletonBlock width="70%" height={20} />
            <SkeletonBlock width="45%" height={14} />
          </View>
          <LoadingState />
        </View>
      ) : status === 'error' || !content ? (
        <ErrorState
          title={title === 'Event' ? "Couldn't load event." : title === 'Activity' ? "Couldn't load activity." : "Couldn't load post."}
          onRetry={load}
        />
      ) : content.type === 'post' ? (
        <PostDetail content={content} />
      ) : null}

      <OptionsMenu
        visible={isOptionsMenuOpen}
        onClose={() => setIsOptionsMenuOpen(false)}
        options={[{ label: 'Report', onPress: () => setIsReportOpen(true) }]}
      />

      {user && content ? (
        <ReportModal
          visible={isReportOpen}
          onClose={() => setIsReportOpen(false)}
          reporterUid={user.uid}
          target={{ type: 'content', contentId: content.contentId }}
        />
      ) : null}
    </HeaderScreenLayout>
  );
}

type MediaDetailScreenProps = {
  content: EventContent | ActivityContent;
  isOwnContent: boolean;
  onOptionsPress: () => void;
};

/** Full-bleed hero + body for Event/Activity detail (Step 29) — see the branch above for why this bypasses HeaderScreenLayout. */
function MediaDetailScreen({ content, isOwnContent, onOptionsPress }: MediaDetailScreenProps) {
  return (
    <SafeAreaView style={styles.mediaSafeArea} edges={['top']}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.mediaScrollContent}>
        <View style={styles.mediaPage}>
          <DetailHero
            title={content.title}
            categoryId={content.categoryId}
            startsAt={content.startsAt}
            endsAt={content.endsAt}
            onOptionsPress={isOwnContent ? undefined : onOptionsPress}
          />
          <View style={styles.mediaBody}>
            {content.type === 'activity' ? <ActivityDetail content={content} /> : <EventDetail content={content} />}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loadingShape: {
    alignItems: 'center',
    gap: Spacing.md,
    paddingTop: Spacing.sm,
  },
  loadingLines: {
    width: '100%',
    gap: Spacing.sm,
  },
  mediaSafeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  mediaScrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  mediaPage: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  mediaBody: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  overflowButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
