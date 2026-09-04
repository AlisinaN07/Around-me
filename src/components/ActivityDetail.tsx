import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { AuthorLink } from '@/components/AuthorLink';
import { Button } from '@/components/Button';
import { EngagementSection } from '@/components/EngagementSection';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchActivityParticipants, getActivityParticipation, joinActivity, leaveActivity } from '@/services/engagement';
import type { ActivityContent, ActivityParticipant } from '@/types/content';
import { formatEventTime } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Activity detail body (Step 29 visual reconstruction) — same shared
 * visual language and section order as EventDetail (date/time -> place
 * -> action -> description -> creator -> real engagement/comments), but
 * semantically distinct where it matters: the action is Join/Leave (not
 * Interested/Going), and there's a real participant count + list instead
 * of Event's Interested/Going counts — those are genuinely different
 * relationships (membership vs. RSVP), not just a visual choice, so they
 * are not collapsed into one shared component. Title/category/media are
 * rendered by the shared `DetailHero`, not here — see
 * content/[contentId].tsx.
 */
export function ActivityDetail({ content }: { content: ActivityContent }) {
  const { user } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [isJoined, setIsJoined] = useState(false);
  const [participantCount, setParticipantCount] = useState(0);
  const [participants, setParticipants] = useState<ActivityParticipant[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hasEnded, setHasEnded] = useState(false);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    try {
      const [participation, participantsList] = await Promise.all([
        getActivityParticipation(content.contentId, user?.uid ?? null),
        fetchActivityParticipants(content.contentId),
      ]);
      setIsJoined(participation.isJoined);
      setParticipantCount(participation.participantCount);
      setParticipants(participantsList);
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

  const isFull = content.maxParticipants !== undefined && participantCount >= content.maxParticipants && !isJoined;

  const handleJoin = async () => {
    if (!user || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    const result = await joinActivity(content.contentId, user.uid);
    setIsSubmitting(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    await load();
  };

  const handleLeave = async () => {
    if (!user || isSubmitting) return;
    setIsSubmitting(true);
    setActionError(null);
    const result = await leaveActivity(content.contentId, user.uid);
    setIsSubmitting(false);
    if (!result.ok) {
      setActionError(result.message);
      return;
    }
    await load();
  };

  return (
    <View style={styles.container}>
      <View style={styles.infoRow}>
        <Ionicons name="time-outline" size={16} color={Colors.textSecondary} />
        <Text style={styles.infoText}>
          {formatEventTime(content.startsAt.toDate())} – {content.endsAt.toDate().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>

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

      <View style={styles.countCard}>
        <Ionicons name="people" size={16} color={Colors.textSecondary} />
        <Text style={styles.countText}>
          {participantCount}
          {content.maxParticipants ? ` / ${content.maxParticipants}` : ''} joined
        </Text>
      </View>

      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

      {status === 'loading' ? (
        <Button label="Loading" onPress={() => {}} loading />
      ) : status === 'error' ? (
        <>
          <Text style={styles.errorText}>Couldn&apos;t load activity.</Text>
          <Button label="Try again" onPress={load} />
        </>
      ) : hasEnded ? (
        <Button label="Activity ended" onPress={() => {}} disabled />
      ) : isJoined ? (
        <Button label="Leave activity" onPress={handleLeave} loading={isSubmitting} variant="secondary" />
      ) : isFull ? (
        <Button label="Activity full" onPress={() => {}} disabled />
      ) : (
        <Button label="Join activity" onPress={handleJoin} loading={isSubmitting} />
      )}

      {status === 'loaded' ? (
        <View style={styles.participantsSection}>
          <Text style={styles.participantsTitle}>Participants</Text>
          {participants.length === 0 ? (
            <Text style={styles.emptyText}>No one has joined yet.</Text>
          ) : (
            <View style={styles.participantsList}>
              {participants.map((participant) => (
                <View key={participant.uid} style={styles.participantRow}>
                  <Avatar name={participant.displayName} size={36} />
                  <View style={styles.participantText}>
                    <Text style={styles.participantName} numberOfLines={1}>
                      {participant.displayName}
                    </Text>
                    <Text style={styles.participantUsername} numberOfLines={1}>
                      @{participant.username}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </View>
      ) : null}

      <Text style={styles.description}>{content.description}</Text>

      <AuthorLink uid={content.authorUid} style={styles.authorRow}>
        <Text style={styles.authorName}>{content.authorDisplayName}</Text>
        <Text style={styles.username}>@{content.authorUsername}</Text>
      </AuthorLink>

      <EngagementSection contentId={content.contentId} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.md,
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
  countCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
  },
  countText: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  participantsSection: {
    gap: Spacing.sm,
  },
  participantsTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  emptyText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  participantsList: {
    gap: Spacing.sm,
  },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  participantText: {
    flexShrink: 1,
  },
  participantName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  participantUsername: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
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
});
