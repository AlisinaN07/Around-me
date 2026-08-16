import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { AuthProvider } from '@/providers/AuthProvider';
import { ProfileProvider } from '@/providers/ProfileProvider';

SystemUI.setBackgroundColorAsync(Colors.background);
SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  return (
    <AuthProvider>
      <ProfileProvider>
        <StatusBar style="light" />
        <RootNavigator />
      </ProfileProvider>
    </AuthProvider>
  );
}

function RootNavigator() {
  const { isLoading: isAuthLoading, isAuthenticated } = useAuth();
  const { isProfileLoading, hasCompletedOnboarding, profileError, refreshProfile } = useProfile();

  const isWaitingOnSession = isAuthLoading || (isAuthenticated && isProfileLoading);

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

  if (isAuthenticated && profileError) {
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
      <Stack.Protected guard={isAuthenticated && hasCompletedOnboarding}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
      <Stack.Protected guard={isAuthenticated && !hasCompletedOnboarding}>
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
