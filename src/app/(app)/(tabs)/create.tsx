import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useProfile } from '@/hooks/useProfile';
import { useCity } from '@/providers/CityProvider';
import { canCreateEvent } from '@/utils/accountCapabilities';

type CreateOption = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  description: string;
  href: Href | null;
};

const ALWAYS_AVAILABLE_OPTIONS: CreateOption[] = [
  {
    id: 'activity',
    icon: 'people-outline',
    label: 'Activity',
    description: 'Find people nearby to do something together.',
    href: '/create/activity',
  },
  {
    id: 'post',
    icon: 'create-outline',
    label: 'Post',
    description: 'Share with people around you.',
    href: '/create/post',
  },
  {
    id: 'reel',
    icon: 'videocam-outline',
    label: 'Reel',
    description: 'Show what is happening right now.',
    href: '/create/reel',
  },
];

/**
 * Event creation is Business-only (Step 30 core rule: Business = Personal
 * + the ability to create Events). Personal accounts simply never see
 * this option — no disabled "Coming soon" card, since it isn't a
 * temporarily-missing feature, it's a real capability the account doesn't
 * have. The real guarantee is firestore.rules' Event-create check, not
 * this filter — see /create/event's own capability guard for what happens
 * if a Personal account navigates there directly.
 */
const EVENT_OPTION: CreateOption = {
  id: 'event',
  icon: 'calendar-outline',
  label: 'Event',
  description: 'Share something happening in the city.',
  href: '/create/event',
};

export default function CreateScreen() {
  const { homeCity, activeCity, isExploringAnotherCity } = useCity();
  const { profile } = useProfile();

  const createOptions = useMemo(() => {
    const options = [...ALWAYS_AVAILABLE_OPTIONS];
    if (canCreateEvent(profile)) {
      options.splice(1, 0, EVENT_OPTION);
    }
    return options;
  }, [profile]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text style={styles.title}>Create</Text>

        {isExploringAnotherCity && homeCity && activeCity ? (
          <View style={styles.exploringBanner}>
            <Ionicons name="information-circle-outline" size={18} color={Colors.textSecondary} />
            <Text style={styles.exploringBannerText}>
              You&apos;re exploring {activeCity.cityName}. Your posts are published to your home city, {homeCity.cityName}.
            </Text>
          </View>
        ) : null}

        <View style={styles.list}>
          {createOptions.map((option) => (
            <Pressable
              key={option.id}
              style={({ pressed }) => [styles.option, pressed && option.href && styles.optionPressed]}
              onPress={() => option.href && router.push(option.href)}
              disabled={!option.href}
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityState={{ disabled: !option.href }}
            >
              <View style={styles.iconWrap}>
                <Ionicons name={option.icon} size={22} color={Colors.accent} />
              </View>
              <View style={styles.optionText}>
                <View style={styles.optionHeaderRow}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  {!option.href && (
                    <View style={styles.comingSoonBadge}>
                      <Text style={styles.comingSoonText}>Coming soon</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.optionDescription}>{option.description}</Text>
              </View>
              {option.href && <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />}
            </Pressable>
          ))}
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
    width: '100%',
    maxWidth: Layout.maxContentWidth,
    alignSelf: 'center',
    padding: Spacing.xl,
  },
  title: {
    color: Colors.text,
    fontSize: 26,
    fontWeight: '800',
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
  optionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionLabel: {
    color: Colors.text,
    fontSize: 16,
    fontWeight: '700',
  },
  optionDescription: {
    color: Colors.textSecondary,
    fontSize: 13,
    lineHeight: 18,
  },
  comingSoonBadge: {
    borderRadius: Radius.full,
    backgroundColor: Colors.background,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
  },
  comingSoonText: {
    color: Colors.textSecondary,
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
});
