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
import { useProfile } from '@/hooks/useProfile';
import { fetchMyBlockedUserIds } from '@/services/blocks';
import { fetchMyNewMessagesFrom } from '@/services/privacySettings';
import { NEW_MESSAGES_FROM_OPTIONS } from '@/types/privacy';
import { isBusinessAccount } from '@/utils/accountCapabilities';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Settings home (Step 27; Account section added Step 33) — real rows only.
 * Edit profile now has a real route/backend (src/app/(app)/profile/edit.tsx),
 * so it's a real row, not a dead one (see README "Settings — real rows
 * only"). No Notifications section (no preference backend or push system
 * exists) and no Content & Reels section (no real per-account content
 * preferences exist) — both intentionally omitted rather than rendered as
 * inert toggles.
 */
export default function SettingsScreen() {
  const { user, signOut } = useAuth();
  const { profile } = useProfile();
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
          <SettingsSection title="Account">
            <SettingsRow icon="person-outline" label="Edit profile" onPress={() => router.push('/profile/edit')} />
            {/* Step 35 — only shown for a Personal account: the switch is
                one-way, so once an account is already Business there is
                nothing further to offer here (see settings/index.tsx's own
                "real rows only" note at the top of this file). */}
            {!isBusinessAccount(profile) ? (
              <SettingsRow
                icon="briefcase-outline"
                label="Switch to Business account"
                onPress={() => router.push('/settings/business-account')}
              />
            ) : null}
            <SettingsRow
              icon="trash-outline"
              label="Delete account"
              onPress={() => router.push('/settings/delete-account')}
              destructive
            />
          </SettingsSection>

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
