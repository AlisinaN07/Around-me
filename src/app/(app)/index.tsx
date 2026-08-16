import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button } from '@/components/Button';
import { Colors, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';

export default function HomeScreen() {
  const { user, signOut } = useAuth();

  const handleSignOut = () => {
    signOut().catch(() => {});
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.title}>Around Me</Text>
          <Text style={styles.subtitle}>You&apos;re in.</Text>
          {user?.email ? <Text style={styles.email}>{user.email}</Text> : null}
        </View>
        <Button label="Log out" variant="secondary" onPress={handleSignOut} />
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
    alignItems: 'center',
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.xl,
  },
  hero: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  title: {
    color: Colors.text,
    fontSize: 32,
    fontWeight: '800',
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 18,
  },
  email: {
    color: Colors.textSecondary,
    fontSize: 13,
    marginTop: Spacing.md,
  },
});
