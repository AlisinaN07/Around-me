import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ActivityDetail } from '@/components/ActivityDetail';
import { Button } from '@/components/Button';
import { EventDetail } from '@/components/EventDetail';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { OptionsMenu } from '@/components/OptionsMenu';
import { PostDetail } from '@/components/PostDetail';
import { ReportModal } from '@/components/ReportModal';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchContentById } from '@/services/content';
import type { Content } from '@/types/content';

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

  const title = content?.type === 'activity' ? 'Activity' : content?.type === 'event' ? 'Event' : 'Post';
  const isOwnContent = !!user && !!content && content.authorUid === user.uid;

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
        <View style={styles.centered}>
          <Text style={styles.loadingText}>Loading…</Text>
        </View>
      ) : status === 'error' || !content ? (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.errorTitle}>
            {title === 'Event' ? "Couldn't load event." : title === 'Activity' ? "Couldn't load activity." : "Couldn't load post."}
          </Text>
          <Button label="Try again" onPress={load} />
        </View>
      ) : content.type === 'activity' ? (
        <ActivityDetail content={content} />
      ) : content.type === 'event' ? (
        <EventDetail content={content} />
      ) : (
        <PostDetail content={content} />
      )}

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

const styles = StyleSheet.create({
  centered: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.xxl,
  },
  loadingText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  errorTitle: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    textAlign: 'center',
  },
  overflowButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
