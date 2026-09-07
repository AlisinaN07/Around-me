import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LoadingState } from '@/components/LoadingState';
import { Colors, Gradients, Layout, Radius, Spacing, Typography } from '@/constants/theme';
import { useProfile } from '@/hooks/useProfile';
import { useCity } from '@/providers/CityProvider';
import { isBusinessAccount } from '@/utils/accountCapabilities';

/**
 * Create hub — Step 41.2D, entry point updated in Step 41.2D.1. There are
 * exactly two user-facing creatable concepts: Post (video, technically a
 * Reel — canonical creation entry is /create/reel/camera, the camera-first
 * capture/preview flow) and Event (Business-only). Personal has only one,
 * so this screen is not a chooser for Personal at all: once the
 * already-loaded profile confirms accountType, it immediately
 * `router.replace`s straight to the camera rather than showing a "chooser"
 * with a single real option. Business sees a two-option Post/Event chooser
 * below, and its Post option also goes straight to the camera.
 *
 * The tab bar's + button (see (tabs)/_layout.tsx) skips this screen
 * entirely for Personal when accountType is already confidently known —
 * but this screen is still the canonical, deterministic entry point for
 * every other way of reaching /create (a cold-start tab press before the
 * profile has resolved, a direct link, or the /create/activity redirect
 * stub from Step 41.2B), so the account-aware behavior has to be enforced
 * here too, not only at the tab-press layer.
 */
export default function CreateScreen() {
  const { homeCity, activeCity, isExploringAnotherCity } = useCity();
  const { profile, isProfileLoading } = useProfile();
  const isBusiness = isBusinessAccount(profile);

  useEffect(() => {
    if (!isProfileLoading && !isBusiness) {
      router.replace('/create/reel/camera');
    }
  }, [isProfileLoading, isBusiness]);

  // Covers two cases with the same loading treatment: accountType isn't
  // known yet, or it is known and it's Personal — the effect above is
  // already replacing the route in the latter case, so this is just the
  // one frame before that takes effect. Never render the Business chooser
  // here on the strength of a guess.
  if (isProfileLoading || !isBusiness) {
    return (
      <SafeAreaView style={styles.safeArea}>
        <LoadingState size="large" />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text style={styles.title}>Create</Text>

        {isExploringAnotherCity && homeCity && activeCity ? (
          <View style={styles.exploringBanner}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.exploringBannerText}>
              You&apos;re exploring {activeCity.cityName}. New content publishes to your home city, {homeCity.cityName}.
            </Text>
          </View>
        ) : null}

        <View style={styles.chooser}>
          <CreateOptionCard
            icon="videocam"
            title="Post"
            description="Share a video with your city."
            accessibilityLabel="Post"
            onPress={() => router.push('/create/reel/camera')}
          />
          <CreateOptionCard
            icon="calendar"
            title="Event"
            description="Create an event for people to discover."
            accessibilityLabel="Event"
            onPress={() => router.push('/create/event')}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

function CreateOptionCard({
  icon,
  title,
  description,
  accessibilityLabel,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  description: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.optionCard, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <LinearGradient colors={Gradients.accent} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={styles.optionIconWrap}>
        <Ionicons name={icon} size={26} color={Colors.text} />
      </View>
      <View style={styles.optionCardText}>
        <Text style={styles.optionCardTitle}>{title}</Text>
        <Text style={styles.optionCardDescription}>{description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={20} color={Colors.text} />
    </Pressable>
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
    padding: Spacing.xl,
  },
  title: {
    color: Colors.text,
    ...Typography.screenTitle,
    marginTop: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  exploringBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginTop: -Spacing.md,
    marginBottom: Spacing.lg,
  },
  exploringBannerText: {
    flex: 1,
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  chooser: {
    gap: Spacing.md,
  },
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    overflow: 'hidden',
    shadowColor: Colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  pressed: {
    opacity: 0.9,
  },
  optionIconWrap: {
    width: 52,
    height: 52,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  optionCardText: {
    flex: 1,
    gap: 2,
  },
  optionCardTitle: {
    color: Colors.text,
    fontSize: 19,
    fontWeight: '800',
  },
  optionCardDescription: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 13,
    lineHeight: 18,
  },
});
