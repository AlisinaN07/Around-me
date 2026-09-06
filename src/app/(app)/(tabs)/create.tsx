import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, type Href } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Gradients, Layout, Radius, Spacing, Typography } from '@/constants/theme';
import { useProfile } from '@/hooks/useProfile';
import { useCity } from '@/providers/CityProvider';
import { canCreateEvent } from '@/utils/accountCapabilities';

type CreateOption = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description: string;
  href: Href;
};

// Home is a Reel-first social feed (Step 25), so the video Post is the
// visually strongest option here too — a large hero card above the
// secondary list. Step 41.2C retired the legacy text-only Post creation
// option entirely (see /create/post's redirect stub), so the hero card
// below is now simply labeled "Post" with no secondary duplicate.
const SECONDARY_OPTIONS: CreateOption[] = [];

/**
 * Event creation is Business-only (Step 30 core rule: Business = Personal
 * + the ability to create Events). Personal accounts simply never see
 * this option — no disabled "Coming soon" card, no badge on the account
 * that does see it. The real guarantee is firestore.rules' Event-create
 * check, not this filter — see /create/event's own capability guard for
 * what happens if a Personal account navigates there directly.
 */
const EVENT_OPTION: CreateOption = {
  id: 'event',
  icon: 'calendar-outline',
  label: 'Event',
  description: 'Publish an event.',
  href: '/create/event',
};

export default function CreateScreen() {
  const { homeCity, activeCity, isExploringAnotherCity } = useCity();
  const { profile } = useProfile();
  const showEvent = canCreateEvent(profile);

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

        <Pressable
          style={({ pressed }) => [styles.reelHero, pressed && styles.pressed]}
          onPress={() => router.push('/create/reel')}
          accessibilityRole="button"
          accessibilityLabel="Post"
        >
          <LinearGradient
            colors={Gradients.accent}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.reelIconWrap}>
            <Ionicons name="videocam" size={26} color={Colors.text} />
          </View>
          <View style={styles.reelHeroText}>
            <Text style={styles.reelHeroTitle}>Post</Text>
            <Text style={styles.reelHeroDescription}>Share what&apos;s happening around you.</Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={Colors.text} />
        </Pressable>

        <View style={styles.list}>
          {SECONDARY_OPTIONS.map((option) => (
            <OptionRow key={option.id} option={option} />
          ))}
          {showEvent ? <OptionRow option={EVENT_OPTION} /> : null}
        </View>
      </View>
    </SafeAreaView>
  );
}

function OptionRow({ option }: { option: CreateOption }) {
  return (
    <Pressable
      style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
      onPress={() => router.push(option.href)}
      accessibilityRole="button"
      accessibilityLabel={option.label}
    >
      <View style={styles.iconWrap}>
        <Ionicons name={option.icon} size={22} color={Colors.accent} />
      </View>
      <View style={styles.optionText}>
        <Text style={styles.optionLabel}>{option.label}</Text>
        <Text style={styles.optionDescription}>{option.description}</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
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
  reelHero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    overflow: 'hidden',
    shadowColor: Colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  pressed: {
    opacity: 0.9,
  },
  reelIconWrap: {
    width: 52,
    height: 52,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
  },
  reelHeroText: {
    flex: 1,
    gap: 2,
  },
  reelHeroTitle: {
    color: Colors.text,
    fontSize: 19,
    fontWeight: '800',
  },
  reelHeroDescription: {
    color: 'rgba(255, 255, 255, 0.85)',
    fontSize: 13,
    lineHeight: 18,
  },
  list: {
    gap: Spacing.md,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
  },
  optionPressed: {
    opacity: 0.85,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.background,
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionLabel: {
    color: Colors.text,
    ...Typography.cardTitle,
  },
  optionDescription: {
    color: Colors.textSecondary,
    ...Typography.bodySecondary,
  },
});
