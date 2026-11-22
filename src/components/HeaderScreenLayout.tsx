import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SwipeBackEdge } from '@/components/SwipeBackEdge';
import { Colors, Layout, Spacing, Typography } from '@/constants/theme';

type HeaderScreenLayoutProps = {
  title: string;
  /** Short one-line description rendered under the header, above the form — shared by every Create screen instead of each one styling its own. */
  subtitle?: string;
  children: ReactNode;
  /** Replaces the default right-side spacer — e.g. a small overflow/options button. Falls back to a plain spacer (keeping the title centered) when omitted. */
  headerRight?: ReactNode;
  /**
   * Renders directly below the header row, OUTSIDE the scrolling body —
   * pinned in place while `children` scrolls underneath it. Per explicit
   * request for the Events "Show more" screen's Sort/Filter controls row
   * (src/app/(app)/events/section.tsx), which needed to stay visible while
   * the list scrolls rather than scrolling away with it. Optional and
   * additive — every existing caller (the Create screens) omits it and is
   * unaffected.
   */
  stickyBelowHeader?: ReactNode;
};

/** Shared chrome for the Post/Activity/Event creation screens: back button, title, keyboard-avoiding scroll body. */
export function HeaderScreenLayout({ title, subtitle, children, headerRight, stickyBelowHeader }: HeaderScreenLayoutProps) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {/* Same handler as the back button below. */}
      <SwipeBackEdge onBack={() => router.back()} />
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={24} color={Colors.text} />
        </Pressable>
        <Text style={styles.title}>{title}</Text>
        {headerRight ?? <View style={styles.headerSpacer} />}
      </View>
      {stickyBelowHeader ? <View style={styles.stickyContent}>{stickyBelowHeader}</View> : null}
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.content}>
            {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
  },
  backButton: {
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
    fontSize: 17,
  },
  headerSpacer: {
    width: 40,
  },
  subtitle: {
    color: Colors.textSecondary,
    ...Typography.body,
    marginTop: -Spacing.sm,
  },
  // Mirrors `content`'s own width/centering/horizontal padding below, so a
  // sticky block lines up exactly with the scrollable content underneath
  // it rather than sitting at a different inset.
  stickyContent: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.xl,
    paddingBottom: Spacing.sm,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  content: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.sm,
    gap: Spacing.lg,
  },
});
