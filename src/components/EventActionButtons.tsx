import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { joinActivity, leaveActivity, setEventResponse } from '@/services/engagement';
import type { ActivityContent, EventContent, EventResponseStatus } from '@/types/content';

type EventActionButtonsProps = {
  item: ActivityContent | EventContent;
  /** 'row' for wide hero/upcoming cards, 'column' for narrow Today rows where two Event buttons must stack. */
  direction?: 'row' | 'column';
  /** Smaller pill sizing for compact rows. */
  compact?: boolean;
};

/**
 * Real Interested/Going (Event) or Join/Joined (Activity) actions, usable
 * directly from a discovery card (Step 26 Section 12/13) — calls the exact
 * same src/services/engagement.ts functions the detail screen uses, never
 * a duplicate write path.
 *
 * Deliberately does NOT fetch the viewer's existing response/participation
 * on mount: reading that per-card, for every card in a bounded-but-still
 * multi-item discovery screen, is exactly the N+1 read pattern Section 34
 * forbids ("no per-card count queries"). Instead the "selected" look is
 * session-local optimism — it reflects what you just tapped here, not
 * necessarily prior state from a previous visit. The real, authoritative
 * selected/joined state and real counts still live on the detail screen
 * (EventDetail/ActivityDetail), which already fetches them once per visit,
 * not once per card.
 *
 * Step 26.1 investigated replacing this with a real batched read — one
 * `collectionGroup('responses'|'participants').where('uid','==', viewer)`
 * query per screen visit covering every displayed card at once, using the
 * `uid` field each of those subcollection documents already carries.
 * Empirically confirmed against production (see README "Event card
 * interaction state" section) that collectionGroup query requests are
 * denied outright in this Firebase project regardless of rule content —
 * reproduced even with a trivial, get()-free rule on an unrelated
 * top-level collection, so it isn't specific to these two subcollections
 * or their get()-based ownership checks. No rules or index change makes
 * this viable without a schema change (denormalizing membership onto
 * `content/{contentId}` itself), which Step 26.1 was explicitly told not
 * to do. The buttons below stay outlined/unfilled — never a confident
 * "not selected"/"not joined" claim, just an actionable default — until
 * the viewer taps one this session, exactly the "state-neutral" fallback
 * the Step 26.1 spec sanctioned for this scenario.
 */
export function EventActionButtons({ item, direction = 'row', compact = false }: EventActionButtonsProps) {
  const { user } = useAuth();
  const isActivity = item.type === 'activity';

  const [eventStatus, setLocalEventStatus] = useState<EventResponseStatus | null>(null);
  const [isJoined, setIsJoined] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const flashError = (message: string) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setErrorMessage(message);
    errorTimerRef.current = setTimeout(() => setErrorMessage(null), 2500);
  };

  const handleEventTap = async (status: EventResponseStatus) => {
    if (!user || isSubmitting) return;
    setIsSubmitting(true);
    const result = await setEventResponse(item.contentId, user.uid, status);
    setIsSubmitting(false);
    if (!result.ok) {
      flashError(result.message);
      return;
    }
    setLocalEventStatus(status);
  };

  const handleActivityTap = async () => {
    if (!user || isSubmitting) return;
    setIsSubmitting(true);
    const result = isJoined ? await leaveActivity(item.contentId, user.uid) : await joinActivity(item.contentId, user.uid);
    setIsSubmitting(false);
    if (!result.ok) {
      flashError(result.message);
      return;
    }
    setIsJoined(!isJoined);
  };

  const stopPropagation = (event: { stopPropagation: () => void }) => event.stopPropagation();

  if (isActivity) {
    return (
      <View style={styles.wrapper}>
        <Pressable
          onPress={(event) => {
            stopPropagation(event);
            handleActivityTap();
          }}
          disabled={isSubmitting}
          style={[styles.pill, compact && styles.pillCompact, isJoined && styles.pillSolid, isSubmitting && styles.pillDisabled]}
          accessibilityRole="button"
          accessibilityState={{ selected: isJoined, disabled: isSubmitting }}
          accessibilityLabel={isJoined ? 'Joined' : 'Join'}
        >
          <Ionicons name={isJoined ? 'people' : 'people-outline'} size={compact ? 12 : 14} color={isJoined ? Colors.background : Colors.accent} />
          <Text style={[styles.pillLabel, compact && styles.pillLabelCompact, isJoined && styles.pillLabelSolid]}>{isJoined ? 'Joined' : 'Join'}</Text>
        </Pressable>
        {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.wrapper}>
      <View style={[styles.row, direction === 'column' && styles.column]}>
        <Pressable
          onPress={(event) => {
            stopPropagation(event);
            handleEventTap('interested');
          }}
          disabled={isSubmitting}
          style={[styles.pill, compact && styles.pillCompact, eventStatus === 'interested' && styles.pillSolid, isSubmitting && styles.pillDisabled]}
          accessibilityRole="button"
          accessibilityState={{ selected: eventStatus === 'interested', disabled: isSubmitting }}
          accessibilityLabel="Interested"
        >
          <Ionicons
            name={eventStatus === 'interested' ? 'star' : 'star-outline'}
            size={compact ? 12 : 14}
            color={eventStatus === 'interested' ? Colors.background : Colors.accent}
          />
          <Text style={[styles.pillLabel, compact && styles.pillLabelCompact, eventStatus === 'interested' && styles.pillLabelSolid]}>Interested</Text>
        </Pressable>
        <Pressable
          onPress={(event) => {
            stopPropagation(event);
            handleEventTap('going');
          }}
          disabled={isSubmitting}
          style={[styles.pill, compact && styles.pillCompact, eventStatus === 'going' && styles.pillSolid, isSubmitting && styles.pillDisabled]}
          accessibilityRole="button"
          accessibilityState={{ selected: eventStatus === 'going', disabled: isSubmitting }}
          accessibilityLabel="Going"
        >
          <Ionicons
            name={eventStatus === 'going' ? 'checkmark-circle' : 'checkmark-circle-outline'}
            size={compact ? 12 : 14}
            color={eventStatus === 'going' ? Colors.background : Colors.accent}
          />
          <Text style={[styles.pillLabel, compact && styles.pillLabelCompact, eventStatus === 'going' && styles.pillLabelSolid]}>Going</Text>
        </Pressable>
      </View>
      {errorMessage ? <Text style={styles.errorText}>{errorMessage}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  column: {
    flexDirection: 'column',
    alignItems: 'flex-end',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 6,
  },
  pillCompact: {
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  pillSolid: {
    backgroundColor: Colors.accent,
  },
  pillDisabled: {
    opacity: 0.5,
  },
  pillLabel: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  pillLabelCompact: {
    fontSize: 10,
  },
  pillLabelSolid: {
    color: Colors.background,
  },
  errorText: {
    color: Colors.error,
    fontSize: 10,
    fontWeight: '600',
  },
});
