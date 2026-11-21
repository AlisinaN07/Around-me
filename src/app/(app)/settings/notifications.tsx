/**
 * Settings -> Notifications (Step 3E). This screen only ever shows the
 * CURRENT OS permission status and, when permission is granted, whether
 * THIS device has a real registration record — it never claims that
 * notifications can actually be delivered, because no send-side
 * implementation exists yet (see src/services/pushTokens.ts's own top
 * doc comment). The OS permission prompt is only ever triggered by the
 * explicit "Turn on notifications" button below — never automatically,
 * matching requestPushPermissionAndRegister's own contract.
 */
import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { ensurePushTokenRegistered, getNotificationPermissionStatus, requestPushPermissionAndRegister } from '@/services/pushTokens';

type ScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'undetermined' }
  | { kind: 'denied' }
  | { kind: 'granted'; deviceReady: boolean };

export default function NotificationSettingsScreen() {
  const { user } = useAuth();
  const [state, setState] = useState<ScreenState>({ kind: 'loading' });
  const [isWorking, setIsWorking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const permission = await getNotificationPermissionStatus();
    if (!permission.supported) {
      setState({ kind: 'unsupported' });
      return;
    }
    if (permission.status === 'granted') {
      // Silent — never prompts; just confirms this device's own
      // registration is actually up to date (permission may have been
      // granted in an earlier session, or changed from the OS Settings
      // app directly while this app wasn't running).
      const registration = user ? await ensurePushTokenRegistered(user.uid) : null;
      const deviceReady = registration !== null && registration.ok && registration.action !== 'skipped';
      setState({ kind: 'granted', deviceReady });
      return;
    }
    setState({ kind: permission.status === 'denied' ? 'denied' : 'undetermined' });
  }, [user]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleEnable = async () => {
    if (!user || isWorking) return;
    setIsWorking(true);
    setErrorMessage(null);
    const result = await requestPushPermissionAndRegister(user.uid);
    setIsWorking(false);

    if ('action' in result) {
      // unsupported platform — see currentPlatform's own doc comment.
      setState({ kind: 'unsupported' });
      return;
    }
    if (result.status !== 'granted') {
      setState({ kind: result.status });
      return;
    }
    const deviceReady = result.registration.ok && result.registration.action !== 'skipped';
    if (!deviceReady) {
      setErrorMessage("Permission granted, but we couldn't finish setting up this device. Try again.");
    }
    setState({ kind: 'granted', deviceReady });
  };

  const handleOpenSettings = () => {
    Linking.openSettings();
  };

  return (
    <HeaderScreenLayout title="Notifications">
      {state.kind === 'loading' ? (
        <Text style={styles.mutedText}>Loading…</Text>
      ) : state.kind === 'unsupported' ? (
        <View style={styles.block}>
          <Text style={styles.title}>Not available here</Text>
          <Text style={styles.body}>Push notifications aren&apos;t supported in this environment.</Text>
        </View>
      ) : (
        <View style={styles.block}>
          <View style={styles.statusRow}>
            <Ionicons
              name={state.kind === 'granted' ? 'notifications' : 'notifications-off-outline'}
              size={22}
              color={state.kind === 'granted' ? Colors.accent : Colors.textSecondary}
            />
            <Text style={styles.statusLabel}>
              {state.kind === 'granted'
                ? 'Notifications are turned on'
                : state.kind === 'denied'
                  ? 'Notifications are turned off'
                  : "Notifications aren't turned on yet"}
            </Text>
          </View>

          {state.kind === 'undetermined' ? (
            <>
              <Text style={styles.body}>Turn on notifications to register this device with Around Me. Your device will ask you to confirm.</Text>
              <Button label="Turn on notifications" onPress={handleEnable} loading={isWorking} />
            </>
          ) : null}

          {state.kind === 'denied' ? (
            <>
              <Text style={styles.body}>
                You previously declined notifications for Around Me. We won&apos;t ask again automatically — you can turn them on anytime
                from your device&apos;s own Settings app.
              </Text>
              <Button label="Open device settings" variant="secondary" onPress={handleOpenSettings} />
            </>
          ) : null}

          {state.kind === 'granted' ? (
            <Text style={styles.body}>
              {state.deviceReady
                ? "This device is registered. We don't send any notifications yet — this only prepares your device for when we do."
                : "Permission is on, but this device isn't fully registered yet."}
            </Text>
          ) : null}

          {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
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
  block: {
    gap: Spacing.lg,
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  statusLabel: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    flexShrink: 1,
  },
  title: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '800',
  },
  body: {
    color: Colors.textSecondary,
    fontSize: 14,
    lineHeight: 20,
  },
  error: {
    color: Colors.error,
    fontSize: 13,
  },
});
