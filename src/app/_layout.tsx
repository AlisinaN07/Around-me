import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { setVideoCacheSizeAsync } from 'expo-video';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AuthProvider } from '@/providers/AuthProvider';
import { CityProvider } from '@/providers/CityProvider';
import { ProfileProvider } from '@/providers/ProfileProvider';
import { isDeletionPending } from '@/utils/deletionPending';

SystemUI.setBackgroundColorAsync(Colors.background);
SplashScreen.preventAutoHideAsync();

// Step 11A perf audit — expo-video ships its own native, persistent,
// LRU-evicted video disk cache (AVFoundation on iOS, ExoPlayer SimpleCache
// on Android — see expo-video's VideoModule.d.ts) that every
// `useCaching: true` source (see ReelFeedItem.tsx) reads from and writes
// to automatically; no new dependency, no custom eviction logic to write.
// Its documented default is 1GB, unbounded by anything this app has ever
// set — an unbounded-by-us budget on a video-heavy feed is exactly the
// "no predictable limits" failure mode this audit flagged. 300MB is a
// deliberately conservative placeholder cap (comfortably covers dozens of
// today's unoptimized Reels, and many more once Step 11B's delivery
// profile work lands and per-Reel bytes shrink) — revisit once real
// device measurements (Step 11A report, Section M) are in. Not supported
// on web (see expo-video's NativeVideoModule.web.ts, which has no
// implementation at all for this call) — guarded accordingly. Fire-and-
// forget, same convention as the two native setup calls directly above:
// a failure here only means this session keeps the native default,
// never a crash.
if (Platform.OS !== 'web') {
  setVideoCacheSizeAsync(300 * 1024 * 1024).catch(() => {
    // Best-effort only — see this call's own doc comment above.
  });
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <CityProvider>
          <StatusBar style="light" />
          <RootNavigator />
        </CityProvider>
      </ProfileProvider>
    </AuthProvider>
  );
}

function RootNavigator() {
  const { isLoading: isAuthLoading, isAuthenticated, user } = useAuth();
  const { isProfileLoading, hasCompletedOnboarding, profileError, refreshProfile } = useProfile();

  // Local-only (see src/utils/deletionPending.ts) — checked before the
  // onboarding guard below so a mid-account-deletion state (Auth still
  // signed in, users/{uid} already removed) can never be misread as "needs
  // onboarding" and routed there. Not a security boundary: the deletion
  // backend itself only ever trusts request.auth.uid.
  const [deletionPendingStatus, setDeletionPendingStatus] = useState<'checking' | 'pending' | 'clear'>('checking');

  useEffect(() => {
    if (!isAuthenticated || !user) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeletionPendingStatus('clear');
      return;
    }
    let cancelled = false;
    setDeletionPendingStatus('checking');
    isDeletionPending(user.uid).then((pending) => {
      if (!cancelled) setDeletionPendingStatus(pending ? 'pending' : 'clear');
    });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, user]);

  const isDeletionPendingForCurrentUser = deletionPendingStatus === 'pending';
  const isWaitingOnSession =
    isAuthLoading || (isAuthenticated && (isProfileLoading || deletionPendingStatus === 'checking'));

  useEffect(() => {
    if (!isWaitingOnSession) {
      SplashScreen.hideAsync();
    }
  }, [isWaitingOnSession]);

  // Native splash stays on screen until the session state is known, so we
  // never briefly render the wrong (auth) / (onboarding) / (app) group.
  if (isWaitingOnSession) {
    return null;
  }

  if (isAuthenticated && !isDeletionPendingForCurrentUser && profileError) {
    return <ProfileErrorScreen message={profileError} onRetry={refreshProfile} />;
  }

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: Colors.background },
      }}
    >
      <Stack.Protected guard={!isAuthenticated}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      <Stack.Protected guard={isAuthenticated && isDeletionPendingForCurrentUser}>
        <Stack.Screen name="deletion-recovery" />
      </Stack.Protected>
      <Stack.Protected guard={isAuthenticated && !isDeletionPendingForCurrentUser && hasCompletedOnboarding}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={isAuthenticated && !isDeletionPendingForCurrentUser && !hasCompletedOnboarding}>
        <Stack.Screen name="(onboarding)" />
      </Stack.Protected>
    </Stack>
  );
}

function ProfileErrorScreen({ message, onRetry }: { message: string; onRetry: () => Promise<void> }) {
  const [isRetrying, setIsRetrying] = useState(false);

  const handleRetry = () => {
    setIsRetrying(true);
    onRetry().finally(() => setIsRetrying(false));
  };

  return (
    <SafeAreaView style={styles.errorSafeArea}>
      <View style={styles.errorContent}>
        <Text style={styles.errorTitle}>Something went wrong</Text>
        <Text style={styles.errorMessage}>{message}</Text>
        <Button label="Try again" onPress={handleRetry} loading={isRetrying} />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  errorSafeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  errorContent: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.md,
  },
  errorTitle: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorMessage: {
    color: Colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    marginBottom: Spacing.md,
  },
});
