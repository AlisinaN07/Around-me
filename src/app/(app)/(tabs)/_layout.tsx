import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, Tabs } from 'expo-router';
import { Platform, StyleSheet, View } from 'react-native';

import { Colors, Gradients, IconSize } from '@/constants/theme';
import { useProfile } from '@/hooks/useProfile';
import { isBusinessAccount } from '@/utils/accountCapabilities';

/**
 * Bottom tab bar (Step 24 visual foundation). Reels intentionally does NOT
 * appear here anymore — the approved reference direction puts Events in
 * the primary second slot, with Reels reached contextually (Home, Profile,
 * a Reel's own share link) rather than as a persistent tab. The Reels
 * screen/route/backend is fully preserved at `/reels`
 * (src/app/(app)/reels.tsx) — only its place in the tab bar moved.
 */
export default function TabsLayout() {
  // Step 41.2D — reuses the already-mounted ProfileProvider context (a
  // single one-shot profile fetch, not a realtime listener); this layout
  // never subscribes to anything new just to read accountType. Only used
  // to let a Personal account's + tap skip the /create hop entirely when
  // accountType is already confidently known. When it ISN'T yet known
  // (isProfileLoading), the tab press is left alone — the canonical
  // account-aware /create screen (create.tsx) is the deterministic
  // fallback for that case and for every other way of reaching /create,
  // so Personal never gets stuck looking at a chooser with only one real
  // option.
  const { profile, isProfileLoading } = useProfile();
  const isConfidentlyPersonal = !isProfileLoading && !isBusinessAccount(profile);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.text,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarStyle: styles.tabBar,
        tabBarBackground: () => <View style={styles.tabBarBackground} />,
        tabBarLabelStyle: styles.tabBarLabel,
        tabBarItemStyle: styles.tabBarItem,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={IconSize.lg} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="events"
        options={{
          title: 'Events',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'calendar' : 'calendar-outline'} size={IconSize.lg} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="create"
        options={{
          title: '',
          tabBarIcon: () => (
            <LinearGradient colors={Gradients.accent} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.createButton}>
              <Ionicons name="add" size={IconSize.xl} color={Colors.text} />
            </LinearGradient>
          ),
        }}
        listeners={{
          tabPress: (event) => {
            // Personal has exactly one creatable concept (Post) — skip the
            // /create hop and go straight to its canonical route. Business
            // (or accountType not yet confidently known) falls through to
            // the default tab-press behavior, landing on /create, which
            // renders the Post/Event chooser for Business and independently
            // redirects Personal itself if this listener ever runs before
            // the profile has loaded.
            if (isConfidentlyPersonal) {
              event.preventDefault();
              router.push('/create/reel');
            }
          },
        }}
      />
      <Tabs.Screen
        name="inbox"
        options={{
          title: 'Inbox',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'chatbubbles' : 'chatbubbles-outline'} size={IconSize.lg} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'person' : 'person-outline'} size={IconSize.lg} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    backgroundColor: 'transparent',
    borderTopWidth: 0,
    height: Platform.select({ ios: 88, default: 64 }),
    paddingTop: 10,
    elevation: 0,
  },
  tabBarBackground: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(10, 10, 13, 0.94)',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  tabBarLabel: {
    fontSize: 11,
    fontWeight: '600',
  },
  tabBarItem: {
    paddingTop: 2,
  },
  createButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -6,
    ...Platform.select({
      web: { boxShadow: `0 4px 14px ${Colors.accent}66` },
      default: {
        shadowColor: Colors.accent,
        shadowOpacity: 0.4,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
      },
    }),
  },
});
