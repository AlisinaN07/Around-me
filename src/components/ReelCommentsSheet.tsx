import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { AuthorLink } from '@/components/AuthorLink';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ReportModal } from '@/components/ReportModal';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import {
  addReelComment,
  deleteReelComment,
  fetchMyReelCommentReaction,
  fetchReelCommentCount,
  fetchReelCommentReactionCounts,
  fetchReelComments,
  removeReelCommentReaction,
  setReelCommentReaction,
  type ReelCommentReactionCounts,
} from '@/services/reelEngagement';
import { REEL_COMMENT_BODY_MAX_LENGTH, type ReelComment, type ReelCommentReactionType } from '@/types/reel';
import { formatTimeAgo } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';

type CommentReactionState = ReelCommentReactionCounts & { myReaction: ReelCommentReactionType | null };

// Phase 1 perf pass — small in-memory cache, same module-level Map shape
// already proven by reels.ts's own playbackUrlCache. Keyed by
// `${reelId}:${viewerUid}`, NOT reelId alone — myReaction below is
// viewer-specific, so caching by reelId only would leak one viewer's own
// reaction state to a different signed-in account sharing the same
// session (see this file's own "account-safe" requirement). '' stands in
// for signed-out, its own bucket, never mixed with a real uid's.
type CommentsCacheEntry = {
  comments: ReelComment[];
  commentCount: number;
  reactions: Record<string, CommentReactionState>;
  fetchedAt: number;
};
const COMMENTS_CACHE_TTL_MS = 45_000;
const commentsCache = new Map<string, CommentsCacheEntry>();

function commentsCacheKey(reelId: string, uid: string | undefined): string {
  return `${reelId}:${uid ?? ''}`;
}

type ReelCommentsSheetProps = {
  visible: boolean;
  reelId: string;
  onClose: () => void;
  /**
   * The action rail's own comment-count badge lives in the parent
   * (ReelFeedItem), not here — this reports the real total back up
   * whenever it changes (load, post, delete) so that badge stays accurate
   * without this sheet needing to duplicate that state.
   */
  onCommentCountChange?: (count: number) => void;
};

/**
 * Half-screen comments bottom sheet for the full-screen Reel feed item —
 * the video stays exactly where it is, playing, full-screen, behind this;
 * nothing about it shrinks or navigates away. This originally replaced
 * only the "tap comments -> push to /reel/[reelId]" behavior on Home's
 * own feed item; /reel/[reelId] (Profile grid, share links, search) now
 * renders through this exact same ReelFeedItem too, so every entry point
 * shares one identical comment experience — there is no other comment UI
 * left anywhere in the app.
 *
 * Talks directly to src/services/reelEngagement.ts — this is a
 * presentation-only component, not a new data layer for the Post-level
 * Like (already its own action-rail button; duplicating it here would be
 * redundant). Each individual comment can additionally be Liked/Disliked
 * — a separate, lightweight per-comment reaction (see
 * ReelCommentReaction's own doc comment in src/types/reel.ts), unrelated
 * to the Post's own Like/lifetime Liked stat.
 */
export function ReelCommentsSheet({ visible, reelId, onClose, onCommentCountChange }: ReelCommentsSheetProps) {
  const { user } = useAuth();
  const { profile } = useProfile();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [comments, setComments] = useState<ReelComment[]>([]);
  const [commentBody, setCommentBody] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Long-press on a comment opens Delete (own comment) / Report
  // (someone else's) — replacing a permanently-visible delete icon.
  const [optionsTarget, setOptionsTarget] = useState<ReelComment | null>(null);
  const [reportTarget, setReportTarget] = useState<ReelComment | null>(null);

  // Tapping "Reply" on a top-level comment aims the single bottom
  // composer at it instead — see ReelComment's own doc comment for why
  // replies are capped at one level (Reply never appears on a reply
  // itself, only on top-level comments).
  const [replyingTo, setReplyingTo] = useState<ReelComment | null>(null);
  const composerInputRef = useRef<TextInput>(null);

  // Replies stay collapsed by default — a top-level comment with replies
  // shows "Show N answers" instead of "Answer" until expanded (a commentId
  // in this set), matching every already-fetched reply for that comment
  // being shown at once rather than a further paginated "load more" (the
  // outer 30-comment fetch cap is the only real bound — see
  // fetchReelComments' own doc comment).
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(new Set());

  // Per-comment Like/Dislike state, keyed by commentId — loaded alongside
  // the comment list itself (see load() below). A comment briefly missing
  // from this map (right after the list loads, before its own reaction
  // fetch resolves) is treated as zero counts / no reaction, never as an
  // error — see the render below's `reactions[comment.commentId] ?? ...`.
  const [reactions, setReactions] = useState<Record<string, CommentReactionState>>({});
  const [reactingCommentId, setReactingCommentId] = useState<string | null>(null);
  // Phase 4 perf pass — which commentIds have had their reactions fetched
  // (attempted) THIS sheet-open session — see load()'s own doc comment
  // below for why replies are deliberately excluded from that eager
  // fetch, and handleToggleThread's own doc comment for how a reply's
  // reactions are fetched on demand the first time its thread is actually
  // expanded. Persists across close/reopen of this same mounted sheet
  // (this component is never unmounted while its Reel is, only hidden via
  // `visible` — see this file's own doc comment) so re-expanding an
  // already-expanded-this-session thread never re-fetches; reset to just
  // the fresh top-level set at the start of every REAL (non-silent) load,
  // since that's a genuinely new snapshot of this Reel's comments.
  const loadedReactionCommentIdsRef = useRef<Set<string>>(new Set());

  const cacheKey = commentsCacheKey(reelId, user?.uid);

  // Guards the SILENT path against overlapping requests — the same shape
  // already proven on Home/Events/Profile/Inbox: a silent revalidate skips
  // entirely rather than overlap one already running.
  const isLoadInFlightRef = useRef(false);

  /**
   * Fetches reaction counts + the viewer's own reaction for exactly the
   * given comments — never more. Each comment's fetch is caught
   * INDIVIDUALLY (a slow or failed reaction fetch for one comment must
   * never affect any other, or the comment list's own already-'loaded'
   * status — same reasoning `load` below already followed before this was
   * split out as its own function).
   */
  const fetchReactionsFor = useCallback(
    async (targets: ReelComment[]): Promise<Record<string, CommentReactionState>> => {
      const entries = await Promise.all(
        targets.map(async (comment) => {
          try {
            const [counts, myReaction] = await Promise.all([
              fetchReelCommentReactionCounts(reelId, comment.commentId),
              user ? fetchMyReelCommentReaction(reelId, comment.commentId, user.uid) : Promise.resolve(null),
            ]);
            return [comment.commentId, { ...counts, myReaction }] as const;
          } catch {
            return [comment.commentId, { likeCount: 0, dislikeCount: 0, myReaction: null }] as const;
          }
        })
      );
      return Object.fromEntries(entries);
    },
    [reelId, user]
  );

  /**
   * `silent` (default false) is this sheet's stale-while-revalidate
   * behavior: a non-silent call is a REAL load — it sets `status` to
   * 'loading', which is what actually blanks the sheet to its spinner
   * (see the render below) — used for the first-ever open of a given
   * Reel's comments (nothing cached yet) and an explicit retry (the
   * error state's "Try again"). A silent call is a background
   * revalidate — it never touches `status`, so whatever's already shown
   * (from cache — see the opening effect below) stays up while this
   * refetches quietly behind it; on success it updates `comments`/
   * `reactions`/the cache entry in place, and on failure it leaves the
   * already-shown comments and status untouched rather than surfacing
   * the error state over content that was working a moment ago.
   */
  const load = useCallback(
    async (options?: { silent?: boolean }) => {
      const silent = options?.silent ?? false;
      if (silent && isLoadInFlightRef.current) return;
      isLoadInFlightRef.current = true;
      if (!silent) {
        setStatus('loading');
        // Phase 4 perf pass — a REAL load is a genuinely new snapshot of
        // this Reel's comments; a silent revalidate is not (see
        // loadedReactionCommentIdsRef's own doc comment above for why
        // that path deliberately keeps whatever was already tracked, so
        // an already-expanded thread's replies stay refreshed too).
        loadedReactionCommentIdsRef.current = new Set();
      }
      let list: ReelComment[];
      let total: number;
      try {
        [list, total] = await Promise.all([fetchReelComments(reelId), fetchReelCommentCount(reelId)]);
        setComments(list);
        onCommentCountChange?.(total);
        setStatus('loaded');
      } catch {
        // Silent revalidate failure: leave whatever's already rendered
        // (comments/reactions AND status) exactly as it is — a background
        // refresh going wrong is never grounds to blank a sheet that was
        // working a moment ago. A non-silent failure still shows the real
        // error state, same as before this pattern existed.
        if (!silent) setStatus('error');
        isLoadInFlightRef.current = false;
        return;
      }

      // Reaction counts/own-reaction are loaded separately, per comment,
      // deliberately OUTSIDE the try/catch above: the comment list itself
      // is already showing (status is 'loaded') by this point, so a slow or
      // failed reaction fetch for one comment must never flip the whole
      // sheet to an error state — see fetchReactionsFor's own doc comment
      // for how each comment's own fetch is caught individually.
      //
      // Phase 4 perf pass — eager reactions are fetched for TOP-LEVEL
      // comments only, plus any reply already tracked in
      // loadedReactionCommentIdsRef (a thread expanded earlier this
      // session — see handleToggleThread below), never every reply
      // unconditionally. Replies stay collapsed behind "Show N answers"
      // until tapped (see expandedThreads' own doc comment) — the vast
      // majority of threads on a busy Reel are never expanded at all, so
      // eagerly reacting-fetching every reply on every open was pure N+1
      // waste. This substantially cuts the per-open reaction-read volume
      // for any Reel with replies, with zero schema/index change — a
      // bigger reduction (e.g. a single batched query, or pre-aggregated
      // counts on the comment doc itself) would need a real backend
      // change; see this phase's own audit report for the two designs
      // considered and why neither was applied without an explicit
      // go-ahead.
      const alreadyLoadedIds = loadedReactionCommentIdsRef.current;
      const targets = list.filter((comment) => !comment.parentCommentId || alreadyLoadedIds.has(comment.commentId));
      const reactionsByCommentId = await fetchReactionsFor(targets);
      loadedReactionCommentIdsRef.current = new Set(targets.map((comment) => comment.commentId));
      setReactions(reactionsByCommentId);
      // Phase 1 perf pass — a successful load (real or silent) is exactly
      // what keeps the cache fresh; see commentsCache's own doc comment.
      commentsCache.set(cacheKey, { comments: list, commentCount: total, reactions: reactionsByCommentId, fetchedAt: Date.now() });
      isLoadInFlightRef.current = false;
    },
    [reelId, onCommentCountChange, cacheKey, fetchReactionsFor]
  );

  // Stale-while-revalidate, keyed by cacheKey (reelId + viewer uid — see
  // commentsCache's own doc comment). Opening the sheet:
  //  - A cached entry within COMMENTS_CACHE_TTL_MS: applied directly,
  //    instantly, with NO fetch at all — this is the literal "reopening
  //    within TTL shows cached comments immediately" requirement.
  //  - A cached entry PAST its TTL: still applied immediately (so nothing
  //    ever blanks), then silently revalidated in the background.
  //  - No cached entry at all (first time this Reel's comments have ever
  //    been opened this session): a real load, spinner and all.
  // Never fetches anything while closed, and never prefetches ahead of a
  // real open (see this file's own Do-NOT-prefetch requirement).
  useEffect(() => {
    if (!visible) return;
    // Resets fresh every time the sheet opens — same prop-driven-reset
    // pattern as ReelFeedItem/ReportModal.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReplyingTo(null);
    setExpandedThreads(new Set());

    const cached = commentsCache.get(cacheKey);
    if (cached) {
      setComments(cached.comments);
      setReactions(cached.reactions);
      setStatus('loaded');
      onCommentCountChange?.(cached.commentCount);
      const isFresh = Date.now() - cached.fetchedAt < COMMENTS_CACHE_TTL_MS;
      if (!isFresh) load({ silent: true });
    } else {
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, cacheKey]);

  // Groups the one already-fetched, newest-first list into top-level
  // comments and a parentCommentId -> replies map — no second query, no
  // new Firestore index (see fetchReelComments' own newest-30 cap doc
  // comment: that cap is shared across top-level comments and replies
  // together, an accepted v1 simplification). Replies are shown oldest-
  // first under their parent (reversed from the source list's newest-
  // first order) since that reads as a real conversation.
  const { topLevelComments, repliesByParent } = useMemo(() => {
    const topLevel: ReelComment[] = [];
    const byParent = new Map<string, ReelComment[]>();
    for (const comment of comments) {
      if (comment.parentCommentId) {
        const list = byParent.get(comment.parentCommentId) ?? [];
        list.push(comment);
        byParent.set(comment.parentCommentId, list);
      } else {
        topLevel.push(comment);
      }
    }
    for (const list of byParent.values()) list.reverse();
    return { topLevelComments: topLevel, repliesByParent: byParent };
  }, [comments]);

  const handleStartReply = (comment: ReelComment) => {
    setReplyingTo(comment);
    composerInputRef.current?.focus();
  };

  const handleToggleThread = (commentId: string) => {
    setExpandedThreads((prev) => {
      const next = new Set(prev);
      if (next.has(commentId)) {
        next.delete(commentId);
      } else {
        next.add(commentId);
        // Phase 4 perf pass — the FIRST time this thread is expanded this
        // sheet-open session, fetch reactions for exactly its own replies
        // (never fetched eagerly by load() — see its own doc comment) —
        // most threads are never expanded at all, so this only ever pays
        // for the ones a person actually opens. Skipped for a reply
        // already covered by loadedReactionCommentIdsRef (collapsing then
        // re-expanding the same thread, or one a prior silent revalidate
        // already refreshed).
        const replies = repliesByParent.get(commentId) ?? [];
        const unfetched = replies.filter((reply) => !loadedReactionCommentIdsRef.current.has(reply.commentId));
        if (unfetched.length > 0) {
          fetchReactionsFor(unfetched).then((fetched) => {
            unfetched.forEach((reply) => loadedReactionCommentIdsRef.current.add(reply.commentId));
            setReactions((prevReactions) => {
              const merged = { ...prevReactions, ...fetched };
              // Keep the cache entry (if any) in step, same reasoning as
              // handleToggleReaction's own cache write below.
              const cached = commentsCache.get(cacheKey);
              if (cached) commentsCache.set(cacheKey, { ...cached, reactions: merged });
              return merged;
            });
          });
        }
      }
      return next;
    });
  };

  const handlePostComment = async () => {
    if (!user || isPosting) return;
    const trimmed = commentBody.trim();
    if (!trimmed) return;
    setIsPosting(true);
    setError(null);
    const parentCommentId = replyingTo?.commentId ?? null;
    const result = await addReelComment(reelId, user.uid, trimmed, parentCommentId);
    setIsPosting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // A freshly-posted reply should be immediately visible, not hidden
    // behind a still-collapsed "Show N answers" the person would have to
    // tap again right after posting.
    if (parentCommentId) {
      setExpandedThreads((prev) => new Set(prev).add(parentCommentId));
    }
    setReplyingTo(null);
    setCommentBody('');
    await load();
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!user || deletingCommentId) return;
    setDeletingCommentId(commentId);
    setError(null);
    const result = await deleteReelComment(reelId, commentId, user.uid);
    setDeletingCommentId(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await load();
  };

  /**
   * Tapping the icon matching the viewer's current reaction removes it
   * (toggle off); tapping the other one switches to it; tapping either
   * one with no prior reaction sets it. Updates `reactions` locally from
   * the known previous state rather than re-fetching every comment's
   * counts after one tap — a real write already happened above, this
   * just reflects its known, deterministic effect immediately.
   */
  const handleToggleReaction = async (commentId: string, type: ReelCommentReactionType) => {
    if (!user || reactingCommentId) return;
    const current = reactions[commentId] ?? { likeCount: 0, dislikeCount: 0, myReaction: null };
    const wasSameReaction = current.myReaction === type;

    setReactingCommentId(commentId);
    setError(null);
    const result = wasSameReaction
      ? await removeReelCommentReaction(reelId, commentId, user.uid)
      : await setReelCommentReaction(reelId, commentId, user.uid, type);
    setReactingCommentId(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }

    setReactions((prev) => {
      const entry = prev[commentId] ?? { likeCount: 0, dislikeCount: 0, myReaction: null };
      let { likeCount, dislikeCount } = entry;
      if (entry.myReaction === 'like') likeCount -= 1;
      if (entry.myReaction === 'dislike') dislikeCount -= 1;
      const nextReaction = wasSameReaction ? null : type;
      if (nextReaction === 'like') likeCount += 1;
      if (nextReaction === 'dislike') dislikeCount += 1;
      const next = { ...prev, [commentId]: { likeCount: Math.max(0, likeCount), dislikeCount: Math.max(0, dislikeCount), myReaction: nextReaction } };
      // Keep the cache entry (if any) in step with this same known,
      // deterministic update — a real write already succeeded above, this
      // just mirrors it into the cache exactly like it's already mirrored
      // into local state, so a close-then-reopen within TTL doesn't show
      // a stale pre-reaction snapshot. See commentsCache's own doc
      // comment — never a reason to invalidate the whole entry here, only
      // update the one field that actually changed.
      const cached = commentsCache.get(cacheKey);
      if (cached) commentsCache.set(cacheKey, { ...cached, reactions: next });
      return next;
    });
  };

  const canSend = !!user && !!commentBody.trim() && !isPosting;

  // Own comment -> Delete; someone else's -> Report. OptionsMenu supplies
  // its own Cancel row, so that's never listed here explicitly.
  const commentOptionsMenuOptions: OptionsMenuOption[] = optionsTarget
    ? user?.uid === optionsTarget.authorUid
      ? [{ label: 'Delete comment', onPress: () => handleDeleteComment(optionsTarget.commentId), destructive: true }]
      : [{ label: 'Report comment', onPress: () => setReportTarget(optionsTarget) }]
    : [];

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        {/* Sibling to the sheet, not a wrapping parent — see OptionsMenu's
            own comment on why (avoids a <button> nesting another <button>
            on web). Tapping anywhere above the sheet closes it. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel="Close comments" />

        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetOuter}>
          <SafeAreaView edges={['bottom']} style={styles.sheet}>
            <View style={styles.grabberRow}>
              <View style={styles.grabber} />
            </View>

            <View style={styles.header}>
              <Text style={styles.headerTitle}>Comments</Text>
              <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close comments">
                <Ionicons name="chevron-down" size={22} color={Colors.text} />
              </Pressable>
            </View>

            {status === 'loading' ? (
              <View style={styles.centered}>
                <ActivityIndicator color={Colors.textSecondary} />
              </View>
            ) : status === 'error' ? (
              <View style={styles.centered}>
                <Text style={styles.errorText}>Couldn&apos;t load comments.</Text>
                <Pressable onPress={() => load()} accessibilityRole="button">
                  <Text style={styles.retryLink}>Try again</Text>
                </Pressable>
              </View>
            ) : comments.length === 0 ? (
              <View style={styles.centered}>
                <Text style={styles.emptyTitle}>No comments yet</Text>
                <Text style={styles.emptyBody}>Be the first to comment.</Text>
              </View>
            ) : (
              <ScrollView style={styles.list} contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled">
                {topLevelComments.map((comment) => {
                  const replies = repliesByParent.get(comment.commentId) ?? [];
                  const isExpanded = expandedThreads.has(comment.commentId);
                  return (
                    <View key={comment.commentId} style={styles.commentThread}>
                      <CommentRow
                        comment={comment}
                        isOwnComment={user?.uid === comment.authorUid}
                        reaction={reactions[comment.commentId] ?? { likeCount: 0, dislikeCount: 0, myReaction: null }}
                        isReacting={!user || reactingCommentId === comment.commentId}
                        onToggleReaction={(type) => handleToggleReaction(comment.commentId, type)}
                        onLongPress={() => user && setOptionsTarget(comment)}
                        onReply={user ? () => handleStartReply(comment) : undefined}
                        replyCount={replies.length}
                        isThreadExpanded={isExpanded}
                        onToggleThread={() => handleToggleThread(comment.commentId)}
                      />
                      {isExpanded &&
                        replies.map((reply) => (
                          <View key={reply.commentId} style={styles.replyRow}>
                            <CommentRow
                              comment={reply}
                              isOwnComment={user?.uid === reply.authorUid}
                              reaction={reactions[reply.commentId] ?? { likeCount: 0, dislikeCount: 0, myReaction: null }}
                              isReacting={!user || reactingCommentId === reply.commentId}
                              onToggleReaction={(type) => handleToggleReaction(reply.commentId, type)}
                              onLongPress={() => user && setOptionsTarget(reply)}
                            />
                          </View>
                        ))}
                    </View>
                  );
                })}
              </ScrollView>
            )}

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            {user && (
              <>
                {replyingTo && (
                  <View style={styles.replyingToRow}>
                    <Text style={styles.replyingToText} numberOfLines={1}>
                      Answering {replyingTo.authorDisplayName}
                    </Text>
                    <Pressable onPress={() => setReplyingTo(null)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Cancel reply">
                      <Ionicons name="close" size={16} color={Colors.textSecondary} />
                    </Pressable>
                  </View>
                )}
                <View style={styles.composerRow}>
                  <Avatar name={profile?.displayName ?? 'You'} photoURL={profile?.photoURL} size={32} />
                  <TextInput
                    ref={composerInputRef}
                    style={styles.composerInput}
                    placeholder={replyingTo ? `Answer ${replyingTo.authorDisplayName}...` : 'Add a comment...'}
                    placeholderTextColor={Colors.textSecondary}
                    value={commentBody}
                    onChangeText={setCommentBody}
                    maxLength={REEL_COMMENT_BODY_MAX_LENGTH}
                    multiline
                    editable={!isPosting}
                  />
                  <Pressable
                    onPress={handlePostComment}
                    disabled={!canSend}
                    style={[styles.sendButton, !canSend && styles.sendButtonDisabled]}
                    accessibilityRole="button"
                    accessibilityLabel="Send comment"
                  >
                    {isPosting ? (
                      <ActivityIndicator color={Colors.text} size="small" />
                    ) : (
                      <Ionicons name="send" size={18} color={canSend ? Colors.accent : Colors.textSecondary} />
                    )}
                  </Pressable>
                </View>
              </>
            )}
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>

      <OptionsMenu visible={!!optionsTarget} onClose={() => setOptionsTarget(null)} options={commentOptionsMenuOptions} />

      {user && reportTarget ? (
        <ReportModal
          visible={!!reportTarget}
          onClose={() => setReportTarget(null)}
          reporterUid={user.uid}
          target={{ type: 'reel_comment', reelId, commentId: reportTarget.commentId }}
        />
      ) : null}
    </Modal>
  );
}

/**
 * One comment or reply row: avatar, name (+ "You" badge), body, and a
 * footer of time / Like-Dislike / Reply — shared by both the top-level
 * list and each comment's own indented replies (see the parent's
 * `commentThread`/`replyRow` styles for the only visual difference,
 * indentation). `onReply` is only ever passed for a top-level comment —
 * a reply itself never gets its own "Reply" affordance (see ReelComment's
 * own doc comment for the one-level-only cap this reflects).
 */
function CommentRow({
  comment,
  isOwnComment,
  reaction,
  isReacting,
  onToggleReaction,
  onLongPress,
  onReply,
  replyCount = 0,
  isThreadExpanded = false,
  onToggleThread,
}: {
  comment: ReelComment;
  isOwnComment: boolean;
  reaction: CommentReactionState;
  isReacting: boolean;
  onToggleReaction: (type: ReelCommentReactionType) => void;
  onLongPress: () => void;
  /** Only ever passed for a top-level comment — see the component's own doc comment. */
  onReply?: () => void;
  /** How many replies this comment has — only meaningful alongside onReply (a reply never has its own replies). */
  replyCount?: number;
  isThreadExpanded?: boolean;
  onToggleThread?: () => void;
}) {
  return (
    <Pressable style={styles.commentRow} onLongPress={onLongPress} accessibilityRole="none">
      <AuthorLink uid={comment.authorUid}>
        <Avatar name={comment.authorDisplayName} size={32} />
      </AuthorLink>
      <View style={styles.commentBody}>
        <View style={styles.commentHeaderRow}>
          <AuthorLink uid={comment.authorUid} style={styles.commentAuthorLink}>
            <Text style={styles.commentAuthor} numberOfLines={1}>
              {comment.authorDisplayName}
            </Text>
          </AuthorLink>
          {isOwnComment && (
            <View style={styles.youBadge}>
              <Text style={styles.youText}>You</Text>
            </View>
          )}
        </View>
        <Text style={styles.commentText}>{comment.body}</Text>
        <View style={styles.commentFooterRow}>
          <View style={styles.commentFooterLeft}>
            <Text style={styles.commentTime}>{formatTimeAgo(comment.createdAt.toDate())}</Text>
            {onReply &&
              (replyCount > 0 ? (
                <Pressable onPress={onToggleThread} hitSlop={8} accessibilityRole="button" accessibilityLabel={isThreadExpanded ? 'Hide answers' : 'Show answers'}>
                  <Text style={styles.replyLink}>{isThreadExpanded ? 'Hide answers' : `Show ${replyCount} answers`}</Text>
                </Pressable>
              ) : (
                <Pressable onPress={onReply} hitSlop={8} accessibilityRole="button" accessibilityLabel="Reply to comment">
                  <Text style={styles.replyLink}>Answer</Text>
                </Pressable>
              ))}
            {onReply && replyCount > 0 && isThreadExpanded && (
              <Pressable onPress={onReply} hitSlop={8} accessibilityRole="button" accessibilityLabel="Reply to comment">
                <Text style={styles.replyLink}>Answer</Text>
              </Pressable>
            )}
          </View>
          <CommentReactionButtons reaction={reaction} disabled={isReacting} onToggle={onToggleReaction} />
        </View>
      </View>
    </Pressable>
  );
}

/** The Like/Dislike icon-and-count pair under one comment's text — see ReelCommentReaction's own doc comment for the exclusive-per-user model this reflects. */
function CommentReactionButtons({
  reaction,
  disabled,
  onToggle,
}: {
  reaction: CommentReactionState;
  disabled: boolean;
  onToggle: (type: ReelCommentReactionType) => void;
}) {
  return (
    <View style={styles.reactionColumn}>
      <Pressable
        onPress={() => onToggle('like')}
        disabled={disabled}
        style={styles.reactionButton}
        accessibilityRole="button"
        accessibilityLabel={reaction.myReaction === 'like' ? 'Remove like' : 'Like comment'}
        accessibilityState={{ selected: reaction.myReaction === 'like' }}
      >
        <Ionicons name={reaction.myReaction === 'like' ? 'thumbs-up' : 'thumbs-up-outline'} size={14} color={reaction.myReaction === 'like' ? Colors.accent : Colors.textSecondary} />
        <Text style={[styles.reactionCount, reaction.myReaction === 'like' && styles.reactionCountActive]}>{reaction.likeCount}</Text>
      </Pressable>
      <Pressable
        onPress={() => onToggle('dislike')}
        disabled={disabled}
        style={styles.reactionButton}
        accessibilityRole="button"
        accessibilityLabel={reaction.myReaction === 'dislike' ? 'Remove dislike' : 'Dislike comment'}
        accessibilityState={{ selected: reaction.myReaction === 'dislike' }}
      >
        <Ionicons
          name={reaction.myReaction === 'dislike' ? 'thumbs-down' : 'thumbs-down-outline'}
          size={14}
          color={reaction.myReaction === 'dislike' ? Colors.accent : Colors.textSecondary}
        />
        <Text style={[styles.reactionCount, reaction.myReaction === 'dislike' && styles.reactionCountActive]}>{reaction.dislikeCount}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
  },
  sheetOuter: {
    height: '55%',
  },
  sheet: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    overflow: 'hidden',
  },
  grabberRow: {
    alignItems: 'center',
    paddingTop: Spacing.sm,
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: Spacing.lg,
  },
  retryLink: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  emptyTitle: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '700',
  },
  emptyBody: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  list: {
    flex: 1,
  },
  listContent: {
    padding: Spacing.lg,
    gap: Spacing.lg,
  },
  // One top-level comment plus its own replies, if any — a single unit
  // for spacing purposes (gap between whole threads, not between every
  // individual row).
  commentThread: {
    gap: Spacing.md,
  },
  // Indents a reply under its parent comment, roughly under where the
  // parent's own avatar ends — same avatar-then-body layout as a
  // top-level comment, just narrower.
  replyRow: {
    marginLeft: 40,
  },
  commentRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  commentBody: {
    flex: 1,
    gap: 2,
  },
  commentHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  commentAuthorLink: {
    flexShrink: 1,
  },
  commentAuthor: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
  },
  youBadge: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 1,
  },
  youText: {
    color: Colors.accent,
    fontSize: 9,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  commentTime: {
    color: Colors.textSecondary,
    fontSize: 11,
  },
  commentText: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 19,
  },
  // Like/Dislike sit inline with the timestamp, same row, under the
  // comment text — Delete/Report are reached via long-press instead (see
  // the Pressable wrapping each comment row above), so there's no longer
  // a separate right-edge actions column.
  commentFooterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 4,
  },
  commentFooterLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  replyLink: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
  },
  reactionColumn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  reactionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  reactionCount: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  reactionCountActive: {
    color: Colors.accent,
  },
  replyingToRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg,
    paddingTop: 6,
    backgroundColor: Colors.background,
  },
  replyingToText: {
    color: Colors.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingTop: 4,
    paddingBottom: 4,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  composerInput: {
    flex: 1,
    // On web, react-native-web renders a multiline TextInput as a real
    // <textarea>, which always top-aligns its own content regardless of
    // textAlignVertical (RNW's TextInput doesn't implement that prop at
    // all — verified against its own source). The only reliable
    // cross-platform way to make single-line text LOOK vertically
    // centered is to leave no spare height for it to top-align into:
    // minHeight here is exactly lineHeight + (paddingVertical * 2), not a
    // rounder number with slack.
    minHeight: 36,
    maxHeight: 88,
    lineHeight: 20,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    color: Colors.text,
    fontSize: 15,
    paddingHorizontal: Spacing.md,
    paddingVertical: 8,
    textAlignVertical: 'center',
  },
  sendButton: {
    width: 36,
    height: 36,
    borderRadius: Radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
});
