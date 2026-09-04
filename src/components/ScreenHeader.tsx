import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Typography } from '@/constants/theme';

type ScreenHeaderProps = {
  title: string;
  /** Defaults to router.back() — pass a custom handler only when the screen needs different behavior. */
  onBackPress?: () => void;
  /** Hides the back button entirely (e.g. a top-level tab screen). */
  showBack?: boolean;
  right?: ReactNode;
};

/**
 * Standalone header ROW (Step 24 design foundation) — back button, centered
 * title, optional right-side action. Deliberately separate from
 * HeaderScreenLayout (which couples a header to a form-screen's
 * ScrollView/KeyboardAvoidingView body) so screens that aren't a scrolling
 * form — Reels, a future Events header, any full-bleed media screen — can
 * use the same header visual language without inheriting that body chrome.
 */
export function ScreenHeader({ title, onBackPress, showBack = true, right }: ScreenHeaderProps) {
  return (
    <View style={styles.header}>
      {showBack ? (
        <Pressable
          onPress={onBackPress ?? (() => router.back())}
          hitSlop={8}
          style={styles.sideButton}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
      ) : (
        <View style={styles.sideButton} />
      )}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      {right ?? <View style={styles.sideButton} />}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 8,
  },
  sideButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    color: Colors.text,
    ...Typography.cardTitle,
  },
});
