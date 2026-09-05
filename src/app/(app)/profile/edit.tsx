import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { InterestSelector } from '@/components/InterestSelector';
import { MIN_INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { checkUsernameAvailability, updateMyProfile } from '@/services/userProfile';
import { BIO_MAX_LENGTH, DISPLAY_NAME_MAX_LENGTH, DISPLAY_NAME_MIN_LENGTH } from '@/types/user';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { normalizeUsername } from '@/utils/username';

const AVAILABILITY_DEBOUNCE_MS = 600;

type CheckResult = { username: string; status: 'available' | 'taken'; reason?: string };
type UsernameAvailability = 'idle' | 'invalid' | 'checking' | 'available' | 'taken' | 'unchanged';

/**
 * Edit Profile (Step 33) — the first real Account-editing surface. Only
 * displayName/username/bio/interests are editable; Home City and Account
 * Type are shown read-only and never sent in the update payload at all
 * (see updateMyProfile) — both are immutable by product decision, not just
 * by omission from this form.
 */
export default function EditProfileScreen() {
  const { user } = useAuth();
  const { profile, refreshProfile } = useProfile();

  const [displayName, setDisplayName] = useState(profile?.displayName ?? '');
  const [username, setUsername] = useState(profile?.username ?? '');
  const [bio, setBio] = useState(profile?.bio ?? '');
  const [interests, setInterests] = useState<string[]>(profile?.interests ?? []);

  const [nameError, setNameError] = useState<string | null>(null);
  const [interestsError, setInterestsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [checkResult, setCheckResult] = useState<CheckResult | null>(null);

  const originalUsernameLower = profile?.usernameLower ?? '';
  const normalized = normalizeUsername(username);
  // Keeping your own username unchanged never needs an availability check —
  // it's already yours (Step 33 Section 11).
  const usernameUnchanged = normalized.valid && normalized.usernameLower === originalUsernameLower;

  useEffect(() => {
    if (usernameUnchanged || !normalized.valid) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username, usernameUnchanged]);

  let usernameAvailability: UsernameAvailability;
  let usernameMessage: string | null;

  if (!username) {
    usernameAvailability = 'idle';
    usernameMessage = null;
  } else if (!normalized.valid) {
    usernameAvailability = 'invalid';
    usernameMessage = normalized.reason;
  } else if (usernameUnchanged) {
    usernameAvailability = 'unchanged';
    usernameMessage = null;
  } else if (checkResult?.username === username) {
    usernameAvailability = checkResult.status;
    usernameMessage = checkResult.status === 'available' ? 'Available' : (checkResult.reason ?? 'Username already taken');
  } else {
    usernameAvailability = 'checking';
    usernameMessage = 'Checking…';
  }

  const usernameOk = usernameAvailability === 'available' || usernameAvailability === 'unchanged';
  const canSave =
    !isSubmitting &&
    usernameOk &&
    displayName.trim().length >= DISPLAY_NAME_MIN_LENGTH &&
    displayName.trim().length <= DISPLAY_NAME_MAX_LENGTH &&
    interests.length >= MIN_INTERESTS;

  const handleSave = async () => {
    if (!user || isSubmitting) return;

    const trimmedName = displayName.trim();
    if (trimmedName.length < DISPLAY_NAME_MIN_LENGTH || trimmedName.length > DISPLAY_NAME_MAX_LENGTH) {
      setNameError(`Enter a name between ${DISPLAY_NAME_MIN_LENGTH} and ${DISPLAY_NAME_MAX_LENGTH} characters.`);
      return;
    }
    setNameError(null);

    if (interests.length < MIN_INTERESTS) {
      setInterestsError(`Choose at least ${MIN_INTERESTS}.`);
      return;
    }
    setInterestsError(null);

    if (!usernameOk) return;

    setIsSubmitting(true);
    setFormError(null);

    const result = await updateMyProfile({
      uid: user.uid,
      displayName: trimmedName,
      username,
      bio,
      interests,
    });

    setIsSubmitting(false);

    if (!result.ok) {
      if (result.error === 'username-taken') {
        setCheckResult({ username, status: 'taken', reason: result.message });
      }
      setFormError(result.message);
      return;
    }

    await refreshProfile();
    router.back();
  };

  if (!profile) {
    return (
      <HeaderScreenLayout title="Edit profile">
        <Text style={styles.formError}>Couldn&apos;t load your profile.</Text>
      </HeaderScreenLayout>
    );
  }

  return (
    <HeaderScreenLayout title="Edit profile">
      <FormField
        label="Name"
        value={displayName}
        onChangeText={(value) => {
          setDisplayName(value);
          if (nameError) setNameError(null);
        }}
        placeholder="Your name"
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={DISPLAY_NAME_MAX_LENGTH}
        error={nameError ?? undefined}
      />

      <View>
        <FormField
          label="Username"
          prefix="@"
          value={username}
          onChangeText={(value) => setUsername(value.trim())}
          placeholder="username"
          autoCapitalize="none"
          autoCorrect={false}
          error={usernameAvailability === 'invalid' || usernameAvailability === 'taken' ? (usernameMessage ?? undefined) : undefined}
        />
        {usernameAvailability === 'checking' || usernameAvailability === 'available' ? (
          <Text style={usernameAvailability === 'available' ? styles.available : styles.checking}>{usernameMessage}</Text>
        ) : null}
      </View>

      <View>
        <FormField
          label="Bio (optional)"
          value={bio}
          onChangeText={setBio}
          placeholder="Tell people a bit about yourself"
          multiline
          numberOfLines={3}
          maxLength={BIO_MAX_LENGTH}
          style={styles.bioInput}
        />
        <Text style={styles.charCount}>
          {bio.trim().length}/{BIO_MAX_LENGTH}
        </Text>
      </View>

      <View style={styles.interestsSection}>
        <Text style={styles.sectionLabel}>Interests</Text>
        <InterestSelector
          value={interests}
          onChange={(next) => {
            setInterests(next);
            if (interestsError) setInterestsError(null);
          }}
          error={interestsError ?? undefined}
        />
      </View>

      <View style={styles.readOnlyPanel}>
        <View style={styles.readOnlyRow}>
          <Text style={styles.readOnlyLabel}>Home city</Text>
          <Text style={styles.readOnlyValue}>{formatCityDisplayName(profile.cityName)}</Text>
        </View>
        <View style={styles.readOnlyDivider} />
        <View style={styles.readOnlyRow}>
          <Text style={styles.readOnlyLabel}>Account type</Text>
          <Text style={styles.readOnlyValue}>{profile.accountType === 'business' ? 'Business' : 'Personal'}</Text>
        </View>
      </View>
      <Text style={styles.readOnlyHint}>Home city and account type can&apos;t be changed here.</Text>

      {formError ? <Text style={styles.formError}>{formError}</Text> : null}

      <Button label="Save changes" onPress={handleSave} disabled={!canSave} loading={isSubmitting} />
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  bioInput: {
    minHeight: 80,
    textAlignVertical: 'top',
    paddingTop: Spacing.sm,
  },
  charCount: {
    alignSelf: 'flex-end',
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  checking: {
    color: Colors.textSecondary,
    fontSize: 13,
    marginTop: 4,
  },
  available: {
    color: Colors.success,
    fontSize: 13,
    marginTop: 4,
  },
  interestsSection: {
    gap: Spacing.xs,
  },
  sectionLabel: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  readOnlyPanel: {
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  readOnlyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: Spacing.md,
  },
  readOnlyDivider: {
    height: 1,
    backgroundColor: Colors.border,
  },
  readOnlyLabel: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  readOnlyValue: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  readOnlyHint: {
    color: Colors.textMuted,
    fontSize: 12,
    marginTop: -Spacing.sm,
  },
  formError: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
});
