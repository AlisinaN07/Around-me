import { router } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Colors, Spacing } from '@/constants/theme';

export default function WelcomeScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.title}>Around Me</Text>
          <Text style={styles.tagline}>See what&apos;s happening around you, right now.</Text>
        </View>

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
});
