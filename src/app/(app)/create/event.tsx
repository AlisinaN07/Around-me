import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';

import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { CreateScreenLayout } from '@/components/CreateScreenLayout';
import { DateTimeField } from '@/components/DateTimeField';
import { FormField } from '@/components/FormField';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { createEvent } from '@/services/content';
import { DESCRIPTION_MAX_LENGTH, PLACE_NAME_MAX_LENGTH, TITLE_MAX_LENGTH } from '@/types/content';
import { addHours, roundUpToNextHalfHour } from '@/utils/timeFormat';

const DEFAULT_START = roundUpToNextHalfHour(new Date());
const DEFAULT_END = addHours(DEFAULT_START, 2);

export default function CreateEventScreen() {
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [placeName, setPlaceName] = useState('');
  const [startsAt, setStartsAt] = useState(DEFAULT_START);
  const [endsAt, setEndsAt] = useState(DEFAULT_END);

  const [titleError, setTitleError] = useState<string | null>(null);
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handlePublish = async () => {
    if (isSubmitting) return;

    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedPlace = placeName.trim();
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
      startsAt,
      endsAt,
    });

    setIsSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    router.replace('/');
  };

  return (
    <CreateScreenLayout title="Create event">
      <Text style={styles.subtitle}>Share something happening in the city.</Text>

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

      <FormField
        label="Place"
        placeholder="e.g. Nöjesfabriken"
        value={placeName}
        onChangeText={(text) => {
          setPlaceName(text);
          if (placeError) setPlaceError(null);
        }}
        error={placeError ?? undefined}
        maxLength={PLACE_NAME_MAX_LENGTH}
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

      <Button label="Publish event" onPress={handlePublish} loading={isSubmitting} />
    </CreateScreenLayout>
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
