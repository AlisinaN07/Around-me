import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { InterestSelector } from '@/components/InterestSelector';
import { MIN_INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import {
  checkUsernameAvailability,
  updateMyProfile,
  updateMyProfileCoverPhoto,
  updateMyProfilePhoto,
  uploadProfileCoverPhoto,
  uploadProfilePhoto,
} from '@/services/userProfile';
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

  const [isUploadingPhoto, setIsUploadingPhoto] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Saved immediately on pick, independent of the "Save changes" button
  // below — a profile photo change isn't part of the displayName/username/
  // bio/interests form state or its validation (see updateMyProfilePhoto,
  // a separate write from updateMyProfile).
  const handleChangePhoto = async () => {
    if (!user || isUploadingPhoto) return;
    setPhotoError(null);

    // Requested only on this explicit tap — never on screen mount (same
    // minimum-permissions rule the Create Reel cover/video pickers follow).
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setPhotoError('Around Me needs access to your photo library to choose a picture.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0];
    setIsUploadingPhoto(true);

    await new Promise<void>((resolve) => {
      uploadProfilePhoto(user.uid, asset.uri, () => {}, async (uploadResult) => {
        if (!uploadResult.ok) {
          setPhotoError(uploadResult.message);
          setIsUploadingPhoto(false);
          resolve();
          return;
        }

        const saveResult = await updateMyProfilePhoto(user.uid, uploadResult.photoURL);
        setIsUploadingPhoto(false);
        if (!saveResult.ok) {
          setPhotoError(saveResult.message);
          resolve();
          return;
        }

        await refreshProfile();
        resolve();
      });
    });
  };

  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  // Cover/banner counterpart to handleChangePhoto above — same immediate-
  // save-on-pick behavior, own error state so a failure in one never hides
  // the other's message.
  const handleChangeCoverPhoto = async () => {
    if (!user || isUploadingCover) return;
    setCoverError(null);

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      setCoverError('Around Me needs access to your photo library to choose a picture.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [3, 1],
      quality: 0.9,
    });
    if (result.canceled || result.assets.length === 0) return;

    const asset = result.assets[0];
    setIsUploadingCover(true);

    await new Promise<void>((resolve) => {
      uploadProfileCoverPhoto(user.uid, asset.uri, () => {}, async (uploadResult) => {
        if (!uploadResult.ok) {
          setCoverError(uploadResult.message);
          setIsUploadingCover(false);
          resolve();
          return;
        }

        const saveResult = await updateMyProfileCoverPhoto(user.uid, uploadResult.coverPhotoURL);
        setIsUploadingCover(false);
        if (!saveResult.ok) {
          setCoverError(saveResult.message);
          resolve();
          return;
        }

        await refreshProfile();
        resolve();
      });
    });
  };

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
      <View style={styles.coverSection}>
        <Pressable
          onPress={handleChangeCoverPhoto}
          disabled={isUploadingCover}
          style={styles.coverButton}
          accessibilityRole="button"
          accessibilityLabel="Change cover photo"
        >
          {profile.coverPhotoURL ? (
            <>
              {/* Perf pass — expo-image, memory+disk cached: the same
                  URL ProfileHeader.tsx renders, so a cache warmed by
                  viewing the profile itself makes this preview instant
                  too. contentFit="cover" matches the plain <Image>'s own
                  prior default resizeMode exactly. */}
              <Image source={{ uri: profile.coverPhotoURL }} style={styles.coverImage} contentFit="cover" cachePolicy="memory-disk" />
              {/* Same bottom fade as ProfileHeader's own cover banner, so
                  this preview matches exactly. */}
              <LinearGradient colors={['transparent', Colors.background]} style={styles.coverFade} pointerEvents="none" />
            </>
          ) : (
            <View style={styles.coverPlaceholder}>
              <Ionicons name="image-outline" size={22} color={Colors.textSecondary} />
              <Text style={styles.coverPlaceholderText}>Add cover photo</Text>
            </View>
          )}
          <View style={styles.coverBadge}>
            {isUploadingCover ? (
              <ActivityIndicator size="small" color={Colors.background} />
            ) : (
              <Ionicons name="camera" size={14} color={Colors.background} />
            )}
          </View>
        </Pressable>
        {coverError ? <Text style={styles.formError}>{coverError}</Text> : null}
      </View>

      <View style={styles.photoSection}>
        <Pressable
          onPress={handleChangePhoto}
          disabled={isUploadingPhoto}
          style={styles.photoButton}
          accessibilityRole="button"
          accessibilityLabel="Change profile photo"
        >
          <View style={styles.avatarRing}>
            <Avatar name={profile.displayName || '?'} photoURL={profile.photoURL} size={88} />
          </View>
          <View style={styles.photoBadge}>
            {isUploadingPhoto ? (
              <ActivityIndicator size="small" color={Colors.background} />
            ) : (
              <Ionicons name="camera" size={16} color={Colors.background} />
            )}
          </View>
        </Pressable>
        {photoError ? <Text style={styles.formError}>{photoError}</Text> : null}
      </View>

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
  coverSection: {
    gap: Spacing.xs,
  },
  coverButton: {
    width: '100%',
    height: 120,
    borderRadius: Radius.lg,
    overflow: 'hidden',
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  coverFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 60,
  },
  coverPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  coverPlaceholderText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
  },
  coverBadge: {
    position: 'absolute',
    right: Spacing.sm,
    bottom: Spacing.sm,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accent,
    borderWidth: 2,
    borderColor: Colors.background,
  },
  // Overlaps coverButton's own bottom edge — same overlapping-avatar
  // composition ProfileHeader itself uses once a cover photo is set, so
  // this screen previews exactly what the redesigned header will look
  // like.
  photoSection: {
    alignItems: 'center',
    gap: Spacing.xs,
    paddingBottom: Spacing.sm,
    marginTop: -48,
  },
  // 96 = the 88 Avatar plus avatarRing's own 4px padding on each side.
  photoButton: {
    width: 96,
    height: 96,
  },
  avatarRing: {
    padding: 4,
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
  },
  photoBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accent,
    borderWidth: 2,
    borderColor: Colors.background,
  },
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
