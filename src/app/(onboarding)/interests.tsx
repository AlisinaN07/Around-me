import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { OnboardingProgress } from '@/components/OnboardingProgress';
import { INTERESTS, MAX_INTERESTS, MIN_INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
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

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      }
      if (prev.length >= MAX_INTERESTS) {
        return prev;
      }
      return [...prev, id];
    });
  };

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

        <View style={styles.grid}>
          {INTERESTS.map((interest) => {
            const isSelected = selected.includes(interest.id);
            return (
              <Pressable
                key={interest.id}
                onPress={() => toggle(interest.id)}
                style={[styles.chip, isSelected && styles.chipSelected]}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
              >
                <Text style={styles.chipEmoji}>{interest.emoji}</Text>
                <Text style={[styles.chipLabel, isSelected && styles.chipLabelSelected]}>{interest.label}</Text>
              </Pressable>
            );
          })}
        </View>

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
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.full,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  chipSelected: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accent,
  },
  chipEmoji: {
    fontSize: 16,
  },
  chipLabel: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  chipLabelSelected: {
    color: Colors.background,
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
