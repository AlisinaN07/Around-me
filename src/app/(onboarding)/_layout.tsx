import { Stack } from 'expo-router';

import { OnboardingDraftProvider } from '@/providers/OnboardingDraftProvider';

export default function OnboardingLayout() {
  return (
    <OnboardingDraftProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </OnboardingDraftProvider>
  );
}
