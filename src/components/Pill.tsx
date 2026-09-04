import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Spacing, Typography } from '@/constants/theme';

type PillTone = 'neutral' | 'accent' | 'live' | 'success';

type PillProps = {
  label: string;
  tone?: PillTone;
  icon?: keyof typeof Ionicons.glyphMap;
};

const TONE_STYLES: Record<PillTone, { background: string; text: string; border?: string }> = {
  neutral: { background: Colors.surface, text: Colors.textSecondary, border: Colors.border },
  accent: { background: Colors.accentMuted, text: Colors.accent },
  live: { background: Colors.error, text: Colors.text },
  success: { background: Colors.success, text: Colors.background },
};

/**
 * Small rounded label — the one shared primitive behind category pills,
 * "LIVE"/"NOW" badges, and verification-style markers throughout the new
 * visual system (Step 24). Never carries a count on its own; pair it with
 * real data at the call site.
 */
export function Pill({ label, tone = 'neutral', icon }: PillProps) {
  const toneStyle = TONE_STYLES[tone];
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: toneStyle.background },
        toneStyle.border ? { borderWidth: 1, borderColor: toneStyle.border } : null,
      ]}
    >
      {icon ? <Ionicons name={icon} size={11} color={toneStyle.text} /> : null}
      <Text style={[styles.label, { color: toneStyle.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 3,
    borderRadius: Radius.full,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  label: {
    ...Typography.caption,
  },
});
