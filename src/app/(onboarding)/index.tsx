import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { OnboardingProgress } from '@/components/OnboardingProgress';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useOnboardingDraft } from '@/providers/OnboardingDraftProvider';
import type { AccountType } from '@/types/user';

type OptionConfig = {
  id: AccountType;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
};

// Copy deliberately doesn't imply verification, and Business isn't
// labeled "Official" anywhere — see README "Personal and Business
// accounts" (Step 30). Business = Personal + the ability to create
// Events; nothing else differs yet.
const OPTIONS: OptionConfig[] = [
  {
    id: 'personal',
    icon: 'person-outline',
    title: 'Personal',
    description: 'For people who want to discover their city, share posts and connect locally.',
  },
  {
    id: 'business',
    icon: 'storefront-outline',
    title: 'Business',
    description: 'For businesses, venues and organizers that also want to publish Events.',
  },
];

/**
 * Account type selection — the new first onboarding screen (Step 30).
 * Chosen once here, persisted as `users/{uid}.accountType` at the end of
 * onboarding (see interests.tsx), and immutable afterward (no update rule
 * permits changing it — see firestore.rules). Both account types continue
 * through the exact same name/city/interests steps after this one.
 */
export default function AccountTypeScreen() {
  const { draft, setAccountType } = useOnboardingDraft();
  const [selected, setSelected] = useState<AccountType | null>(draft.accountType);

  const handleContinue = () => {
    if (!selected) return;
    setAccountType(selected);
    router.push('/name');
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <OnboardingProgress step={1} total={4} />

        <View style={styles.header}>
          <Text style={styles.title}>How will you use Around Me?</Text>
          <Text style={styles.subtitle}>You can&apos;t change this later, so pick the one that fits.</Text>
        </View>

        <View style={styles.options}>
          {OPTIONS.map((option) => {
            const isSelected = selected === option.id;
            return (
              <Pressable
                key={option.id}
                onPress={() => setSelected(option.id)}
                style={[styles.card, isSelected && styles.cardSelected]}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
              >
                <View style={[styles.iconWrap, isSelected && styles.iconWrapSelected]}>
                  <Ionicons name={option.icon} size={24} color={isSelected ? Colors.background : Colors.accent} />
                </View>
                <View style={styles.cardText}>
                  <Text style={styles.cardTitle}>{option.title}</Text>
                  <Text style={styles.cardDescription}>{option.description}</Text>
                </View>
                <Ionicons
                  name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                  size={22}
                  color={isSelected ? Colors.accent : Colors.textSecondary}
                />
              </Pressable>
            );
          })}
        </View>

        <View style={styles.actions}>
          <Button label="Continue" onPress={handleContinue} disabled={!selected} />
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
    gap: Spacing.xl,
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
  options: {
    gap: Spacing.md,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  cardSelected: {
    borderColor: Colors.accent,
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
  },
  iconWrapSelected: {
    backgroundColor: Colors.accent,
  },
  cardText: {
    flex: 1,
    gap: 2,
  },
  cardTitle: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '700',
  },
  cardDescription: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  actions: {
    marginTop: 'auto',
  },
});
