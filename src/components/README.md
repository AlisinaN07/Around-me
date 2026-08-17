# components

Reusable UI components shared across screens.

- `Button.tsx` — primary/secondary button with loading and disabled states.
- `FormField.tsx` — labeled text input with optional prefix (e.g. `@`), show/hide password toggle, and error text.
- `FormScreenLayout.tsx` — safe-area + keyboard-avoiding scroll container for auth and onboarding form screens.
- `OnboardingProgress.tsx` — "N of 3" progress bar shown on each onboarding screen.
- `CountryPicker.tsx` — searchable country selector modal (used by onboarding's city step).
- `Avatar.tsx` — initials-based circular avatar placeholder.
- `SectionHeader.tsx` — "Title" + optional "See all" row used across Home sections.
- `CategoryChip.tsx` — selectable pill with icon, used for Home/Map category filters.
- `HappeningNowCard.tsx`, `ReelPreviewCard.tsx`, `FeedCard.tsx` — Home feed cards (see `@/fixtures/homeFeed`).
