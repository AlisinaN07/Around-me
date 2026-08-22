import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchMyBlockedUserIds, unblockUser } from '@/services/blocks';
import { fetchMyNewMessagesFrom, setNewMessagesFrom } from '@/services/privacySettings';
import { fetchPublicProfile } from '@/services/publicProfile';
import { NEW_MESSAGES_FROM_OPTIONS, type NewMessagesFrom } from '@/types/privacy';
import type { PublicProfile } from '@/types/social';

type LoadStatus = 'loading' | 'loaded' | 'error';

type BlockedEntry = { uid: string; profile: PublicProfile | null };

export default function PrivacySettingsScreen() {
  const { user } = useAuth();

  const [status, setStatus] = useState<LoadStatus>('loading');
  const [newMessagesFrom, setNewMessagesFromState] = useState<NewMessagesFrom>('everyone');
  const [isSavingPrivacy, setIsSavingPrivacy] = useState(false);
  const [blocked, setBlocked] = useState<BlockedEntry[]>([]);
  const [unblockingUid, setUnblockingUid] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    try {
      const [currentSetting, blockedUids] = await Promise.all([fetchMyNewMessagesFrom(user.uid), fetchMyBlockedUserIds(user.uid)]);
      const profiles = await Promise.all(blockedUids.map((uid) => fetchPublicProfile(uid)));
      setNewMessagesFromState(currentSetting);
      setBlocked(blockedUids.map((uid, index) => ({ uid, profile: profiles[index] ?? null })));
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleSelectPrivacy = async (value: NewMessagesFrom) => {
    if (!user || isSavingPrivacy || value === newMessagesFrom) return;
    setIsSavingPrivacy(true);
    const previous = newMessagesFrom;
    setNewMessagesFromState(value);
    const result = await setNewMessagesFrom(user.uid, value);
    setIsSavingPrivacy(false);
    if (!result.ok) {
      setNewMessagesFromState(previous);
    }
  };

  const handleUnblock = async (targetUid: string) => {
    if (!user || unblockingUid) return;
    setUnblockingUid(targetUid);
    const result = await unblockUser(user.uid, targetUid);
    setUnblockingUid(null);
    if (result.ok) {
      setBlocked((prev) => prev.filter((entry) => entry.uid !== targetUid));
    }
  };

  return (
    <HeaderScreenLayout title="Privacy & safety">
      {status === 'loading' ? (
        <Text style={styles.mutedText}>Loading…</Text>
      ) : status === 'error' ? (
        <Text style={styles.errorText}>Couldn&apos;t load your privacy settings.</Text>
      ) : (
        <View style={styles.container}>
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Message privacy</Text>
            <Text style={styles.sectionSubtitle}>Who can start a new conversation with you?</Text>
            <View style={styles.optionList}>
              {NEW_MESSAGES_FROM_OPTIONS.map((option, index) => {
                const selected = option.id === newMessagesFrom;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => handleSelectPrivacy(option.id)}
                    style={[styles.optionRow, index > 0 && styles.rowBorderTop]}
                    disabled={isSavingPrivacy}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                  >
                    <Ionicons
                      name={selected ? 'radio-button-on' : 'radio-button-off'}
                      size={18}
                      color={selected ? Colors.accent : Colors.textSecondary}
                    />
                    <Text style={styles.optionText}>{option.label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.sectionNote}>
              This only affects new conversations. It never ends an existing one — block someone to stop them from messaging you.
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Blocked users</Text>
            {blocked.length === 0 ? (
              <Text style={styles.sectionSubtitle}>You haven&apos;t blocked anyone.</Text>
            ) : (
              <View style={styles.blockedList}>
                {blocked.map((entry, index) => (
                  <View key={entry.uid} style={[styles.blockedRow, index > 0 && styles.rowBorderTop]}>
                    <Avatar name={entry.profile?.displayName ?? 'Unknown user'} size={40} />
                    <View style={styles.blockedIdentity}>
                      <Text style={styles.blockedName} numberOfLines={1}>
                        {entry.profile?.displayName ?? 'Unknown user'}
                      </Text>
                      {entry.profile ? (
                        <Text style={styles.blockedUsername} numberOfLines={1}>
                          @{entry.profile.username}
                        </Text>
                      ) : null}
                    </View>
                    {unblockingUid === entry.uid ? (
                      <ActivityIndicator color={Colors.textSecondary} size="small" />
                    ) : (
                      <Pressable onPress={() => handleUnblock(entry.uid)} hitSlop={8} accessibilityRole="button">
                        <Text style={styles.unblockText}>Unblock</Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  mutedText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  errorText: {
    color: Colors.error,
    fontSize: 14,
  },
  container: {
    gap: Spacing.xl,
  },
  section: {
    gap: Spacing.sm,
  },
  sectionTitle: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  sectionSubtitle: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  sectionNote: {
    color: Colors.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  optionList: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  rowBorderTop: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  optionText: {
    color: Colors.text,
    fontSize: 15,
  },
  blockedList: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  blockedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.md,
  },
  blockedIdentity: {
    flex: 1,
    gap: 1,
  },
  blockedName: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  blockedUsername: {
    color: Colors.textSecondary,
    fontSize: 12,
  },
  unblockText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '700',
  },
});
