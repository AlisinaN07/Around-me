import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { INTERESTS } from '@/constants/interests';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';

export default function HomeScreen() {
  const { signOut } = useAuth();
  const { profile } = useProfile();

  const handleSignOut = () => {
    signOut().catch(() => {});
  };

  const interestLabels = (profile?.interests ?? [])
    .map((id) => INTERESTS.find((interest) => interest.id === id)?.label)
    .filter((label): label is string => Boolean(label));

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.title}>Around {profile?.cityName ?? 'you'}</Text>
          <Text style={styles.subtitle}>See what&apos;s happening around you, right now.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardText}>Your local feed is coming next.</Text>
        </View>

        {interestLabels.length > 0 ? (
          <Text style={styles.meta} numberOfLines={2}>
            Into {interestLabels.join(', ')}
          </Text>
        ) : null}

        <View style={styles.footer}>
          <Button label="Log out" variant="secondary" onPress={handleSignOut} />
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
    padding: Spacing.xl,
  },
  header: {
    gap: Spacing.xs,
    marginTop: Spacing.lg,
  },
  title: {
    color: Colors.text,
    fontSize: 30,
    fontWeight: '800',
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 16,
    lineHeight: 22,
  },
  card: {
    marginTop: Spacing.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    paddingVertical: Spacing.xxl,
    paddingHorizontal: Spacing.lg,
    alignItems: 'center',
  },
  cardText: {
    color: Colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
  },
  meta: {
    color: Colors.textSecondary,
    fontSize: 13,
    marginTop: Spacing.md,
  },
  footer: {
    marginTop: 'auto',
  },
});
