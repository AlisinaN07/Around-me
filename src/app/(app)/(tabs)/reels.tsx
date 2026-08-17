import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Layout, Radius, Spacing } from '@/constants/theme';

export default function ReelsScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <View style={styles.mediaPlaceholder}>
          <Ionicons name="play-circle-outline" size={56} color={Colors.textSecondary} />
        </View>
        <Text style={styles.title}>Local Reels</Text>
        <Text style={styles.subtitle}>See your city through the people who are there right now.</Text>
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
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xl,
    gap: Spacing.lg,
  },
  mediaPlaceholder: {
    width: '100%',
    aspectRatio: 9 / 14,
    maxHeight: 420,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '800',
    textAlign: 'center',
  },
  subtitle: {
    color: Colors.textSecondary,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 21,
  },
});
