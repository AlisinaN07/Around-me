import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { AuthorLink } from '@/components/AuthorLink';
import { DetailHero } from '@/components/DetailHero';
import { HighlightedText } from '@/components/HighlightedText';
import { ProfileTabBar } from '@/components/ProfileTabBar';
import { SwipeBackEdge } from '@/components/SwipeBackEdge';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
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
import { isPostSaved, savePost, unsavePost } from '@/services/saved';
import type { EventContent, EventResponse, EventResponseStatus } from '@/types/content';
import { isBusinessAccount } from '@/utils/accountCapabilities';
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
// How many lines the About description shows before collapsing behind a
// "More" toggle — see isDescriptionLong's own doc comment below for how
// that toggle only ever appears when the text genuinely needs it.
// DESCRIPTION_LINE_HEIGHT must match styles.description's own lineHeight
// exactly — it's what turns a measured pixel height back into a line
// count below (see the measuring Text's own onLayout).
const DESCRIPTION_COLLAPSED_LINES = 4;
const DESCRIPTION_LINE_HEIGHT = 21;

type EventDetailProps = {
  content: EventContent;
  /** Same handler DetailHero's own back button / the screen's swipe-back edge calls — this component now owns its own full-screen layout (hero, scroll, pinned footer) rather than being wrapped by one, so it needs this directly. */
  onOptionsPress: () => void;
  /** Brief transient confirmation for the Share button's clipboard fallback (see handleShare below) — rendered by the parent screen, not here, same shared-toast pattern content/[contentId].tsx already uses for Save/Repost. */
  onToast: (message: string) => void;
};

export function EventDetail({ content, onOptionsPress, onToast }: EventDetailProps) {
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
  // Same live-read reasoning as authorPhotoURL above (an account that
  // converts to/from Business after this Event was published should
  // still show up correctly here) — read from the exact same
  // fetchPublicProfile call just below, never a second fetch.
  const [isAuthorBusiness, setIsAuthorBusiness] = useState(false);
  const isOwnEvent = !!user && user.uid === content.authorUid;
  // null = not yet checked — renders nothing, same "never show a wrong
  // guess" rule ReelFeedItem's own isFollowingAuthor uses, rather than
  // flashing "Follow" for a heartbeat before a real "Following" loads in.
  const [amFollowing, setAmFollowing] = useState<boolean | null>(null);
  const [isFollowSubmitting, setIsFollowSubmitting] = useState(false);
  // Step 12C — "I want to keep this for later," independent of and
  // coexisting with Interested/Going/Follow above (never mutually
  // exclusive with any of them — see handleToggleSave's own doc
  // comment). Same "reflect current state, never guess" pattern as
  // amFollowing: starts false (own event/signed-out never show the
  // button at all, same as Follow), and is only ever trusted once the
  // real persisted state has actually loaded (see the effect below).
  const [isSaved, setIsSaved] = useState(false);
  const [isSaveSubmitting, setIsSaveSubmitting] = useState(false);
  // Whether the About description has been expanded past its collapsed
  // DESCRIPTION_COLLAPSED_LINES — starts collapsed every time a fresh
  // Event is shown.
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  // Whether the description actually NEEDS the "More" toggle at all —
  // learned from the invisible measuring Text below's own rendered
  // HEIGHT (onLayout), never guessed from character count (screen
  // width/font scaling would make that wrong in either direction).
  // Deliberately NOT onTextLayout/its reported line count — react-
  // native-web doesn't implement onTextLayout at all (confirmed: it
  // never fires there), which would silently mean the toggle never
  // appears on web. onLayout's plain pixel height is a basic, universally
  // supported prop on every platform this app runs on. Starts `false` so a short
  // description never flashes a toggle it doesn't need.
  const [isDescriptionLong, setIsDescriptionLong] = useState(false);

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
      setIsAuthorBusiness(isBusinessAccount(authorProfile));
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

  // Own event -> never shown (same "nothing to keep for later from
  // yourself" reasoning as ReelFeedItem's own Save, which hides for
  // isOwnReel too). Signed-out -> also nothing shown (no account to hold
  // a save relationship). Otherwise reflects the real persisted state.
  useEffect(() => {
    let cancelled = false;
    if (isOwnEvent || !user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsSaved(false);
      return;
    }
    isPostSaved(user.uid, 'event', content.contentId).then((saved) => {
      if (!cancelled) setIsSaved(saved);
    });
    return () => {
      cancelled = true;
    };
  }, [content.contentId, user, isOwnEvent]);

  /**
   * Step 12C — reuses the EXISTING generic savePost/unsavePost
   * (src/services/saved.ts), which already: (1) writes the SAME
   * canonical `users/{uid}/saved/{savedId}` document every other saved
   * type uses (no second storage model), with a deterministic id so a
   * repeat save is a plain idempotent `setDoc` overwrite, never a
   * duplicate; (2) fires the recommendation-learning signal
   * (`event_save`/`event_unsave` for an Event specifically — see
   * trackSaveSignal's own doc comment) fire-and-forget, same
   * never-blocks-the-real-action pattern every other tracked interaction
   * in this app follows. Save/Interested/Going/Follow are four
   * INDEPENDENT booleans — this never reads or changes `myResponse`/
   * `amFollowing`, and neither of those ever reads or changes `isSaved`.
   */
  const handleToggleSave = async () => {
    if (!user || isOwnEvent || isSaveSubmitting) return;
    const wasSaved = isSaved;
    setIsSaveSubmitting(true);
    const result = wasSaved ? await unsavePost(user.uid, 'event', content.contentId) : await savePost(user.uid, 'event', content.contentId);
    setIsSaveSubmitting(false);
    if (!result.ok) {
      onToast(result.message);
      return;
    }
    setIsSaved(!wasSaved);
    onToast(wasSaved ? 'Removed from saved' : 'Saved');
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
        // Step 12D — `share` was already a GENERIC hashtag-interest
        // signal (HASHTAG_INTEREST_WEIGHTS.share, pre-existing) — this is
        // the first time an Event ever supplies real hashtags to it.
        hashtags: content.hashtags ?? [],
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
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {/* Same handler DetailHero's own back button calls. */}
      <SwipeBackEdge onBack={() => router.back()} />

      {/* This ScrollView (flex: 1) is what actually scrolls — the hero,
          date/place, About/Participants tabs, and description. The footer
          below it (author + Share + Interested/Going) is a plain sibling
          AFTER this ScrollView, never inside it, so it always sits flush
          at the real screen bottom without needing to be scrolled to —
          see this file's own footer/safeArea styles for the mechanics
          (no spacer trick needed: a flex:1 ScrollView already consumes
          every bit of space above whatever sits after it). */}
      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.page}>
          <DetailHero
            title={content.title}
            categoryId={content.categoryId}
            startsAt={content.startsAt}
            endsAt={content.endsAt}
            onOptionsPress={onOptionsPress}
            coverPhotoURL={content.coverPhotoURL}
          />
          <View style={styles.body}>
            <View style={styles.infoRow}>
              <Ionicons name="time-outline" size={16} color={Colors.textSecondary} />
              <Text style={styles.infoText}>
                {formatEventTime(content.startsAt.toDate())} –{' '}
                {content.endsAt.toDate().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
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
              <View style={styles.descriptionWrap}>
                {/* Invisible measuring pass — the exact same text, same
                    width, laid out WITHOUT a line clamp, purely to learn
                    (from its own rendered height) how many lines it
                    actually needs at this width — see isDescriptionLong's
                    own doc comment above for why this is onLayout/height,
                    not onTextLayout/line count. Never itself visible
                    (opacity 0) or interactive (pointerEvents none) — the
                    real, clamped copy right below it is what's actually
                    shown. */}
                <Text
                  style={[styles.description, styles.descriptionMeasure]}
                  onLayout={(event) => {
                    // +2px of rounding slack — the same kind of tolerance
                    // any pixel-based layout comparison across platforms
                    // needs. A height at or under 4 full lines never
                    // shows the toggle; anything genuinely past it does.
                    const collapsedHeight = DESCRIPTION_COLLAPSED_LINES * DESCRIPTION_LINE_HEIGHT;
                    setIsDescriptionLong(event.nativeEvent.layout.height > collapsedHeight + 2);
                  }}
                  pointerEvents="none"
                >
                  {content.description}
                </Text>
                {/* Step 12D — same HighlightedText component a Reel's own
                    caption already uses for clickable hashtag spans (see
                    ReelFeedItem.tsx) — reused as-is, not a second
                    implementation. Only this REAL, visible copy switches;
                    the invisible measuring Text just above stays a plain
                    Text (nested hashtag spans could measure a hair
                    differently and risk a height mismatch for no benefit,
                    since nothing about it is ever shown). */}
                <HighlightedText
                  text={content.description}
                  style={styles.description}
                  hashtagStyle={styles.descriptionHashtag}
                  numberOfLines={isDescriptionExpanded ? undefined : DESCRIPTION_COLLAPSED_LINES}
                />
                {isDescriptionLong ? (
                  <Pressable
                    onPress={() => setIsDescriptionExpanded((expanded) => !expanded)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={isDescriptionExpanded ? 'Show less' : 'Show more'}
                  >
                    <Text style={styles.moreLink}>{isDescriptionExpanded ? 'Show less' : 'More'}</Text>
                  </Pressable>
                ) : null}
              </View>
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
        </View>
      </ScrollView>

      <View style={styles.footer}>
        <View style={styles.authorSection}>
          <View style={styles.authorLeft}>
            <AuthorLink uid={content.authorUid} style={styles.authorRow}>
              <Avatar name={content.authorDisplayName} photoURL={authorPhotoURL} size={28} />
              <Text style={styles.authorName}>{content.authorDisplayName}</Text>
              {/* Same blue "B" badge as ProfileHeader's own — see its doc
                  comment for why this isn't a third-party verification
                  mark, just this app's own "company account" fact. */}
              {isAuthorBusiness ? (
                <View style={styles.businessBadge} accessibilityLabel="Business account">
                  <Text style={styles.businessBadgeText}>B</Text>
                </View>
              ) : null}
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

          <View style={styles.footerActions}>
            {/* Step 12C — same bookmark glyph ReelFeedItem's own Save
                action already uses elsewhere in this app (reused, not a
                new icon pattern). Hidden for your own event and while
                signed out — see handleToggleSave's own doc comment. */}
            {user && !isOwnEvent ? (
              <Pressable
                onPress={handleToggleSave}
                disabled={isSaveSubmitting}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={isSaved ? 'Remove from saved' : 'Save'}
                accessibilityState={{ selected: isSaved, disabled: isSaveSubmitting }}
              >
                <Ionicons name={isSaved ? 'bookmark' : 'bookmark-outline'} size={22} color={isSaved ? Colors.accent : Colors.text} />
              </Pressable>
            ) : null}

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
    </SafeAreaView>
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
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  // flex: 1 is what makes this actually scroll within the remaining
  // space above `footer` below, rather than growing to fit all its
  // content — see this component's own top doc comment on its return
  // statement for why that's what keeps `footer` pinned at the real
  // screen bottom with no spacer trick needed.
  scroll: {
    flex: 1,
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  body: {
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
  },
  // Sits AFTER (never inside) the ScrollView above — a plain, natural-
  // height sibling that a flex:1 ScrollView pushes flush against the
  // real screen bottom, always visible, never requiring a scroll to
  // reach it.
  footer: {
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.md,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    backgroundColor: Colors.background,
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
    gap: 5,
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.accent,
    // +20% over the previous 4px pass, per feedback that landed too small.
    paddingVertical: 5,
  },
  responseButtonSelected: {
    backgroundColor: Colors.accent,
  },
  responseButtonDisabled: {
    opacity: 0.5,
  },
  responseLabel: {
    color: Colors.accent,
    fontSize: 16,
    fontWeight: '700',
  },
  responseLabelSelected: {
    color: Colors.background,
  },
  description: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: DESCRIPTION_LINE_HEIGHT,
  },
  // Same accent-color convention ReelFeedItem's own captionHashtag style uses.
  descriptionHashtag: {
    color: Colors.accent,
    fontWeight: '700',
  },
  descriptionWrap: {
    gap: 4,
  },
  // Absolutely positioned within descriptionWrap (every RN View is
  // already position:'relative' by default, so no extra anchor style is
  // needed there) — stacks directly on top of the real, visible copy
  // below it, invisible (opacity 0) and never intercepting touches, used
  // purely to measure line count. See this style's own call site for the
  // full reasoning.
  descriptionMeasure: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
  },
  moreLink: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
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
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
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
  // Same blue as ProfileHeader's own BUSINESS_BADGE_COLOR — kept as a
  // separate literal here (not exported/shared) since it's the only
  // other place this exact badge appears; keep both in sync if it ever
  // changes.
  businessBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  businessBadgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '800',
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
