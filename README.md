# Around Me

Location-based social network organized around cities — "See what's happening around you, right now."

Email/password authentication, onboarding (name, username, city, interests), a full tab-based application shell (Home, Reels, Create, Map, Profile), and the real Firestore content backend (posts, activities, events) are implemented. Create → Post/Activity/Event → Publish is wired to that backend, and Home's Around You / Happening Now sections render the real city feed. Reels (both creation and the Local Reels feed) remain unimplemented placeholders — no media/Storage layer exists yet.

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
      create/            Post/Activity/Event forms — stack screens above the tab bar, not tabs
    _layout.tsx        Routes between the three top-level groups based on auth + profile state
  components/          Button, FormField, FormScreenLayout, CreateScreenLayout, OnboardingProgress,
                       CountryPicker, Avatar, SectionHeader, CategoryChip, CategorySelector,
                       DateTimeField (+ .web variant), ContentCard, HappeningNowCard
  constants/            theme.ts (design tokens), countries.ts, interests.ts, categoryFilters.ts
  hooks/                useAuth.ts, useProfile.ts
  providers/            AuthProvider, ProfileProvider, OnboardingDraftProvider
  services/            firebase.ts (App), auth.ts (Auth), firestore.ts (Firestore),
                       userProfile.ts (profile data layer), content.ts (posts/activities/events
                       data layer), location.ts (one-time city lookup)
  types/                Shared TypeScript types and type augmentations
  utils/                authErrors.ts, username.ts, cityKey.ts, cityDisplay.ts, timeFormat.ts
scripts/                delete-test-documents.cjs — explicit-ID-only disposable test cleanup
firestore.rules         Firestore security rules (see Firestore section below)
firestore.indexes.json  Composite indexes the content queries need
firebase.json           Firebase CLI config — Firestore rules + indexes only
.firebaserc              Points the CLI at the around-me-6a437 project
```

`@/*` is aliased to `src/*` (see `tsconfig.json`), so imports look like `import { Colors } from '@/constants/theme'`.

## Firestore

App data lives in Cloud Firestore, on the same Firebase project as Auth (`around-me-6a437`). Collections so far:

- `users/{uid}` — the caller's own profile (`email`, `displayName`, `username`, `cityKey`, `interests`, etc.). Private to its owner — not yet publicly readable.
- `usernames/{usernameLower}` — a uniqueness index reserving each username to one `uid`. Created atomically with the profile in a single transaction (see `src/services/userProfile.ts`).
- `content/{contentId}` — one unified collection for `post` / `activity` / `event` (a discriminated union in `src/types/content.ts`), since Home will eventually be a mixed feed of all three. Reels get their own architecture in a later step — different media/storage concerns.

Every content document carries `authorUid`, `authorDisplayName`, `authorUsername`, `cityName`, `countryCode`, `cityKey` — a **public-safe snapshot** of the author's private profile, copied at write time so the feed never has to read another user's `users/{uid}` document. Firestore rules verify this snapshot exactly matches the author's own profile on create, so a modified client can't post as another user or claim another city. Reads are open to any signed-in user (not scoped to the reader's own city — browsing other cities is intentional); creates require a completed profile; only the author can delete their own content; updates are denied entirely for now (no edit UI exists yet, so there's nothing to validate "which fields are safely mutable" against).

Content queries (`src/services/content.ts`) are one-shot reads with explicit limits — no realtime listeners, no unbounded queries:
- `fetchCityFeed(cityKey)` — newest published content for a city, mixed types, `orderBy(createdAt desc)`.
- `fetchUpcomingEvents` / `fetchUpcomingActivities(cityKey)` — `startsAt >= now`, `orderBy(startsAt asc)`.
- `fetchHappeningNow(cityKey)` — Firestore can't filter two different fields with inequalities in one query, so `startsAt <= now AND endsAt >= now` isn't directly expressible. Instead it fetches already-started candidates (`startsAt <= now`) and filters client-side for ones that haven't ended — reusing the same index as the "upcoming" queries rather than a third one. Fine until real usage data says otherwise.

All access goes through `src/services/userProfile.ts` and `src/services/content.ts` — UI code should never import `firebase/firestore` directly.

**Security rules** (`firestore.rules`) enforce least privilege throughout. Everything unspecified is denied by default. **Never switch production rules to `allow read, write: if true` — even temporarily.**

Before deploying a rules change, test it against the emulator:

```bash
npm run test:rules
```

This runs `tests/firestore.rules.test.mjs` against a local Firestore emulator using `@firebase/rules-unit-testing`, covering the ALLOW/DENY cases for `users`, `usernames`, and `content`. (Note: on at least one sandboxed dev environment, the emulator's rules-management endpoint hung indefinitely for unrelated network reasons — if `npm run test:rules` hangs for you, verify the same scenarios directly against a real project instead, as was done manually to validate the rules deployed here.)

To deploy rules and indexes:

```bash
npx firebase-tools login   # first time only — needs your Google account
npx firebase-tools deploy --only firestore
```

New composite indexes take a little while to build after deploying — check status with `npx firebase-tools firestore:indexes`, or just try the query; Firestore returns a clear "index is currently building" error (with a console link) until it's ready.

### Cleaning up disposable test data

If you create throwaway accounts/documents while testing against production (there's no working local emulator in some sandboxes — see above), remove them with:

```bash
npm run cleanup:test-data -- --users uid1,uid2 --usernames someuser,otheruser --content contentId1,contentId2 --auth-uids uid1,uid2
```

`--auth-uids` deletes the Firebase Auth account itself, in addition to its Firestore documents — use it only for disposable test accounts you created, never for a real user's account.

`scripts/delete-test-documents.cjs` deletes only the exact document IDs you pass it — it has no "delete everything" mode and running it with no flags is a no-op. **Never** run `firebase firestore:delete <collection> --recursive` against this project: that deletes the entire collection, real user data included, not just test documents.

## Create flow

Create → choose Post/Activity/Event → fill in the form → Publish calls the matching `create*` function in `src/services/content.ts` directly (screens never write to Firestore themselves). On success the app navigates back to Home; Home refetches on every focus (`useFocusEffect`, still a one-shot query, not a realtime listener), so newly-published content shows up without an app restart. Reel stays "Coming soon" — no upload UI or Storage integration exists yet.

Date/time fields use `@react-native-community/datetimepicker` on iOS/Android (`src/components/DateTimeField.tsx`) and plain HTML `date`/`time` inputs on web (`DateTimeField.web.tsx`, picked automatically by Metro's platform file resolution) — the picker package has no web support of its own.

## Location

Onboarding's city step can use `expo-location` for a one-time, foreground-only lookup ("when in use" permission only — no background location, no continuous tracking). It's used purely to derive a city + country, which get turned into a `cityKey` via `src/utils/cityKey.ts`. Raw coordinates only ever exist as local variables inside `src/services/location.ts` and are never sent to Firestore or persisted anywhere. Denying the permission doesn't block onboarding — manual city selection (country picker + city text field) always works.

## Scripts

- `npm start` — start the Metro dev server
- `npm run ios` / `npm run android` / `npm run web` — start and open on a platform
- `npm run lint` — run ESLint
- `npx tsc --noEmit` — type-check
