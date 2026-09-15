import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';

type ProfileTabBarProps<T extends string> = {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
};

// Step 41.2G added a 5th tab for Business profiles; a later step (Business
// Profile is now Events-only, no tab bar at all — see the profile screens'
// own effectiveTab) removed that case, but this threshold is left in place
// as a general safeguard: above 4 tabs, equal-flex labels get too narrow
// on a phone, so the row switches to horizontal scroll with a fixed
// per-tab min-width instead of squeezing every label.
const SCROLL_THRESHOLD = 4;

/**
 * Underline content-tab bar for Profile screens (Step 27) — social/media-
 * first, not the heavier boxed SegmentedControl used elsewhere (Events'
 * type filter, the old Profile tabs). Selected: bold white text + a short
 * accent underline. Unselected: muted. Deliberately its own small
 * component rather than reusing Home's inline ModeTab, to restyle Profile
 * without touching Home.
 */
export function ProfileTabBar<T extends string>({ tabs, value, onChange }: ProfileTabBarProps<T>) {
  const scrollable = tabs.length > SCROLL_THRESHOLD;

  const tabItems = tabs.map((tab) => {
    const active = tab.id === value;
    return (
      <Pressable
        key={tab.id}
        onPress={() => onChange(tab.id)}
        style={[styles.tab, scrollable && styles.tabScrollable]}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
      >
        <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
          {tab.label}
        </Text>
        {active ? <View style={styles.indicator} /> : null}
      </Pressable>
    );
  });

  if (scrollable) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scrollRow} contentContainerStyle={styles.scrollContent}>
        {tabItems}
      </ScrollView>
    );
  }

  return <View style={styles.row}>{tabItems}</View>;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  scrollRow: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  scrollContent: {
    flexDirection: 'row',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.sm,
    paddingBottom: Spacing.sm,
  },
  tabScrollable: {
    flex: 0,
    minWidth: 84,
    paddingHorizontal: Spacing.md,
  },
  label: {
    color: Colors.textMuted,
    fontSize: 14,
    fontWeight: '700',
  },
  labelActive: {
    color: Colors.text,
  },
  indicator: {
    position: 'absolute',
    bottom: -1,
    width: '60%',
    height: 2,
    borderRadius: 1,
    backgroundColor: Colors.accent,
  },
});
