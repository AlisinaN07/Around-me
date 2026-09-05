import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { consumePostDeletionNotice } from '@/utils/postDeletionNotice';

export default function WelcomeScreen() {
  const [showDeletedNotice, setShowDeletedNotice] = useState(false);

  useEffect(() => {
    // One-shot — set right before the final Auth-deletion call in
    // DeleteAccountFlow. This welcome screen (not Login) is what
    // expo-router actually lands on once the (auth) group's stack resets
    // after a session ends, so the notice is consumed (read + cleared)
    // here rather than on Login, which never remounts in that transition.
    consumePostDeletionNotice().then((wasSet) => {
      if (wasSet) setShowDeletedNotice(true);
    });
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.title}>Around Me</Text>
          <Text style={styles.tagline}>See what&apos;s happening around you, right now.</Text>
        </View>

        {showDeletedNotice ? (
          <View style={styles.deletedNotice}>
            <Text style={styles.deletedNoticeText}>Your account has been deleted.</Text>
          </View>
        ) : null}

        <View style={styles.actions}>
          <Button label="Get started" onPress={() => router.push('/signup')} />
          <Button label="Log in" variant="secondary" onPress={() => router.push('/login')} />
          <Text style={styles.legal}>By continuing, you agree to our Terms & Privacy Policy.</Text>
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
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.xl,
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  title: {
    color: Colors.text,
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  tagline: {
    color: Colors.textSecondary,
    fontSize: 17,
    lineHeight: 24,
  },
  actions: {
    gap: Spacing.md,
  },
  legal: {
    color: Colors.textSecondary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
  deletedNotice: {
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  deletedNoticeText: {
    color: Colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
  },
});
