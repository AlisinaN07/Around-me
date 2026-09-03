import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { AuthorLink } from '@/components/AuthorLink';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import {
  addReelComment,
  deleteReelComment,
  fetchReelCommentCount,
  fetchReelComments,
  fetchReelLikeCount,
  isReelLiked,
  likeReel,
  unlikeReel,
} from '@/services/reelEngagement';
import { REEL_COMMENT_BODY_MAX_LENGTH, type ReelComment } from '@/types/reel';
import { formatTimeAgo } from '@/utils/timeFormat';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Like + Comment section for the Reel detail screen — structurally
 * parallel to EngagementSection (content Likes/Comments), wired to
 * src/services/reelEngagement.ts instead. Owns its own data — the parent
 * only needs to render <ReelEngagementSection reelId={reel.reelId} />.
 */
export function ReelEngagementSection({ reelId }: { reelId: string }) {
  const { user } = useAuth();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [isLiked, setIsLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);
  const [isLikeSubmitting, setIsLikeSubmitting] = useState(false);
  const [likeError, setLikeError] = useState<string | null>(null);

  const [comments, setComments] = useState<ReelComment[]>([]);
  const [commentCount, setCommentCount] = useState(0);
  const [commentBody, setCommentBody] = useState('');
  const [isPosting, setIsPosting] = useState(false);
  const [deletingCommentId, setDeletingCommentId] = useState<string | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);

  // load() never calls setState before its first await, so nothing runs
  // synchronously during the effect body below.
  const load = useCallback(async () => {
    try {
      const [liked, likes, commentList, commentsTotal] = await Promise.all([
        user ? isReelLiked(reelId, user.uid) : Promise.resolve(false),
        fetchReelLikeCount(reelId),
        fetchReelComments(reelId),
        fetchReelCommentCount(reelId),
      ]);
      setIsLiked(liked);
      setLikeCount(likes);
      setComments(commentList);
      setCommentCount(commentsTotal);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [reelId, user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const refreshLike = useCallback(async () => {
    const [liked, likes] = await Promise.all([user ? isReelLiked(reelId, user.uid) : Promise.resolve(false), fetchReelLikeCount(reelId)]);
    setIsLiked(liked);
    setLikeCount(likes);
  }, [reelId, user]);

  const refreshComments = useCallback(async () => {
    const [commentList, commentsTotal] = await Promise.all([fetchReelComments(reelId), fetchReelCommentCount(reelId)]);
    setComments(commentList);
    setCommentCount(commentsTotal);
  }, [reelId]);

  const handleToggleLike = async () => {
    if (!user || isLikeSubmitting) return;
    setIsLikeSubmitting(true);
    setLikeError(null);
    const result = isLiked ? await unlikeReel(reelId, user.uid) : await likeReel(reelId, user.uid);
    setIsLikeSubmitting(false);
    if (!result.ok) {
      setLikeError(result.message);
      return;
    }
    await refreshLike();
  };

  const handlePostComment = async () => {
    if (!user || isPosting) return;
    const trimmed = commentBody.trim();
    if (!trimmed) return;
    setIsPosting(true);
    setCommentError(null);
    const result = await addReelComment(reelId, user.uid, trimmed);
    setIsPosting(false);
    if (!result.ok) {
      setCommentError(result.message);
      return;
    }
    setCommentBody('');
    await refreshComments();
  };

  const handleDeleteComment = async (commentId: string) => {
    if (!user || deletingCommentId) return;
    setDeletingCommentId(commentId);
    setCommentError(null);
    const result = await deleteReelComment(reelId, commentId, user.uid);
    setDeletingCommentId(null);
    if (!result.ok) {
      setCommentError(result.message);
      return;
    }
    await refreshComments();
  };

  return (
    <View style={styles.container}>
      <View style={styles.statsRow}>
        <Pressable
          onPress={handleToggleLike}
          disabled={status !== 'loaded' || isLikeSubmitting}
          style={styles.likeButton}
          accessibilityRole="button"
          accessibilityLabel={isLiked ? 'Unlike' : 'Like'}
          accessibilityState={{ selected: isLiked }}
        >
          <Ionicons name={isLiked ? 'heart' : 'heart-outline'} size={22} color={isLiked ? Colors.accent : Colors.textSecondary} />
          <Text style={[styles.statCount, isLiked && styles.statCountLiked]}>{status === 'loaded' ? likeCount : '–'}</Text>
        </Pressable>
        <View style={styles.commentStat}>
          <Ionicons name="chatbubble-outline" size={20} color={Colors.textSecondary} />
          <Text style={styles.statCount}>{status === 'loaded' ? commentCount : '–'}</Text>
        </View>
      </View>

      {likeError ? <Text style={styles.errorText}>{likeError}</Text> : null}

      <Text style={styles.sectionTitle}>Comments</Text>

      {user && (
        <View style={styles.composerRow}>
          <TextInput
            style={styles.composerInput}
            placeholder="Add a comment..."
            placeholderTextColor={Colors.textSecondary}
            value={commentBody}
            onChangeText={setCommentBody}
            maxLength={REEL_COMMENT_BODY_MAX_LENGTH}
            multiline
            editable={!isPosting}
          />
          <Pressable
            onPress={handlePostComment}
            disabled={!commentBody.trim() || isPosting}
            style={[styles.postButton, (!commentBody.trim() || isPosting) && styles.postButtonDisabled]}
            accessibilityRole="button"
            accessibilityLabel="Post comment"
          >
            {isPosting ? <ActivityIndicator color={Colors.background} size="small" /> : <Text style={styles.postButtonLabel}>Post</Text>}
          </Pressable>
        </View>
      )}

      {commentError ? <Text style={styles.errorText}>{commentError}</Text> : null}

      {status === 'loading' ? (
        <Text style={styles.mutedText}>Loading comments…</Text>
      ) : status === 'error' ? (
        <View style={styles.errorState}>
          <Text style={styles.errorText}>Couldn&apos;t load comments.</Text>
          <Pressable onPress={load} accessibilityRole="button">
            <Text style={styles.retryLink}>Try again</Text>
          </Pressable>
        </View>
      ) : comments.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>No comments yet</Text>
          <Text style={styles.emptyBody}>Be the first to comment.</Text>
        </View>
      ) : (
        <View style={styles.commentsList}>
          {comments.map((comment) => (
            <View key={comment.commentId} style={styles.commentRow}>
              <AuthorLink uid={comment.authorUid}>
                <Avatar name={comment.authorDisplayName} size={32} />
              </AuthorLink>
              <View style={styles.commentBody}>
                <View style={styles.commentHeaderRow}>
                  <AuthorLink uid={comment.authorUid} style={styles.commentAuthorLink}>
                    <Text style={styles.commentAuthor} numberOfLines={1}>
                      {comment.authorDisplayName}
                    </Text>
                    <Text style={styles.commentUsername} numberOfLines={1}>
                      @{comment.authorUsername}
                    </Text>
                  </AuthorLink>
                  {user?.uid === comment.authorUid && (
                    <View style={styles.youBadge}>
                      <Text style={styles.youText}>You</Text>
                    </View>
                  )}
                  <Text style={styles.commentTime}>{formatTimeAgo(comment.createdAt.toDate())}</Text>
                </View>
                <Text style={styles.commentText}>{comment.body}</Text>
              </View>
              {user?.uid === comment.authorUid && (
                <Pressable
                  onPress={() => handleDeleteComment(comment.commentId)}
                  disabled={deletingCommentId === comment.commentId}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Delete comment"
                >
                  <Ionicons name="trash-outline" size={16} color={Colors.textSecondary} />
                </Pressable>
              )}
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: Spacing.lg,
    gap: Spacing.sm,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  likeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  commentStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statCount: {
    color: Colors.textSecondary,
    fontSize: 14,
    fontWeight: '700',
  },
  statCountLiked: {
    color: Colors.accent,
  },
  sectionTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    marginTop: Spacing.sm,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 96,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    color: Colors.text,
    fontSize: 15,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  postButton: {
    height: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.md,
  },
  postButtonDisabled: {
    opacity: 0.5,
  },
  postButtonLabel: {
    color: Colors.background,
    fontSize: 14,
    fontWeight: '700',
  },
  errorText: {
    color: Colors.error,
    fontSize: 13,
  },
  mutedText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  errorState: {
    gap: 4,
  },
  retryLink: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
  emptyState: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    alignItems: 'center',
    gap: 2,
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
  commentsList: {
    gap: Spacing.md,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexShrink: 1,
  },
  commentAuthor: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
  },
  commentUsername: {
    color: Colors.textSecondary,
    fontSize: 12,
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
    marginLeft: 'auto',
  },
  commentText: {
    color: Colors.text,
    fontSize: 14,
    lineHeight: 19,
  },
});
