import { StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { isFirebaseConfigured } from '@/services/firebase';

export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Around Me</Text>
      <Text style={styles.tagline}>See what&apos;s happening around you, right now.</Text>
      <Text style={styles.badge}>Development build</Text>
      {__DEV__ && (
        <Text style={styles.status}>
          Firebase: {isFirebaseConfigured ? 'Connected' : 'Not configured'}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
    paddingHorizontal: Spacing.xl,
    gap: Spacing.sm,
  },
  title: {
    color: Colors.text,
    fontSize: 32,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  tagline: {
    color: Colors.textSecondary,
    fontSize: 16,
    textAlign: 'center',
    marginTop: Spacing.xs,
  },
  badge: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: Spacing.xl,
  },
  status: {
    color: Colors.textSecondary,
    fontSize: 12,
    marginTop: Spacing.md,
  },
});
