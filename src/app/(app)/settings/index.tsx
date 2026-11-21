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
import { removeCurrentDevicePushToken } from '@/services/pushTokens';
import { NEW_MESSAGES_FROM_OPTIONS } from '@/types/privacy';
import { isBusinessAccount } from '@/utils/accountCapabilities';

type LoadStatus = 'loading' | 'loaded' | 'error';

/**
 * Settings home (Step 27; Account section added Step 33; Notifications
 * row added Step 3E, now that a real push-token foundation exists —
 * src/app/(app)/settings/notifications.tsx). No Content & Reels section
 * (no real per-account content preferences exist) — still intentionally
 * omitted rather than rendered as an inert toggle, same "real rows only"
 * rule (see README) the Notifications row now satisfies too.
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
      // Step 3B/3C — this device's own push-token registration (if any) is
      // explicitly a per-ACCOUNT-SESSION thing, not a per-install thing: a
      // different user signing in on this same device afterward must
      // never inherit it. Must run BEFORE signOut() below, while
      // request.auth.uid still resolves to this user (the Firestore rule
      // this relies on is owner-only). Retries internally and marks a
      // durable local marker on failure for a later retry — see
      // src/services/pushTokens.ts's own doc comment — but never throws,
      // so a failure here still never blocks signing out.
      if (user) {
        await removeCurrentDevicePushToken(user.uid);
      }
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

          <SettingsSection title="Notifications">
            <SettingsRow icon="notifications-outline" label="Notifications" onPress={() => router.push('/settings/notifications')} />
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
