import { FirebaseError } from 'firebase/app';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/Button';
import { FormField } from '@/components/FormField';
import { FormScreenLayout } from '@/components/FormScreenLayout';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { getAuthErrorMessage } from '@/utils/authErrors';
import { isValidEmail } from '@/utils/email';

/**
 * Forgot Password (Step 33). Deliberately shows the same neutral success
 * copy whether or not the email actually belongs to an account — see
 * Section 29 (account enumeration safety). Only genuine service failures
 * (network, rate limit) surface a real, retryable error. No custom reset-
 * token screen: Firebase's own emailed link handles the actual password
 * change outside this app.
 */
export default function ForgotPasswordScreen() {
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (isSubmitting) return;

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !isValidEmail(trimmedEmail)) {
      setError('Enter a valid email address.');
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await resetPassword(trimmedEmail);
      setSubmitted(true);
    } catch (err) {
      // auth/user-not-found would reveal whether this email has an account
      // — treated as the same neutral success as a real send (Section 29).
      // Everything else (network, too-many-requests) is a real, retryable
      // failure and is shown as one.
      if (err instanceof FirebaseError && err.code === 'auth/user-not-found') {
        setSubmitted(true);
      } else {
        setError(getAuthErrorMessage(err));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <FormScreenLayout>
        <View style={styles.header}>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>
            If an account exists for {email.trim()}, we&apos;ve sent password reset instructions.
          </Text>
        </View>
        <View style={styles.actions}>
          <Button label="Back to login" onPress={() => router.replace('/login')} />
        </View>
      </FormScreenLayout>
    );
  }

  return (
    <FormScreenLayout>
      <View style={styles.header}>
        <Text style={styles.title}>Reset your password</Text>
        <Text style={styles.subtitle}>Enter your email and we&apos;ll send you a link to reset it.</Text>
      </View>

      <View style={styles.form}>
        <FormField
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="you@example.com"
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          textContentType="emailAddress"
          autoComplete="email"
          returnKeyType="done"
          onSubmitEditing={handleSubmit}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Button label="Send reset link" onPress={handleSubmit} loading={isSubmitting} />
        <Pressable onPress={() => router.back()} hitSlop={8} style={styles.link} accessibilityRole="link">
          <Text style={styles.linkText}>Back to login</Text>
        </Pressable>
      </View>
    </FormScreenLayout>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: Spacing.xs,
    marginBottom: Spacing.lg,
  },
  title: {
    color: Colors.text,
    fontSize: 28,
    fontWeight: '800',
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    lineHeight: 21,
  },
  form: {
    gap: Spacing.md,
  },
  error: {
    color: Colors.error,
    fontSize: 13,
    textAlign: 'center',
  },
  actions: {
    gap: Spacing.md,
    marginTop: Spacing.lg,
  },
  link: {
    alignSelf: 'center',
    paddingVertical: Spacing.sm,
  },
  linkText: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
});
