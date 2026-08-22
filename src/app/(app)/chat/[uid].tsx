import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { OptionsMenu, type OptionsMenuOption } from '@/components/OptionsMenu';
import { ReportModal } from '@/components/ReportModal';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { blockUser, isUserBlocked, unblockUser } from '@/services/blocks';
import { getConversationId, markConversationRead, sendMessage, subscribeToMessages } from '@/services/messages';
import { fetchPublicProfile } from '@/services/publicProfile';
import { MESSAGE_BODY_MAX_LENGTH, type Message } from '@/types/message';
import type { PublicProfile } from '@/types/social';
import { formatTimePill } from '@/utils/timeFormat';

type ProfileStatus = 'loading' | 'loaded' | 'error';

export default function ChatScreen() {
  const { uid: otherUid } = useLocalSearchParams<{ uid: string }>();
  const { user } = useAuth();
  const currentUid = user?.uid ?? null;

  const [profileStatus, setProfileStatus] = useState<ProfileStatus>('loading');
  const [otherProfile, setOtherProfile] = useState<PublicProfile | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Safety state — see src/services/blocks.ts. Only ever reflects the
  // CURRENT user's own outgoing block (readable); whether the other
  // person has blocked ME is never exposed to this client — a failed
  // send just surfaces the generic "Messaging is unavailable." below.
  const [amIBlockingThem, setAmIBlockingThem] = useState(false);
  const [isBlockSubmitting, setIsBlockSubmitting] = useState(false);
  const [isOptionsMenuOpen, setIsOptionsMenuOpen] = useState(false);
  const [isBlockConfirmOpen, setIsBlockConfirmOpen] = useState(false);
  const [reportTarget, setReportTarget] = useState<{ type: 'user' } | { type: 'message'; conversationId: string; messageId: string } | null>(
    null
  );

  const scrollRef = useRef<ScrollView>(null);

  const conversationId = useMemo(
    () => (currentUid ? getConversationId(currentUid, otherUid) : null),
    [currentUid, otherUid]
  );

  const loadSafetyState = useCallback(async () => {
    if (!currentUid) return;
    const blocked = await isUserBlocked(currentUid, otherUid);
    setAmIBlockingThem(blocked);
  }, [currentUid, otherUid]);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets loading state when the route's uid param changes; the initial mount already starts as 'loading'.
    setProfileStatus('loading');
    fetchPublicProfile(otherUid).then((profile) => {
      if (cancelled) return;
      setOtherProfile(profile);
      setProfileStatus(profile ? 'loaded' : 'error');
    });
    loadSafetyState();
    return () => {
      cancelled = true;
    };
  }, [otherUid, loadSafetyState]);

  // The one realtime listener in this app — scoped to this single
  // conversation's latest messages, mounted only while this screen is on
  // screen. Doubles as the initial load (fires immediately with the
  // current snapshot) and the live-update path (fires again on every new
  // message) — see src/services/messages.ts.
  useEffect(() => {
    if (!currentUid || !conversationId) return;

    markConversationRead(conversationId, currentUid).catch(() => {});

    const unsubscribe = subscribeToMessages(conversationId, (nextMessages) => {
      setMessages(nextMessages);
      setMessagesLoaded(true);
      const latest = nextMessages[nextMessages.length - 1];
      if (latest && latest.senderUid !== currentUid) {
        // A new message just arrived from the other person while this
        // screen is open — markConversationRead reads-before-writing, so
        // this is a no-op once the count is already back at 0.
        markConversationRead(conversationId, currentUid).catch(() => {});
      }
    });

    return unsubscribe;
  }, [conversationId, currentUid]);

  const handleSend = useCallback(async () => {
    if (!currentUid || isSending) return;
    const text = composerText;
    if (text.trim().length === 0) return;
    setIsSending(true);
    setSendError(null);
    const result = await sendMessage(currentUid, otherUid, text);
    setIsSending(false);
    if (!result.ok) {
      setSendError(result.message);
      return;
    }
    setComposerText('');
  }, [currentUid, otherUid, composerText, isSending]);

  const handleConfirmBlock = async () => {
    if (!currentUid || isBlockSubmitting) return;
    setIsBlockSubmitting(true);
    const result = await blockUser(currentUid, otherUid);
    setIsBlockSubmitting(false);
    setIsBlockConfirmOpen(false);
    if (result.ok) {
      setAmIBlockingThem(true);
    }
  };

  const handleUnblock = async () => {
    if (!currentUid || isBlockSubmitting) return;
    setIsBlockSubmitting(true);
    const result = await unblockUser(currentUid, otherUid);
    setIsBlockSubmitting(false);
    if (result.ok) {
      setAmIBlockingThem(false);
    }
  };

  const canSend = !amIBlockingThem && composerText.trim().length > 0 && composerText.length <= MESSAGE_BODY_MAX_LENGTH && !isSending;

  const optionsMenuOptions: OptionsMenuOption[] = amIBlockingThem
    ? [{ label: `Unblock ${otherProfile?.displayName ?? 'this user'}`, onPress: handleUnblock }]
    : [
        { label: `Block ${otherProfile?.displayName ?? 'this user'}`, onPress: () => setIsBlockConfirmOpen(true), destructive: true },
        { label: 'Report user', onPress: () => setReportTarget({ type: 'user' }) },
      ];

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back" style={styles.backButton}>
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        {profileStatus === 'loaded' && otherProfile ? (
          <Pressable
            onPress={() => router.push(`/user/${otherUid}`)}
            style={styles.headerIdentity}
            accessibilityRole="button"
            accessibilityLabel={`View ${otherProfile.displayName}'s profile`}
          >
            <Avatar name={otherProfile.displayName} size={32} />
            <View>
              <Text style={styles.headerName} numberOfLines={1}>
                {otherProfile.displayName}
              </Text>
              <Text style={styles.headerUsername} numberOfLines={1}>
                @{otherProfile.username}
              </Text>
            </View>
          </Pressable>
        ) : (
          <View style={styles.headerIdentity}>
            <Text style={styles.headerName}>{profileStatus === 'error' ? "Couldn't load profile" : 'Loading…'}</Text>
          </View>
        )}
        <Pressable
          onPress={() => setIsOptionsMenuOpen(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="More options"
          style={styles.overflowButton}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={Colors.textSecondary} />
        </Pressable>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={styles.messagesContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
          keyboardShouldPersistTaps="handled"
        >
          {messagesLoaded && messages.length === 0 ? (
            <View style={styles.emptyPanel}>
              <Ionicons name="chatbubble-ellipses-outline" size={28} color={Colors.textSecondary} />
              <Text style={styles.emptyText}>
                Start a conversation with {otherProfile?.displayName ?? 'this person'}.
              </Text>
            </View>
          ) : (
            messages.map((message) => {
              const isMine = message.senderUid === currentUid;
              return (
                <View key={message.messageId} style={[styles.messageRow, isMine && styles.messageRowMine]}>
                  {!isMine ? (
                    <Pressable
                      onPress={() =>
                        conversationId && setReportTarget({ type: 'message', conversationId, messageId: message.messageId })
                      }
                      hitSlop={8}
                      style={styles.reportButton}
                      accessibilityRole="button"
                      accessibilityLabel="Message options"
                    >
                      <Ionicons name="ellipsis-vertical" size={14} color={Colors.textSecondary} />
                    </Pressable>
                  ) : null}
                  <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                    <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{message.body}</Text>
                    <Text style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
                      {formatTimePill(message.createdAt.toDate())}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>

        {sendError ? <Text style={styles.sendError}>{sendError}</Text> : null}

        {amIBlockingThem ? (
          <View style={styles.blockedBar}>
            <Text style={styles.blockedBarText}>You blocked this user.</Text>
            <Button label="Unblock" variant="secondary" onPress={handleUnblock} loading={isBlockSubmitting} />
          </View>
        ) : (
          <View style={styles.composerRow}>
            <TextInput
              style={styles.composerInput}
              value={composerText}
              onChangeText={setComposerText}
              placeholder="Message…"
              placeholderTextColor={Colors.textSecondary}
              multiline
              maxLength={MESSAGE_BODY_MAX_LENGTH}
            />
            <View style={styles.sendButtonWrap}>
              <Button label="Send" onPress={handleSend} disabled={!canSend} loading={isSending} />
            </View>
          </View>
        )}
      </KeyboardAvoidingView>

      <OptionsMenu visible={isOptionsMenuOpen} onClose={() => setIsOptionsMenuOpen(false)} options={optionsMenuOptions} />

      <ConfirmDialog
        visible={isBlockConfirmOpen}
        title={`Block ${otherProfile?.displayName ?? 'this user'}?`}
        message="They won't be able to follow, like or comment on your content, or message you while blocked."
        confirmLabel="Block"
        isSubmitting={isBlockSubmitting}
        onConfirm={handleConfirmBlock}
        onCancel={() => setIsBlockConfirmOpen(false)}
      />

      {currentUid && reportTarget ? (
        <ReportModal
          visible={!!reportTarget}
          onClose={() => setReportTarget(null)}
          reporterUid={currentUid}
          target={reportTarget.type === 'user' ? { type: 'user', targetUid: otherUid } : reportTarget}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIdentity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  headerName: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
  },
  headerUsername: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  overflowButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  messagesContent: {
    flexGrow: 1,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
  },
  emptyPanel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.xxl,
  },
  emptyText: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    justifyContent: 'flex-start',
  },
  messageRowMine: {
    justifyContent: 'flex-end',
  },
  reportButton: {
    padding: 4,
  },
  bubble: {
    maxWidth: '78%',
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
    gap: 2,
  },
  bubbleTheirs: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderBottomLeftRadius: 4,
  },
  bubbleMine: {
    backgroundColor: Colors.accent,
    borderBottomRightRadius: 4,
  },
  bubbleText: {
    color: Colors.text,
    fontSize: 15,
    lineHeight: 20,
  },
  bubbleTextMine: {
    color: Colors.background,
  },
  bubbleTime: {
    color: Colors.textSecondary,
    fontSize: 11,
    alignSelf: 'flex-end',
  },
  bubbleTimeMine: {
    color: 'rgba(11, 11, 15, 0.6)',
  },
  sendError: {
    color: Colors.error,
    fontSize: 12,
    textAlign: 'center',
    paddingBottom: Spacing.xs,
  },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    fontSize: 15,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  sendButtonWrap: {
    width: 84,
  },
  blockedBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  blockedBarText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 13,
  },
});
