import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Avatar } from '@/components/Avatar';
import { Button } from '@/components/Button';
import { ReelPreviewCard } from '@/components/ReelPreviewCard';
import { COUNTRIES } from '@/constants/countries';
import { INTERESTS } from '@/constants/interests';
import { Colors, Layout, Radius, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { fetchProfileReels } from '@/services/reels';
import type { Reel } from '@/types/reel';
import { formatCityDisplayName } from '@/utils/cityDisplay';

type ProfileTab = 'posts' | 'activities' | 'saved' | 'reels';

const PROFILE_TABS: { id: ProfileTab; label: string; icon: keyof typeof Ionicons.glyphMap; emptyText: string }[] = [
  { id: 'posts', label: 'Posts', icon: 'grid-outline', emptyText: 'No posts yet.' },
  { id: 'activities', label: 'Activities', icon: 'people-outline', emptyText: 'No activities yet.' },
  { id: 'reels', label: 'Reels', icon: 'videocam-outline', emptyText: 'No Reels yet' },
  { id: 'saved', label: 'Saved', icon: 'bookmark-outline', emptyText: 'Nothing saved yet.' },
];

export default function ProfileScreen() {
  const { user, signOut } = useAuth();
  const { profile } = useProfile();
  const [activeTab, setActiveTab] = useState<ProfileTab>('posts');
  const [reels, setReels] = useState<Reel[]>([]);
  const [reelsLoaded, setReelsLoaded] = useState(false);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    fetchProfileReels(user.uid).then((result) => {
      if (cancelled) return;
      setReels(result);
      setReelsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSignOut = () => {
    signOut().catch(() => {});
  };

  const displayName = profile?.displayName ?? '';
  const username = profile?.username ?? '';
  const cityLabel = profile?.cityName ? formatCityDisplayName(profile.cityName) : '';
  const countryLabel = COUNTRIES.find((country) => country.code === profile?.countryCode)?.name ?? '';
  const interestLabels = (profile?.interests ?? [])
    .map((id) => INTERESTS.find((interest) => interest.id === id)?.label)
    .filter((label): label is string => Boolean(label));

  const activeTabInfo = PROFILE_TABS.find((tab) => tab.id === activeTab) ?? PROFILE_TABS[0];

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.page}>
          <View style={styles.header}>
            <Avatar name={displayName || '?'} size={80} />
            <Text style={styles.displayName} numberOfLines={1}>
              {displayName}
            </Text>
            {username ? <Text style={styles.username}>@{username}</Text> : null}
            {cityLabel ? (
              <View style={styles.locationRow}>
                <Ionicons name="location" size={14} color={Colors.accent} />
                <Text style={styles.locationText} numberOfLines={1}>
                  {cityLabel}
                  {countryLabel ? `, ${countryLabel}` : ''}
                </Text>
              </View>
            ) : null}
          </View>

          {interestLabels.length > 0 && (
            <View style={styles.interestsSection}>
              <Text style={styles.interestsLabel}>Interests</Text>
              <Text style={styles.interestsValue}>{interestLabels.join(' · ')}</Text>
            </View>
          )}

          <View style={styles.actions}>
            <Button label="Edit profile" variant="secondary" onPress={() => {}} disabled />
            <Button label="Log out" variant="secondary" onPress={handleSignOut} />
          </View>

          {user ? (
            <Pressable
              onPress={() => router.push(`/user/${user.uid}`)}
              style={styles.publicProfileLink}
              accessibilityRole="button"
              accessibilityLabel="View public profile"
            >
              <Ionicons name="person-circle-outline" size={16} color={Colors.accent} />
              <Text style={styles.publicProfileLinkText}>View public profile</Text>
            </Pressable>
          ) : null}

          <Pressable
            onPress={() => router.push('/settings/privacy')}
            style={styles.settingsRow}
            accessibilityRole="button"
            accessibilityLabel="Privacy & safety"
          >
            <View style={styles.settingsRowLeft}>
              <Ionicons name="shield-checkmark-outline" size={18} color={Colors.text} />
              <Text style={styles.settingsRowText}>Privacy & safety</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={Colors.textSecondary} />
          </Pressable>

          <View style={styles.tabsRow}>
            {PROFILE_TABS.map((tab) => {
              const isActive = tab.id === activeTab;
              return (
                <Pressable
                  key={tab.id}
                  onPress={() => setActiveTab(tab.id)}
                  style={[styles.tabButton, isActive && styles.tabButtonActive]}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: isActive }}
                >
                  <Ionicons name={tab.icon} size={16} color={isActive ? Colors.accent : Colors.textSecondary} />
                  <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>{tab.label}</Text>
                </Pressable>
              );
            })}
          </View>

          {activeTab === 'reels' ? (
            reels.length === 0 ? (
              <View style={styles.emptyState}>
                <Ionicons name={activeTabInfo.icon} size={28} color={Colors.textSecondary} />
                <Text style={styles.emptyStateText}>{reelsLoaded ? activeTabInfo.emptyText : 'Loading…'}</Text>
                {reelsLoaded ? (
                  <View style={styles.emptyStateAction}>
                    <Button label="Create Reel" variant="secondary" onPress={() => router.push('/create/reel')} />
                  </View>
                ) : null}
              </View>
            ) : (
              <View style={styles.reelGrid}>
                {reels.map((reel) => (
                  <ReelPreviewCard key={reel.reelId} reel={reel} />
                ))}
              </View>
            )
          ) : (
            <View style={styles.emptyState}>
              <Ionicons name={activeTabInfo.icon} size={28} color={Colors.textSecondary} />
              <Text style={styles.emptyStateText}>{activeTabInfo.emptyText}</Text>
            </View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  scrollContent: {
    alignItems: 'center',
    paddingBottom: Spacing.xxl,
  },
  page: {
    width: '100%',
    maxWidth: Layout.maxContentWidth,
  },
  header: {
    alignItems: 'center',
    gap: 4,
    paddingTop: Spacing.lg,
    paddingHorizontal: Spacing.xl,
  },
  displayName: {
    color: Colors.text,
    fontSize: 22,
    fontWeight: '800',
    marginTop: Spacing.sm,
  },
  username: {
    color: Colors.textSecondary,
    fontSize: 14,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: Spacing.xs,
  },
  locationText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  interestsSection: {
    marginTop: Spacing.lg,
    marginHorizontal: Spacing.xl,
    alignItems: 'center',
    gap: 4,
  },
  interestsLabel: {
    color: Colors.textSecondary,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  interestsValue: {
    color: Colors.text,
    fontSize: 14,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.xl,
    marginHorizontal: Spacing.xl,
  },
  publicProfileLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: Spacing.md,
  },
  publicProfileLinkText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '600',
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.xl,
    marginHorizontal: Spacing.xl,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
  },
  settingsRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  settingsRowText: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  tabsRow: {
    flexDirection: 'row',
    marginTop: Spacing.xl,
    marginHorizontal: Spacing.xl,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 4,
  },
  tabButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.sm,
  },
  tabButtonActive: {
    backgroundColor: Colors.background,
  },
  tabLabel: {
    color: Colors.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  tabLabelActive: {
    color: Colors.accent,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    paddingVertical: Spacing.xxl,
  },
  emptyStateText: {
    color: Colors.textSecondary,
    fontSize: 13,
  },
  emptyStateAction: {
    minWidth: 160,
    marginTop: Spacing.xs,
  },
  reelGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    rowGap: Spacing.sm,
    marginTop: Spacing.md,
    marginHorizontal: Spacing.xl,
  },
});
