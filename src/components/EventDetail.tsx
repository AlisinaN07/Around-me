import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthorLink } from '@/components/AuthorLink';
import { EngagementSection } from '@/components/EngagementSection';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  fetchEventResponseCounts,
  fetchMyEventResponse,
  removeEventResponse,
  setEventResponse,
  type EventResponseCounts,
} from '@/services/engagement';
import type { EventContent, EventResponse, EventResponseStatus } from '@/types/content';
import { formatEventTime } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';

export function EventDetail({ content }: { content: EventContent }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [myResponse, setMyResponse] = useState<EventResponse | null>(null);
  const [counts, setCounts] = useState<EventResponseCounts>({ interestedCount: 0, goingCount: 0 });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hasEnded, setHasEnded] = useState(false);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    try {
      const [response, responseCounts] = await Promise.all([
        user ? fetchMyEventResponse(content.contentId, user.uid) : Promise.resolve(null),
        fetchEventResponseCounts(content.contentId),
      ]);
      setMyResponse(response);
      setCounts(responseCounts);
      setHasEnded(content.endsAt.toMillis() <= Date.now());
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [content, user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const category = INTERESTS.find((interest) => interest.id === content.categoryId);

  const handleTap = async (tapped: EventResponseStatus) => {
    if (!user || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    // Tapping the already-selected state removes the response.
    const result =
      myResponse?.status === tapped ? await removeEventResponse(content.contentId, user.uid) : await setEventResponse(content.contentId, user.uid, tapped);
    setIsSubmitting(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    await load();
  };

  return (
    <View style={styles.container}>
      {category && (
        <View style={styles.metaRow}>
          <View style={styles.categoryPill}>
            <Text style={styles.categoryText}>
              {category.emoji} {category.label}
            </Text>
          </View>
        </View>
      )}

      <Text style={styles.title}>{content.title}</Text>

      <AuthorLink uid={content.authorUid} style={styles.authorRow}>
        <Text style={styles.authorName}>{content.authorDisplayName}</Text>
        <Text style={styles.username}>@{content.authorUsername}</Text>
      </AuthorLink>

      <Text style={styles.description}>{content.description}</Text>

      {content.placeId ? (
        <Pressable
          onPress={() => router.push(`/place/${content.placeId}`)}
          style={styles.infoRow}
          accessibilityRole="button"
          accessibilityLabel={`View ${content.placeName}`}
        >
          <Ionicons name="location" size={16} color={Colors.accent} />
          <Text style={styles.placeLinkText}>{content.placeName}</Text>
        </Pressable>
      ) : (
        <View style={styles.infoRow}>
          <Ionicons name="location-outline" size={16} color={Colors.textSecondary} />
          <Text style={styles.infoText}>{content.placeName}</Text>
        </View>
      )}
      <View style={styles.infoRow}>
        <Ionicons name="time-outline" size={16} color={Colors.textSecondary} />
        <Text style={styles.infoText}>
          {formatEventTime(content.startsAt.toDate())} – {content.endsAt.toDate().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>

      {hasEnded ? <Text style={styles.endedText}>This event has ended.</Text> : null}

      {status === 'error' ? (
        <>
          <Text style={styles.errorText}>Couldn&apos;t load response counts.</Text>
          <Pressable onPress={load} accessibilityRole="button">
            <Text style={styles.retryLink}>Try again</Text>
          </Pressable>
        </>
      ) : (
        <>
          {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

          <View style={styles.responseRow}>
            <ResponseButton
              label="Interested"
              count={counts.interestedCount}
              selected={myResponse?.status === 'interested'}
              disabled={hasEnded || status === 'loading' || isSubmitting}
              onPress={() => handleTap('interested')}
            />
            <ResponseButton
              label="Going"
              count={counts.goingCount}
              selected={myResponse?.status === 'going'}
              disabled={hasEnded || status === 'loading' || isSubmitting}
              onPress={() => handleTap('going')}
            />
          </View>
        </>
      )}

      <EngagementSection contentId={content.contentId} />
    </View>
  );
}

type ResponseButtonProps = {
  label: string;
  count: number;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
};

function ResponseButton({ label, count, selected, disabled, onPress }: ResponseButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.responseButton, selected && styles.responseButtonSelected, disabled && styles.responseButtonDisabled]}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
    >
      <Text style={[styles.responseLabel, selected && styles.responseLabelSelected]}>{label}</Text>
      <Text style={[styles.responseCount, selected && styles.responseLabelSelected]}>{count}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.sm,
  },
  metaRow: {
    flexDirection: 'row',
  },
  categoryPill: {
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 4,
  },
  categoryText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  title: {
    color: Colors.text,
    fontSize: 24,
    fontWeight: '800',
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  authorName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    marginTop: Spacing.xs,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
  },
  infoText: {
    color: Colors.text,
    fontSize: 14,
  },
  placeLinkText: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: '600',
  },
  endedText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontStyle: 'italic',
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  retryLink: {
    color: Colors.accent,
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
  },
  responseRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xs,
  },
  responseButton: {
    flex: 1,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    gap: 2,
  },
  responseButtonSelected: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accent,
  },
  responseButtonDisabled: {
    opacity: 0.5,
  },
  responseLabel: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  responseLabelSelected: {
    color: Colors.background,
  },
  responseCount: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
});
