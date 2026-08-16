/**
 * Centralized design tokens for Around Me.
 *
 * Design direction: premium, modern, dark, social/mobile-first, clean,
 * minimal, slightly energetic. This is the single source of truth for
 * color, spacing, and radius — update values here to rebrand the app.
 */

export const Colors = {
  background: '#0B0B0F',
  surface: '#17171C',
  text: '#F5F5F7',
  textSecondary: '#9A9AA5',
  accent: '#FF6B2C',
  border: '#26262E',
  success: '#3DDC84',
  error: '#FF5252',
} as const;

export type ColorToken = keyof typeof Colors;

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
