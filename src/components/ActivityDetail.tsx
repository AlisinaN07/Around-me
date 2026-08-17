import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { EngagementSection } from '@/components/EngagementSection';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchActivityParticipants, getActivityParticipation, joinActivity, leaveActivity } from '@/services/engagement';
import type { ActivityContent, ActivityParticipant } from '@/types/content';
import { formatEventTime } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';

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
  const category = INTERESTS.find((interest) => interest.id === content.categoryId);

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
      <View style={styles.metaRow}>
        {category && (
          <View style={styles.categoryPill}>
            <Text style={styles.categoryText}>
              {category.emoji} {category.label}
            </Text>
          </View>
        )}
      </View>

      <Text style={styles.title}>{content.title}</Text>

      <View style={styles.authorRow}>
        <Text style={styles.authorName}>{content.authorDisplayName}</Text>
        <Text style={styles.username}>@{content.authorUsername}</Text>
      </View>

      <Text style={styles.description}>{content.description}</Text>

      <View style={styles.infoRow}>
        <Ionicons name="location-outline" size={16} color={Colors.textSecondary} />
        <Text style={styles.infoText}>{content.placeName}</Text>
      </View>
      <View style={styles.infoRow}>
        <Ionicons name="time-outline" size={16} color={Colors.textSecondary} />
        <Text style={styles.infoText}>
          {formatEventTime(content.startsAt.toDate())} – {content.endsAt.toDate().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>

      <View style={styles.countCard}>
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

      <View style={styles.participantsSection}>
        <Text style={styles.participantsTitle}>Participants</Text>
        {status !== 'loaded' ? null : participants.length === 0 ? (
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

      <EngagementSection contentId={content.contentId} />
    </View>
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
  countCard: {
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    alignItems: 'center',
    marginTop: Spacing.xs,
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
    marginTop: Spacing.lg,
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
});
