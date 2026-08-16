import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { FormScreenLayout } from '@/components/FormScreenLayout';
import { OnboardingProgress } from '@/components/OnboardingProgress';
import { Colors, Spacing } from '@/constants/theme';
import { useOnboardingDraft } from '@/providers/OnboardingDraftProvider';
import { checkUsernameAvailability } from '@/services/userProfile';
import { normalizeUsername } from '@/utils/username';

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 50;
const AVAILABILITY_DEBOUNCE_MS = 600;

type CheckResult = { username: string; status: 'available' | 'taken'; reason?: string };

export default function NameUsernameScreen() {
  const { draft, setNameAndUsername } = useOnboardingDraft();
  const [displayName, setDisplayName] = useState(draft.displayName);
  const [username, setUsername] = useState(draft.username);
  const [nameError, setNameError] = useState<string | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);

  // Availability check only runs for the async result — the idle/invalid/
  // checking states are all derived at render time below, so nothing here
  // ever calls setState synchronously from the effect body itself.
  useEffect(() => {
    if (!normalizeUsername(username).valid) {
      return;
    }

    let cancelled = false;
    const timeout = setTimeout(async () => {
      const result = await checkUsernameAvailability(username);
      if (cancelled) return;
      setCheckResult({
        username,
        status: result.available ? 'available' : 'taken',
        reason: result.available ? undefined : result.reason,
      });
    }, AVAILABILITY_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [username]);

  const normalized = normalizeUsername(username);

  let availability: 'idle' | 'invalid' | 'checking' | 'available' | 'taken';
  let usernameMessage: string | null;

  if (!username) {
    availability = 'idle';
    usernameMessage = null;
  } else if (!normalized.valid) {
    availability = 'invalid';
    usernameMessage = normalized.reason;
  } else if (checkResult?.username === username) {
    availability = checkResult.status;
    usernameMessage = checkResult.status === 'available' ? 'Available' : (checkResult.reason ?? 'Username already taken');
  } else {
    availability = 'checking';
    usernameMessage = 'Checking…';
  }

  const handleContinue = () => {
    const trimmedName = displayName.trim();
    if (trimmedName.length < MIN_NAME_LENGTH || trimmedName.length > MAX_NAME_LENGTH) {
      setNameError(`Enter a name between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters.`);
      return;
    }
    setNameError(null);

    if (availability !== 'available') {
      return;
    }

    setNameAndUsername(trimmedName, username.trim());
    router.push('/city');
  };

  const canContinue = availability === 'available' && displayName.trim().length >= MIN_NAME_LENGTH;

  return (
    <FormScreenLayout>
      <OnboardingProgress step={1} total={3} />

      <View style={styles.header}>
        <Text style={styles.title}>What should people call you?</Text>
      </View>

      <View style={styles.form}>
        <FormField
          label="Name"
          value={displayName}
          onChangeText={(value) => {
            setDisplayName(value);
            setNameError(null);
          }}
          placeholder="Ali"
          autoCapitalize="words"
          autoCorrect={false}
          returnKeyType="next"
          error={nameError ?? undefined}
        />
        <FormField
          label="Username"
          prefix="@"
          value={username}
          onChangeText={(value) => setUsername(value.trim())}
          placeholder="ali97"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={handleContinue}
          error={availability === 'invalid' || availability === 'taken' ? (usernameMessage ?? undefined) : undefined}
        />
        {availability === 'checking' || availability === 'available' ? (
          <Text style={availability === 'available' ? styles.available : styles.checking}>{usernameMessage}</Text>
        ) : null}
      </View>

      <View style={styles.actions}>
        <Button label="Continue" onPress={handleContinue} disabled={!canContinue} />
      </View>
    </FormScreenLayout>
  );
}

const styles = StyleSheet.create({
  header: {
    marginTop: Spacing.lg,
    marginBottom: Spacing.lg,
  },
  title: {
    color: Colors.text,
    fontSize: 26,
    fontWeight: '800',
  },
  form: {
    gap: Spacing.md,
  },
  checking: {
    color: Colors.textSecondary,
    fontSize: 13,
    marginTop: -Spacing.xs,
  },
  available: {
    color: Colors.success,
    fontSize: 13,
    marginTop: -Spacing.xs,
  },
  actions: {
    marginTop: Spacing.xl,
  },
});
