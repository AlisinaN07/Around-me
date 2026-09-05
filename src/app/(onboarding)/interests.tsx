import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { InterestSelector } from '@/components/InterestSelector';
import { OnboardingProgress } from '@/components/OnboardingProgress';
import { MIN_INTERESTS } from '@/constants/interests';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useOnboardingDraft } from '@/providers/OnboardingDraftProvider';
import { createInitialUserProfile } from '@/services/userProfile';

export default function InterestsScreen() {
  const { draft, setInterests } = useOnboardingDraft();
  const { user } = useAuth();
  const { refreshProfile } = useProfile();
  const [selected, setSelected] = useState<string[]>(draft.interests);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canContinue = selected.length >= MIN_INTERESTS && !isSubmitting;

  const handleSubmit = async () => {
    if (!canContinue || !user) {
      return;
    }

    setInterests(selected);
    setIsSubmitting(true);
    setError(null);

    const result = await createInitialUserProfile({
      uid: user.uid,
      email: user.email ?? '',
      // Chosen on the first onboarding screen (Step 30) — falls back to
      // 'personal' only if the in-memory draft was somehow lost (e.g. the
      // app was killed mid-onboarding and this screen was reached without
      // walking through the earlier steps again), never left null.
      accountType: draft.accountType ?? 'personal',
      displayName: draft.displayName,
      username: draft.username,
      cityName: draft.cityName,
      countryCode: draft.countryCode,
      interests: selected,
    });

    setIsSubmitting(false);

    if (result.ok) {
      // Protected routing exposes (app) automatically once the profile
      // (with onboardingCompleted: true) is picked up here.
      await refreshProfile();
      return;
    }

    if (result.error === 'profile-exists') {
      // Race/reload: a profile already exists — don't overwrite it, just
      // refresh so routing can safely take over.
      await refreshProfile();
      return;
    }

    if (result.error === 'username-taken') {
      setError('That username was just taken by someone else. Choose another to continue.');
      router.replace('/name');
      return;
    }

    setError(result.message);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <OnboardingProgress step={4} total={4} />

        <View style={styles.header}>
          <Text style={styles.title}>What are you into?</Text>
          <Text style={styles.subtitle}>
            Choose at least {MIN_INTERESTS} so Around Me can show you better local content.
          </Text>
        </View>

        <InterestSelector value={selected} onChange={setSelected} />

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.actions}>
          <Button label="Start exploring" onPress={handleSubmit} disabled={!canContinue} loading={isSubmitting} />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  content: {
    flex: 1,
    padding: Spacing.xl,
    gap: Spacing.lg,
  },
  header: {
    gap: Spacing.xs,
  },
  title: {
    color: Colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
  error: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  actions: {
    marginTop: 'auto',
  },
});
