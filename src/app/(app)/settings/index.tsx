import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ErrorState } from '@/components/ErrorState';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { LoadingState } from '@/components/LoadingState';
import { SettingsRow } from '@/components/SettingsRow';
import { SettingsSection } from '@/components/SettingsSection';
import { Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchMyNewMessagesFrom } from '@/services/privacySettings';
import { NEW_MESSAGES_FROM_OPTIONS } from '@/types/privacy';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Settings home (Step 27) — real rows only. There is deliberately no
 * Account section: the only candidate row (Edit profile) has no real
 * route/backend yet, and a dead row is worse than an absent one (see
 * README "Settings — real rows only"). No Notifications section (no
 * preference backend or push system exists) and no Content & Reels
 * section (no real per-account content preferences exist) — both
 * intentionally omitted rather than rendered as inert toggles.
 */
export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [messagePrivacyLabel, setMessagePrivacyLabel] = useState('');
  const [blockedCount, setBlockedCount] = useState(0);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setStatus('loading');
    try {
      const [newMessagesFrom, blockedUids] = await Promise.all([fetchMyNewMessagesFrom(user.uid), fetchMyBlockedUserIds(user.uid)]);
      setMessagePrivacyLabel(NEW_MESSAGES_FROM_OPTIONS.find((option) => option.id === newMessagesFrom)?.label ?? '');
      setBlockedCount(blockedUids.length);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } catch {
      setIsSigningOut(false);
    }
  };

  return (
    <HeaderScreenLayout title="Settings">
      {status === 'error' ? (
        <ErrorState title="Couldn't load your settings" onRetry={load} />
      ) : status === 'loading' ? (
        <LoadingState size="large" />
      ) : (
        <View style={styles.container}>
          <SettingsSection title="Privacy">
            <SettingsRow
              icon="chatbubble-outline"
              label="Message privacy"
              value={messagePrivacyLabel}
              onPress={() => router.push('/settings/privacy')}
            />
            <SettingsRow
              icon="ban-outline"
              label="Blocked accounts"
              value={blockedCount > 0 ? String(blockedCount) : undefined}
              onPress={() => router.push('/settings/privacy')}
            />
          </SettingsSection>

          <SettingsSection title="Session">
            <SettingsRow
              icon="log-out-outline"
              label="Log out"
              onPress={handleSignOut}
              destructive
              showChevron={false}
              loading={isSigningOut}
            />
          </SettingsSection>
        </View>
      )}
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: Spacing.xl,
  },
});
