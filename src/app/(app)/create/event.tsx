import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { DateTimeField } from '@/components/DateTimeField';
import { FormField } from '@/components/FormField';
import { PlaceSelector, type PlaceSelectorValue } from '@/components/PlaceSelector';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { createEvent, generateEventDraftId, uploadEventCoverPhoto } from '@/services/content';
import { DESCRIPTION_MAX_LENGTH, PLACE_NAME_MAX_LENGTH, TITLE_MAX_LENGTH } from '@/types/content';
import { canCreateEvent } from '@/utils/accountCapabilities';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { addHours, roundUpToNextHalfHour } from '@/utils/timeFormat';

const DEFAULT_START = roundUpToNextHalfHour(new Date());
const DEFAULT_END = addHours(DEFAULT_START, 2);

export default function CreateEventScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [place, setPlace] = useState<PlaceSelectorValue>({ placeId: null, placeName: '' });
  const [startsAt, setStartsAt] = useState(DEFAULT_START);
  const [endsAt, setEndsAt] = useState(DEFAULT_END);

  const [titleError, setTitleError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Step 36 — a fresh draft id reserved once for this screen's whole
  // lifetime (lazy initializer — see generateEventDraftId's own doc
  // comment for why this exists and why it's never regenerated mid-draft).
  const [draftId] = useState(() => generateEventDraftId());
  const [coverPhotoURL, setCoverPhotoURL] = useState('');
  const [isUploadingCover, setIsUploadingCover] = useState(false);
  const [coverError, setCoverError] = useState<string | null>(null);

  // Uploaded immediately on pick, independent of Publish — an Event's
  // cover is genuinely optional, so there's nothing to validate here the
  // way title/description/etc. are; Publish just includes whatever
  // coverPhotoURL (possibly still '') is already resolved by then.
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
      uploadEventCoverPhoto(user.uid, draftId, asset.uri, () => {}, (uploadResult) => {
        setIsUploadingCover(false);
        if (!uploadResult.ok) {
          setCoverError(uploadResult.message);
          resolve();
          return;
        }
        setCoverPhotoURL(uploadResult.coverPhotoURL);
        resolve();
      });
    });
  };

  const handlePublish = async () => {
    if (isSubmitting || isUploadingCover) return;

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedPlace = place.placeName.trim();
    let hasError = false;

    if (!trimmedTitle || trimmedTitle.length > TITLE_MAX_LENGTH) {
      setTitleError(`Title must be 1–${TITLE_MAX_LENGTH} characters.`);
      hasError = true;
    } else {
      setTitleError(null);
    }
    if (!trimmedDescription || trimmedDescription.length > DESCRIPTION_MAX_LENGTH) {
      setDescriptionError(`Description must be 1–${DESCRIPTION_MAX_LENGTH} characters.`);
      hasError = true;
    } else {
      setDescriptionError(null);
    }
    if (!categoryId) {
      setCategoryError('Choose a category.');
      hasError = true;
    } else {
      setCategoryError(null);
    }
    if (!trimmedPlace || trimmedPlace.length > PLACE_NAME_MAX_LENGTH) {
      setPlaceError('Enter a valid place name.');
      hasError = true;
    } else {
      setPlaceError(null);
    }
    if (startsAt.getTime() >= endsAt.getTime()) {
      setTimeError('Start time must be before end time.');
      hasError = true;
    } else {
      setTimeError(null);
    }

    if (hasError) return;

    if (!user) {
      setFormError('You need to be signed in to post.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    const result = await createEvent({
      uid: user.uid,
      title: trimmedTitle,
      description: trimmedDescription,
      categoryId: categoryId!,
      placeName: trimmedPlace,
      placeId: place.placeId,
      startsAt,
      endsAt,
      ...(coverPhotoURL ? { coverPhotoURL } : {}),
    });

    setIsSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    router.replace('/');
  };

  // Hiding Event from the Create hub isn't sufficient on its own — a
  // Personal account could still navigate here directly. The real
  // guarantee is firestore.rules' Event-create check (server-side,
  // Section 15); this is a client-side safety net so a Personal account
  // never even sees the creation form, and gets sent back to Create
  // instead of hitting a confusing write failure after filling it out.
  if (!canCreateEvent(profile)) {
    return (
      <HeaderScreenLayout title="Create event">
        <View style={styles.blockedState}>
          <Ionicons name="calendar-outline" size={32} color={Colors.textSecondary} />
          <Text style={styles.blockedTitle}>Event creation is for Business accounts</Text>
          <Text style={styles.blockedBody}>
            Your account is Personal. You can still create Posts.
          </Text>
          <Button label="Back to Create" variant="secondary" onPress={() => router.replace('/create')} />
        </View>
      </HeaderScreenLayout>
    );
  }

  return (
    <HeaderScreenLayout
      title="Create event"
      subtitle="Share something happening in the city. People can mark themselves Interested or Going."
    >
      <View style={styles.coverSection}>
        <Text style={styles.coverLabel}>Cover photo (optional)</Text>
        <Pressable
          onPress={handleChangeCoverPhoto}
          disabled={isUploadingCover}
          style={styles.coverButton}
          accessibilityRole="button"
          accessibilityLabel={coverPhotoURL ? 'Change cover photo' : 'Add cover photo'}
        >
          {coverPhotoURL ? (
            <>
              <Image source={{ uri: coverPhotoURL }} style={styles.coverImage} />
              <LinearGradient colors={['transparent', Colors.background]} style={styles.coverFade} pointerEvents="none" />
            </>
          ) : (
            <View style={styles.coverPlaceholder}>
              <Ionicons name="image-outline" size={22} color={Colors.textSecondary} />
              <Text style={styles.coverPlaceholderText}>Add a background photo for this event</Text>
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

      <FormField
        label="Title"
        placeholder="Live music tonight"
        value={title}
        onChangeText={(text) => {
          setTitle(text);
          if (titleError) setTitleError(null);
        }}
        error={titleError ?? undefined}
        maxLength={TITLE_MAX_LENGTH}
      />

      <FormField
        label="Description"
        placeholder="What's happening, who's playing, why it's worth going..."
        value={description}
        onChangeText={(text) => {
          setDescription(text);
          if (descriptionError) setDescriptionError(null);
        }}
        error={descriptionError ?? undefined}
        multiline
        numberOfLines={4}
        maxLength={DESCRIPTION_MAX_LENGTH}
        style={styles.multilineInput}
      />

      <CategorySelector
        value={categoryId}
        onChange={(id) => {
          setCategoryId(id);
          setCategoryError(null);
        }}
        error={categoryError ?? undefined}
      />

      <PlaceSelector
        label="Place"
        cityKey={profile?.cityKey ?? ''}
        cityLabel={profile?.cityName ? formatCityDisplayName(profile.cityName) : 'your city'}
        value={place}
        onChange={(next) => {
          setPlace(next);
          if (placeError) setPlaceError(null);
        }}
        error={placeError ?? undefined}
      />

      <DateTimeField
        label="Start"
        value={startsAt}
        onChange={(date) => {
          setStartsAt(date);
          if (timeError) setTimeError(null);
        }}
        minimumDate={new Date()}
      />

      <DateTimeField
        label="End"
        value={endsAt}
        onChange={(date) => {
          setEndsAt(date);
          if (timeError) setTimeError(null);
        }}
        minimumDate={startsAt}
        error={timeError ?? undefined}
      />

      {formError ? <Text style={styles.formError}>{formError}</Text> : null}

      <Button label="Publish event" onPress={handlePublish} loading={isSubmitting} disabled={isUploadingCover} />
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  blockedState: {
    alignItems: 'center',
    gap: Spacing.sm,
    paddingTop: Spacing.xl,
  },
  blockedTitle: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  blockedBody: {
    color: Colors.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  multilineInput: {
    minHeight: 96,
    textAlignVertical: 'top',
    paddingTop: Spacing.md,
  },
  formError: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  coverSection: {
    gap: Spacing.xs,
  },
  coverLabel: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  coverButton: {
    width: '100%',
    height: 140,
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
    paddingHorizontal: Spacing.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  coverPlaceholderText: {
    color: Colors.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
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
});
