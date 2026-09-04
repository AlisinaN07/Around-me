import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';

type ProfileTabBarProps<T extends string> = {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
};

/**
 * Underline content-tab bar for Profile screens (Step 27) — social/media-
 * first, not the heavier boxed SegmentedControl used elsewhere (Events'
 * type filter, the old Profile tabs). Selected: bold white text + a short
 * accent underline. Unselected: muted. Deliberately its own small
 * component rather than reusing Home's inline ModeTab, to restyle Profile
 * without touching Home.
 */
export function ProfileTabBar<T extends string>({ tabs, value, onChange }: ProfileTabBarProps<T>) {
  return (
    <View style={styles.row}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <Pressable
            key={tab.id}
            onPress={() => onChange(tab.id)}
            style={styles.tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text style={[styles.label, active && styles.labelActive]} numberOfLines={1}>
              {tab.label}
            </Text>
            {active ? <View style={styles.indicator} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: Spacing.sm,
    paddingBottom: Spacing.sm,
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
