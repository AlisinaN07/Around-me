import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { CategorySelector } from '@/components/CategorySelector';
import { CreateScreenLayout } from '@/components/CreateScreenLayout';
import { FormField } from '@/components/FormField';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { createPost } from '@/services/content';
import { BODY_MAX_LENGTH, PLACE_NAME_MAX_LENGTH } from '@/types/content';

export default function CreatePostScreen() {
  const { user } = useAuth();
  const [body, setBody] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [placeName, setPlaceName] = useState('');
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handlePublish = async () => {
    if (isSubmitting) return;

    const trimmedBody = body.trim();
    let hasError = false;
    if (!trimmedBody) {
      setBodyError("Write something before you publish.");
      hasError = true;
    } else if (trimmedBody.length > BODY_MAX_LENGTH) {
      setBodyError(`Keep it under ${BODY_MAX_LENGTH} characters.`);
      hasError = true;
    } else {
      setBodyError(null);
    }
    if (!categoryId) {
      setCategoryError('Choose a category.');
      hasError = true;
    } else {
      setCategoryError(null);
    }
    if (hasError) return;

    if (!user) {
      setFormError('You need to be signed in to post.');
      return;
    }

    setIsSubmitting(true);
    setFormError(null);

    const result = await createPost({
      uid: user.uid,
      body: trimmedBody,
      categoryId: categoryId!,
      placeName: placeName.trim() || undefined,
    });

    setIsSubmitting(false);

    if (!result.ok) {
      setFormError(result.message);
      return;
    }

    router.replace('/');
  };

  return (
    <CreateScreenLayout title="Create post">
      <Text style={styles.subtitle}>Share something with people in your city.</Text>

      <View>
        <FormField
          label="What's happening?"
          placeholder="Share what's going on around you..."
          value={body}
          onChangeText={(text) => {
            setBody(text);
            if (bodyError) setBodyError(null);
          }}
          error={bodyError ?? undefined}
          multiline
          numberOfLines={5}
          maxLength={BODY_MAX_LENGTH}
          style={styles.multilineInput}
        />
        <Text style={styles.charCount}>
          {body.trim().length}/{BODY_MAX_LENGTH}
        </Text>
      </View>

      <CategorySelector
        value={categoryId}
        onChange={(id) => {
          setCategoryId(id);
          setCategoryError(null);
        }}
        error={categoryError ?? undefined}
      />

      <FormField
        label="Place (optional)"
        placeholder="e.g. Stora torget"
        value={placeName}
        onChangeText={setPlaceName}
        maxLength={PLACE_NAME_MAX_LENGTH}
      />

      {formError ? <Text style={styles.formError}>{formError}</Text> : null}

      <Button label="Publish post" onPress={handlePublish} loading={isSubmitting} />
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
    minHeight: 120,
    textAlignVertical: 'top',
    paddingTop: Spacing.md,
  },
  charCount: {
    alignSelf: 'flex-end',
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  formError: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
});
