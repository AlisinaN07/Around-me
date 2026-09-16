import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { AuthorLink } from '@/components/AuthorLink';
import { ProfileTabBar } from '@/components/ProfileTabBar';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  fetchEventResponseCounts,
  fetchMyEventResponse,
  removeEventResponse,
  setEventResponse,
  type EventResponseCounts,
} from '@/services/engagement';
import { followUser, isFollowing, unfollowUser } from '@/services/following';
import { fetchPublicProfile } from '@/services/publicProfile';
import { trackContentInteraction } from '@/services/recommendations/interactions';
import type { EventContent, EventResponse, EventResponseStatus } from '@/types/content';
import { buildContentShareUrl, shareContent } from '@/utils/contentShare';
import { prefetchImageOnce } from '@/utils/imagePrefetch';
import { formatEventTime } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';

type EventDetailTab = 'about' | 'participants';
const EVENT_DETAIL_TABS: { id: EventDetailTab; label: string }[] = [
  { id: 'about', label: 'About' },
  { id: 'participants', label: 'Participants' },
];

/**
 * Event detail body (Step 29 visual reconstruction) — rendered below the
 * shared `DetailHero` (title/category/media are shown there, not here —
 * see content/[contentId].tsx). Section order: date/time -> place ->
 * About/Participants tabs -> creator -> Interested/Going (deliberately
 * last). Participants shows only the real Interested/Going COUNTS
 * (already fetched for the response buttons below — no second read) —
 * not a per-person list, which isn't stored anywhere queryable as a flat
 * list today (see content/{eventId}/responses/{uid} in
 * src/types/content.ts) and wasn't asked for.
 *
 * Deliberately no `EngagementSection` (Like/Comments) here — unlike
 * Post/Activity, Events don't need a Like count (Interested/Going above
 * already IS this content's real engagement signal), and Comments were
 * explicitly asked to come back later at a different spot in this screen,
 * not reinstated here in the meantime.
 *
 * A future "Tagged Reels" section (real Reels tagged at this Event's
 * Place) is an approved but unbuilt product concept — see README
 * "Tagged at {Place}" for the full rationale. No code for it exists here;
 * that's intentional until a Reel can actually carry a placeId.
 */
type EventDetailProps = {
  content: EventContent;
  /** Brief transient confirmation for the Share button's clipboard fallback (see handleShare below) — rendered by the parent screen, not here, same shared-toast pattern content/[contentId].tsx already uses for Save/Repost. */
  onToast: (message: string) => void;
};

export function EventDetail({ content, onToast }: EventDetailProps) {
  const { user } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [myResponse, setMyResponse] = useState<EventResponse | null>(null);
  const [counts, setCounts] = useState<EventResponseCounts>({ interestedCount: 0, goingCount: 0 });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [hasEnded, setHasEnded] = useState(false);
  const [detailTab, setDetailTab] = useState<EventDetailTab>('about');
  // The author's CURRENT profile photo — deliberately not a denormalized
  // field on EventContent (there isn't one): a photo added after this
  // Event was published should still show up here, same "read the live
  // publicProfiles/{uid} instead of a frozen snapshot" reasoning
  // ReelFeedItem's own authorPhotoURL uses.
  const [authorPhotoURL, setAuthorPhotoURL] = useState('');
  const isOwnEvent = !!user && user.uid === content.authorUid;
  // null = not yet checked — renders nothing, same "never show a wrong
  // guess" rule ReelFeedItem's own isFollowingAuthor uses, rather than
  // flashing "Follow" for a heartbeat before a real "Following" loads in.
  const [amFollowing, setAmFollowing] = useState<boolean | null>(null);
  const [isFollowSubmitting, setIsFollowSubmitting] = useState(false);

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

  useEffect(() => {
    let cancelled = false;
    fetchPublicProfile(content.authorUid).then((authorProfile) => {
      if (cancelled) return;
      setAuthorPhotoURL(authorProfile?.photoURL ?? '');
      // Phase 3 perf pass — reuses the Phase 2 public-profile cache
      // above (no extra Firestore read just for this).
      prefetchImageOnce(authorProfile?.photoURL);
    });
    return () => {
      cancelled = true;
    };
  }, [content.authorUid]);

  // Own event -> never shown at all (nothing to follow). Signed-out ->
  // also nothing shown, same reasoning: there's no viewer account to hold
  // a follow relationship. Otherwise reflects the CURRENT real follow
  // state — same "reflect current state" pattern ReelFeedItem's own
  // isFollowingAuthor effect uses.
  useEffect(() => {
    let cancelled = false;
    if (isOwnEvent || !user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAmFollowing(null);
      return;
    }
    isFollowing(user.uid, content.authorUid).then((following) => {
      if (!cancelled) setAmFollowing(following);
    });
    return () => {
      cancelled = true;
    };
  }, [content.authorUid, user, isOwnEvent]);

  const handleToggleFollow = async () => {
    if (!user || isOwnEvent || isFollowSubmitting) return;
    setIsFollowSubmitting(true);
    const result = amFollowing ? await unfollowUser(user.uid, content.authorUid) : await followUser(user.uid, content.authorUid);
    setIsFollowSubmitting(false);
    if (!result.ok) return;
    setAmFollowing(!amFollowing);
  };

  // Same fallback reasoning as ReelFeedItem's own handleShare: the native
  // share sheet can fail for reasons other than the person cancelling it
  // (e.g. no share target configured on web), in which case silently
  // copying the link is a better outcome than nothing happening at all.
  // A genuine cancel stays quiet.
  const handleShare = async () => {
    const result = await shareContent(content.contentId, content.title);
    if (result.ok && user) {
      trackContentInteraction({
        userId: user.uid,
        contentId: content.contentId,
        contentType: 'content',
        action: 'share',
        categoryId: content.categoryId,
        creatorId: content.authorUid,
        cityKey: content.cityKey,
        countryCode: content.countryCode,
      }).catch(() => {});
    }
    if (!result.ok && !/cancel/i.test(result.message)) {
      await Clipboard.setStringAsync(buildContentShareUrl(content.contentId));
      onToast('Link copied');
    }
  };

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
      <View style={styles.topGroup}>
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

        {hasEnded ? <Text style={styles.endedText}>This event has ended.</Text> : null}

        <ProfileTabBar tabs={EVENT_DETAIL_TABS} value={detailTab} onChange={setDetailTab} />

        {detailTab === 'about' ? (
          <Text style={styles.description}>{content.description}</Text>
        ) : (
          <View style={styles.participantsPanel}>
            <View style={styles.participantRow}>
              <Ionicons name="star" size={18} color={Colors.accent} />
              <Text style={styles.participantLabel}>Interested</Text>
              <Text style={styles.participantCount}>{status === 'loaded' ? counts.interestedCount : '–'}</Text>
            </View>
            <View style={styles.participantRow}>
              <Ionicons name="checkmark-circle" size={18} color={Colors.accent} />
              <Text style={styles.participantLabel}>Going</Text>
              <Text style={styles.participantCount}>{status === 'loaded' ? counts.goingCount : '–'}</Text>
            </View>
          </View>
        )}
      </View>

      {/* Pushes the bottom group (author + Interested/Going) all the way
          to the bottom of the screen when there's spare vertical room —
          see this component's own `container` style below (flex: 1) and
          content/[contentId].tsx's mediaScroll/mediaPage/mediaBody
          styles, which all need `flex: 1` too for this to actually reach
          the real screen bottom rather than just this component's own
          (much shorter) natural height. A long description simply pushes
          this spacer to its 0-height floor and the bottom group scrolls
          below it as normal — this never clips or overlaps content. */}
      <View style={styles.spacer} />

      <View style={styles.bottomGroup}>
        <View style={styles.authorSection}>
          <View style={styles.authorLeft}>
            <AuthorLink uid={content.authorUid} style={styles.authorRow}>
              <Avatar name={content.authorDisplayName} photoURL={authorPhotoURL} size={28} />
              <Text style={styles.authorName}>{content.authorDisplayName}</Text>
            </AuthorLink>

            {/* Outside AuthorLink, not nested inside it — AuthorLink is
                itself a Pressable that navigates to the profile, and this
                needs its own independent tap target. Hidden entirely for
                the owner's own event (isOwnEvent) and while signed out
                (nothing to hold a follow relationship); amFollowing===null
                also hides it until the real state is known, same "never
                show a wrong guess" rule as ReelFeedItem's own follow badge. */}
            {user && !isOwnEvent && amFollowing !== null ? (
              <Pressable
                onPress={handleToggleFollow}
                disabled={isFollowSubmitting}
                style={[styles.followPill, amFollowing && styles.followPillActive]}
                accessibilityRole="button"
                accessibilityLabel={amFollowing ? `Unfollow ${content.authorDisplayName}` : `Follow ${content.authorDisplayName}`}
                accessibilityState={{ selected: amFollowing }}
              >
                <Text style={[styles.followPillText, amFollowing && styles.followPillTextActive]}>{amFollowing ? 'Following' : 'Follow'}</Text>
              </Pressable>
            ) : null}
          </View>

          {/* Share — same curved-arrow glyph TikTok uses for its own
              share action (Ionicons has no literal TikTok icon; this is
              the closest match already in the app's icon set — see
              ReelFeedItem's own share-outline for the different, iOS-box
              style used there instead). Always shown, even on your own
              event — sharing your own event is a normal, expected action. */}
          <Pressable onPress={handleShare} hitSlop={8} accessibilityRole="button" accessibilityLabel="Share event">
            <Ionicons name="arrow-redo-outline" size={22} color={Colors.text} />
          </Pressable>
        </View>

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
                icon="star-outline"
                activeIcon="star"
                label="Interested"
                selected={myResponse?.status === 'interested'}
                disabled={hasEnded || status === 'loading' || isSubmitting}
                onPress={() => handleTap('interested')}
              />
              <ResponseButton
                icon="checkmark-circle-outline"
                activeIcon="checkmark-circle"
                label="Going"
                selected={myResponse?.status === 'going'}
                disabled={hasEnded || status === 'loading' || isSubmitting}
                onPress={() => handleTap('going')}
              />
            </View>
          </>
        )}
      </View>
    </View>
  );
}

type ResponseButtonProps = {
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
};

/**
 * Same star/checkmark pill language as EventActionButtons on discovery
 * cards (Step 26) — no count here (see this component's own doc comment
 * above): the Participants tab already shows the real Interested/Going
 * counts, so repeating them on these buttons too would just be the same
 * number shown twice on one screen.
 */
function ResponseButton({ icon, activeIcon, label, selected, disabled, onPress }: ResponseButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.responseButton, selected && styles.responseButtonSelected, disabled && styles.responseButtonDisabled]}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
    >
      <Ionicons name={selected ? activeIcon : icon} size={18} color={selected ? Colors.background : Colors.accent} />
      <Text style={[styles.responseLabel, selected && styles.responseLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // flex: 1 so the `spacer` below can actually push `bottomGroup` down —
  // needs the same flex:1 all the way up through content/[contentId].tsx's
  // mediaScroll/mediaScrollContent/mediaPage/mediaBody, or this component
  // just gets its own natural (short) height and the spacer has nothing
  // to expand into.
  container: {
    flex: 1,
  },
  topGroup: {
    gap: Spacing.md,
  },
  spacer: {
    flex: 1,
  },
  bottomGroup: {
    gap: Spacing.md,
    paddingTop: Spacing.md,
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingVertical: Spacing.md,
  },
  responseButtonSelected: {
    backgroundColor: Colors.accent,
  },
  responseButtonDisabled: {
    opacity: 0.5,
  },
  responseLabel: {
    color: Colors.accent,
    fontSize: 15,
    fontWeight: '700',
  },
  responseLabelSelected: {
    color: Colors.background,
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
  participantsPanel: {
    gap: Spacing.sm,
  },
  participantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  participantLabel: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    fontWeight: '600',
  },
  participantCount: {
    color: Colors.accent,
    fontSize: 16,
    fontWeight: '700',
  },
  authorSection: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  authorLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: Spacing.sm,
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
  followPill: {
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.md,
    paddingVertical: 4,
  },
  followPillActive: {
    backgroundColor: Colors.accent,
  },
  followPillText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '700',
  },
  followPillTextActive: {
    color: Colors.background,
  },
});
