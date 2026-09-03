import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { HeaderScreenLayout } from '@/components/HeaderScreenLayout';
import { DateTimeField } from '@/components/DateTimeField';
import { FormField } from '@/components/FormField';
import { PlaceSelector, type PlaceSelectorValue } from '@/components/PlaceSelector';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { createActivity } from '@/services/content';
import { DESCRIPTION_MAX_LENGTH, MAX_PARTICIPANTS_LIMIT, PLACE_NAME_MAX_LENGTH, TITLE_MAX_LENGTH } from '@/types/content';
import { formatCityDisplayName } from '@/utils/cityDisplay';
import { addHours, roundUpToNextHalfHour } from '@/utils/timeFormat';

const DEFAULT_START = roundUpToNextHalfHour(new Date());
const DEFAULT_END = addHours(DEFAULT_START, 1);

export default function CreateActivityScreen() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [place, setPlace] = useState<PlaceSelectorValue>({ placeId: null, placeName: '' });
  const [startsAt, setStartsAt] = useState(DEFAULT_START);
  const [endsAt, setEndsAt] = useState(DEFAULT_END);
  const [maxParticipants, setMaxParticipants] = useState('');

  const [titleError, setTitleError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [maxParticipantsError, setMaxParticipantsError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handlePublish = async () => {
    if (isSubmitting) return;

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
    let parsedMaxParticipants: number | undefined;
    if (maxParticipants.trim()) {
      const parsed = Number(maxParticipants.trim());
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > MAX_PARTICIPANTS_LIMIT) {
        setMaxParticipantsError(`Enter a number between 1 and ${MAX_PARTICIPANTS_LIMIT}.`);
        hasError = true;
      } else {
        setMaxParticipantsError(null);
        parsedMaxParticipants = parsed;
      }
    } else {
      setMaxParticipantsError(null);
    }

    if (hasError) return;

    if (!user) {
      setFormError('You need to be signed in to post.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    const result = await createActivity({
      uid: user.uid,
      title: trimmedTitle,
      description: trimmedDescription,
      categoryId: categoryId!,
      placeName: trimmedPlace,
      placeId: place.placeId,
      startsAt,
      endsAt,
      maxParticipants: parsedMaxParticipants,
    });

    setIsSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    router.replace('/');
  };

  return (
    <HeaderScreenLayout title="Create activity">
      <Text style={styles.subtitle}>Find people nearby to do something together — they join directly, no RSVP.</Text>

      <FormField
        label="Title"
        placeholder="Football tonight ⚽"
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
        placeholder="We need 3 more people for a game tonight."
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

      <FormField
        label="Maximum participants (optional)"
        placeholder="e.g. 10"
        value={maxParticipants}
        onChangeText={(text) => {
          setMaxParticipants(text.replace(/[^0-9]/g, ''));
          if (maxParticipantsError) setMaxParticipantsError(null);
        }}
        error={maxParticipantsError ?? undefined}
        keyboardType="number-pad"
      />

      {formError ? <Text style={styles.formError}>{formError}</Text> : null}

      <Button label="Publish activity" onPress={handlePublish} loading={isSubmitting} />
    </HeaderScreenLayout>
  );
}

const styles = StyleSheet.create({
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
    marginTop: -Spacing.sm,
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
});
