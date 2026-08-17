# Around Me

Location-based social network organized around cities — "See what's happening around you, right now."

Email/password authentication, onboarding (name, username, city, interests), and a full tab-based application shell (Home, Reels, Create, Map, Profile) are implemented. Home's sections use local UI fixture data — the real feed/Reels/events backend is still to come.

## Stack

- React Native + Expo (SDK 57)
- TypeScript (strict)
- Expo Router (file-based routing)
- Firebase JS SDK (modular API — no `@react-native-firebase`, so it stays Expo Go compatible)
- npm

## Get started

1. Use Node 20+ (this project was built and tested on v20.19.5; if you use `nvm`, run `nvm use 20.19.5`).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env.local` and fill in your Firebase web app config (see below).
4. Start the app:
   ```bash
   npx expo start
   ```
   Then press `i` for iOS simulator, `a` for Android emulator, or scan the QR code with Expo Go.

### Firebase configuration

Firebase client config values (`apiKey`, `authDomain`, etc.) live in `.env.local` as `EXPO_PUBLIC_FIREBASE_*` variables — see `.env.example` for the full list. Get real values from [Firebase Console](https://console.firebase.google.com/) → Project settings → Your apps → the web app config.

These are public client identifiers, not server secrets, but `.env.local` is still git-ignored to keep environments separate and avoid noisy diffs. **Never commit Firebase Admin private keys, service account JSON, or any other server/admin credential to this repo** — those never belong in the mobile app at all.

If `.env.local` is missing or incomplete, the app runs fine and logs a clear warning identifying which variable is missing instead of crashing — see the "Firebase: Not configured" status on the development screen.

## Project structure

```
app.json              Expo app config (name, icon, splash, plugins)
assets/                App icons, splash image, favicon
.env.example           Firebase config template (safe to commit)
.env.local              Your real Firebase config (git-ignored, not committed)
src/
  app/
    (auth)/            Welcome, log in, sign up — logged out
    (onboarding)/      Name+username, city, interests — logged in, no profile yet
    (app)/
      (tabs)/           Home, Reels, Create, Map, Profile — logged in, profile complete
    _layout.tsx        Routes between the three top-level groups based on auth + profile state
  components/          Button, FormField, FormScreenLayout, OnboardingProgress, CountryPicker,
                       Avatar, SectionHeader, CategoryChip, HappeningNowCard, ReelPreviewCard, FeedCard
  constants/            theme.ts (design tokens), countries.ts, interests.ts
  fixtures/             Local-only UI preview data for Home (never Firestore — see fixtures/README.md)
  hooks/                useAuth.ts, useProfile.ts
  providers/            AuthProvider, ProfileProvider, OnboardingDraftProvider
  services/            firebase.ts (App), auth.ts (Auth), firestore.ts (Firestore),
                       userProfile.ts (data layer), location.ts (one-time city lookup)
  types/                Shared TypeScript types and type augmentations
  utils/                authErrors.ts, username.ts, cityKey.ts, cityDisplay.ts
firestore.rules         Firestore security rules (see Firestore section below)
firebase.json           Firebase CLI config — Firestore rules only
.firebaserc              Points the CLI at the around-me-6a437 project
```

`@/*` is aliased to `src/*` (see `tsconfig.json`), so imports look like `import { Colors } from '@/constants/theme'`.

## Firestore

App data lives in Cloud Firestore, on the same Firebase project as Auth (`around-me-6a437`). Collections so far:

- `users/{uid}` — the caller's own profile (`email`, `displayName`, `username`, `cityKey`, `interests`, etc.). Private to its owner — not yet publicly readable.
- `usernames/{usernameLower}` — a uniqueness index reserving each username to one `uid`. Created atomically with the profile in a single transaction (see `src/services/userProfile.ts`).

All access goes through `src/services/userProfile.ts` — UI code should never import `firebase/firestore` directly.

**Security rules** (`firestore.rules`) enforce least privilege: an authenticated user may only read/create their own `users/{uid}` document, and may only reserve a username for their own uid. Everything else is denied by default. **Never switch production rules to `allow read, write: if true` — even temporarily.**

Before deploying a rules change, test it against the emulator:

```bash
npm run test:rules
```

This runs `tests/firestore.rules.test.mjs` against a local Firestore emulator using `@firebase/rules-unit-testing`, covering the ALLOW/DENY cases for both collections. (Note: on at least one sandboxed dev environment, the emulator's rules-management endpoint hung indefinitely for unrelated network reasons — if `npm run test:rules` hangs for you, verify the same scenarios directly against a real project instead, as was done manually to validate the rules deployed here.)

To deploy rule changes:

```bash
npx firebase-tools login   # first time only — needs your Google account
npx firebase-tools deploy --only firestore:rules
```

## Location

Onboarding's city step can use `expo-location` for a one-time, foreground-only lookup ("when in use" permission only — no background location, no continuous tracking). It's used purely to derive a city + country, which get turned into a `cityKey` via `src/utils/cityKey.ts`. Raw coordinates only ever exist as local variables inside `src/services/location.ts` and are never sent to Firestore or persisted anywhere. Denying the permission doesn't block onboarding — manual city selection (country picker + city text field) always works.

## Scripts

- `npm start` — start the Metro dev server
- `npm run ios` / `npm run android` / `npm run web` — start and open on a platform
- `npm run lint` — run ESLint
- `npx tsc --noEmit` — type-check
