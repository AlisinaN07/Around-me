import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ActivityDetail } from '@/components/ActivityDetail';
import { Button } from '@/components/Button';
import { EventDetail } from '@/components/EventDetail';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { PostDetail } from '@/components/PostDetail';
import { Colors, Spacing } from '@/constants/theme';
import { fetchContentById } from '@/services/content';
import type { Content } from '@/types/content';

type LoadStatus = 'loading' | 'loaded' | 'error';

export default function ContentDetailScreen() {
  const { contentId } = useLocalSearchParams<{ contentId: string }>();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [content, setContent] = useState<Content | null>(null);

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

  return (
    <HeaderScreenLayout title={title}>
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
});
