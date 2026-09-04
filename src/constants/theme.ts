/**
 * Centralized design tokens for Around Me.
 *
 * Design direction (Step 24): premium, dark, social/mobile-first,
 * TikTok/Instagram-level visual energy, event discovery as a major visual
 * identity, one recognizable pink/red/orange accent family. This is the
 * single source of truth for color, type, spacing, and radius — update
 * values here to shift the whole app's visual identity.
 *
 * Existing token names (Colors.text, Colors.accent, Spacing.md, Radius.lg,
 * etc.) are kept stable — dozens of existing screens depend on them.
 * Step 24 adds new tokens alongside them rather than renaming anything, and
 * shifts `accent` itself from the earlier flat orange toward the vivid
 * pink-red seen in the approved reference screenshots — a single token
 * change that reaches every screen already using it, without a
 * screen-by-screen rewrite.
 */

export const Colors = {
  // Backgrounds / surfaces, darkest to lightest.
  background: '#0A0A0D',
  surface: '#17171C',
  /** New: modals, sheets, and raised panels that need to read as "above" a surface card. */
  surfaceElevated: '#1F1F26',
  /** New: subtle inset panels — between background and surface (e.g. composer inputs). */
  surfaceSoft: '#131318',

  text: '#F5F5F7',
  textSecondary: '#9A9AA5',
  /** New: least-emphasis text — timestamps, disabled labels, tertiary metadata. */
  textMuted: '#6E6E78',

  /** Primary accent — vivid pink-red, the one recognizable accent family (Step 24). */
  accent: '#FF3B5C',
  /** Orange gradient endpoint / secondary accent moments. */
  accentSecondary: '#FF7A45',
  /** New: soft accent fill for selected/active chip and pill backgrounds. */
  accentMuted: 'rgba(255, 59, 92, 0.16)',

  border: '#26262E',
  /** New: slightly more visible border for emphasis — active outlines, dividers that need to read. */
  borderStrong: '#34343E',

  success: '#3DDC84',
  error: '#FF5252',
} as const;

export type ColorToken = keyof typeof Colors;

/** Solid-to-solid gradient stops for LinearGradient — the app's one accent gradient family. */
export const Gradients = {
  accent: [Colors.accent, Colors.accentSecondary] as [string, string],
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export type SpacingToken = keyof typeof Spacing;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 20,
  full: 999,
} as const;

export type RadiusToken = keyof typeof Radius;

export const Layout = {
  /** Caps content width on wide web viewports so mobile-first screens don't stretch awkwardly. */
  maxContentWidth: 480,
} as const;

/**
 * Reusable font-metric tokens (Step 24) — deliberately hold no color, so
 * they compose with any text color token: `style={[Typography.cardTitle,
 * { color: Colors.text }]}`. Replaces the previous pattern of every screen
 * hardcoding its own fontSize/fontWeight combination ad hoc.
 */
export const Typography = {
  display: { fontSize: 32, fontWeight: '800', letterSpacing: -0.5 },
  screenTitle: { fontSize: 26, fontWeight: '800' },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  body: { fontSize: 15, fontWeight: '400', lineHeight: 21 },
  bodySecondary: { fontSize: 13, fontWeight: '400', lineHeight: 18 },
  label: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  caption: { fontSize: 12, fontWeight: '600' },
  button: { fontSize: 15, fontWeight: '700' },
  stat: { fontSize: 18, fontWeight: '800' },
} as const;

export type TypographyToken = keyof typeof Typography;

/** Standard control heights — buttons, inputs, tab bar items. */
export const ControlHeight = {
  sm: 36,
  md: 44,
  lg: 52,
} as const;

/** Standard icon sizes, matched to where they typically appear (chips, headers, action rails). */
export const IconSize = {
  sm: 14,
  md: 18,
  lg: 22,
  xl: 28,
} as const;

export const BorderWidth = {
  hairline: 0.5,
  thin: 1,
  medium: 1.5,
} as const;
