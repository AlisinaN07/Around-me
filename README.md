# Around Me

Location-based social network organized around cities — "See what's happening around you, right now."

This is the technical foundation only. No social features, authentication, or Firebase are implemented yet — those come in later steps.

## Stack

- React Native + Expo (SDK 57)
- TypeScript (strict)
- Expo Router (file-based routing)
- npm

## Get started

```bash
npm install
npx expo start
```

Then press `i` for iOS simulator, `a` for Android emulator, or scan the QR code with Expo Go.

## Project structure

```
app.json              Expo app config (name, icon, splash, plugins)
assets/                App icons, splash image, favicon
src/
  app/                 Screens and layouts (Expo Router file-based routing)
  components/          Reusable UI components (empty — added as features are built)
  constants/theme.ts   Centralized design tokens: colors, spacing, radius
  hooks/               Custom React hooks (empty — added as features are built)
  services/            API clients / external integrations, e.g. Firebase (empty — added later)
  types/               Shared TypeScript types (empty — added as features are built)
  utils/               Pure helper functions (empty — added as features are built)
```

`@/*` is aliased to `src/*` (see `tsconfig.json`), so imports look like `import { Colors } from '@/constants/theme'`.

## Scripts

- `npm start` — start the Metro dev server
- `npm run ios` / `npm run android` / `npm run web` — start and open on a platform
- `npm run lint` — run ESLint
- `npx tsc --noEmit` — type-check
