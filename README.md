# Around Me

Location-based social network organized around cities — "See what's happening around you, right now."

Email/password authentication, onboarding (name, username, city, interests), a full tab-based application shell (Home, Reels, Create, Map, Profile), and the real Firestore content backend (posts, activities, events) are implemented. Create → Post/Activity/Event → Publish is wired to that backend, and Home's Around You / Happening Now sections render the real city feed. Every content type has a real detail screen — Activity with Join/Leave, Event with Interested/Going, and all three with Likes and Comments — backed by Firestore transactions/writes and security rules. Every user also has a public social profile (separate from their private account data) with real Follow/Unfollow and follower/following lists, reachable by tapping any author, commenter, or `@username` in the app. Reels (both creation and the Local Reels feed) remain unimplemented placeholders — no media/Storage layer exists yet. Direct messaging, notifications, saves, and a personalized Following feed are not implemented yet either.

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
      content/           [contentId] detail screen (Activity/Event participation) — also a stack
                        screen above the tab bar
      user/              [uid]/index (public profile), [uid]/followers, [uid]/following —
                        also stack screens above the tab bar
    _layout.tsx        Routes between the three top-level groups based on auth + profile state
  components/          Button, FormField, FormScreenLayout, HeaderScreenLayout, OnboardingProgress,
                       CountryPicker, Avatar, SectionHeader, CategoryChip, CategorySelector,
                       DateTimeField (+ .web variant), ContentCard, HappeningNowCard,
                       PostDetail, ActivityDetail, EventDetail, EngagementSection,
                       AuthorLink, UserList
  constants/            theme.ts (design tokens), countries.ts, interests.ts, categoryFilters.ts
  hooks/                useAuth.ts, useProfile.ts
  providers/            AuthProvider, ProfileProvider, OnboardingDraftProvider
  services/            firebase.ts (App), auth.ts (Auth), firestore.ts (Firestore),
                       userProfile.ts (private profile data layer), content.ts (posts/activities/
                       events data layer), engagement.ts (activity participation + event
                       responses), socialEngagement.ts (likes + comments), publicProfile.ts
                       (public social profiles), following.ts (follow graph), location.ts
                       (one-time city lookup)
  types/                Shared TypeScript types and type augmentations (user.ts = private,
                       social.ts = public profile + follow)
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

- `users/{uid}` — the caller's own profile (`email`, `displayName`, `username`, `cityKey`, `interests`, etc.). **Private to its owner, always** — never made publicly readable, including after Step 11. Anything social-facing lives in `publicProfiles/{uid}` instead (see below), which is the entire reason that collection exists.
- `usernames/{usernameLower}` — a uniqueness index reserving each username to one `uid`. Created atomically with the profile in a single transaction (see `src/services/userProfile.ts`).
- `publicProfiles/{uid}` — the social-facing counterpart to `users/{uid}`, containing only what's safe to show any signed-in user: `displayName`, `username`, `usernameLower`, `cityName`, `countryCode`, `cityKey`, `interests`, `accountType`, `createdAt`, `updatedAt`. No email, GPS, tokens, or other private fields — enforced by Firestore rules requiring every field to exactly match the caller's own `users/{uid}` document on create. Created atomically alongside `users`/`usernames` during onboarding; accounts that completed onboarding before Step 11 get one lazily via `ensureMyPublicProfile()` (see Social graph below).
- `follows/{followerUid}_{followingUid}` — a directed edge in the social graph (`src/services/following.ts`), with a deterministic ID so at most one follow document can ever exist per (follower, following) pair. No copied profile data, just `followerUid`, `followingUid`, `createdAt` — resolve to `publicProfiles/{uid}` for display.
- `content/{contentId}` — one unified collection for `post` / `activity` / `event` (a discriminated union in `src/types/content.ts`), since Home will eventually be a mixed feed of all three. Reels get their own architecture in a later step — different media/storage concerns.

Every content document carries `authorUid`, `authorDisplayName`, `authorUsername`, `cityName`, `countryCode`, `cityKey` — a **public-safe snapshot** of the author's private profile, copied at write time so the feed never has to read another user's `users/{uid}` document. Firestore rules verify this snapshot exactly matches the author's own profile on create, so a modified client can't post as another user or claim another city. Reads are open to any signed-in user (not scoped to the reader's own city — browsing other cities is intentional); creates require a completed profile; updates are denied entirely for now (no edit UI exists yet, so there's nothing to validate "which fields are safely mutable" against). **Root content delete is disabled** (`allow delete: if false`) as of Step 10 — content now has five possible subcollections (`participants`, `stats`, `responses`, `likes`, `comments`) that Firestore never cascade-deletes, and there's no safe production cascade-delete workflow or client "delete content" UI yet, so allowing a client to delete the parent alone would leave those subcollections permanently orphaned.

Content queries (`src/services/content.ts`) are one-shot reads with explicit limits — no realtime listeners, no unbounded queries:
- `fetchCityFeed(cityKey)` — newest published content for a city, mixed types, `orderBy(createdAt desc)`.
- `fetchUpcomingEvents` / `fetchUpcomingActivities(cityKey)` — `startsAt >= now`, `orderBy(startsAt asc)`.
- `fetchHappeningNow(cityKey)` — Firestore can't filter two different fields with inequalities in one query, so `startsAt <= now AND endsAt >= now` isn't directly expressible. Instead it fetches already-started candidates (`startsAt <= now`) and filters client-side for ones that haven't ended — reusing the same index as the "upcoming" queries rather than a third one. Fine until real usage data says otherwise.

Two subcollections support participation, added under `content/{contentId}`:

- `content/{activityId}/participants/{uid}` — one document per user who joined an Activity (`uid`, `displayName`, `username`, `joinedAt` — same public-safe-snapshot pattern as content itself, verified against the joiner's own profile by Firestore rules).
- `content/{activityId}/stats/activity` — a single `{ participantCount, updatedAt }` document, kept in sync with the participant subcollection by a Firestore transaction on every join/leave (see Engagement below) so `maxParticipants` can be enforced without reading every participant.
- `content/{eventId}/responses/{uid}` — one document per user's Interested/Going response to an Event (`status: 'interested' | 'going'`, switched in place rather than creating a second document). No separate counter — Interested/Going counts come from `getCountFromServer` aggregation queries instead.

Two more subcollections support general social engagement (Post/Activity/Event alike), added in Step 10:

- `content/{contentId}/likes/{uid}` — one document per user who liked this content, keyed by the liker's own uid (which is itself what guarantees at most one Like per user). No public-safe snapshot needed — just `{ uid, createdAt }`. Like counts come from a `getCountFromServer` aggregation query, same as Event response counts — no counter to keep paired.
- `content/{contentId}/comments/{commentId}` — top-level comments only for Step 10 (no replies/threads), same public-safe-snapshot pattern as content authorship (`authorDisplayName`/`authorUsername` verified against the commenter's own profile). Comment counts are also aggregation-based.

All access goes through `src/services/userProfile.ts`, `src/services/content.ts`, `src/services/engagement.ts`, and `src/services/socialEngagement.ts` — UI code should never import `firebase/firestore` directly.

**Security rules** (`firestore.rules`) enforce least privilege throughout. Everything unspecified is denied by default. **Never switch production rules to `allow read, write: if true` — even temporarily.**

Before deploying a rules change, test it against the emulator:

```bash
npm run test:rules
```

This runs `tests/firestore.rules.test.mjs` against a local Firestore emulator using `@firebase/rules-unit-testing`, covering the ALLOW/DENY cases for `users`, `usernames`, `publicProfiles`, `follows`, `content`, `content/{id}/participants`, `content/{id}/stats`, `content/{id}/responses`, `content/{id}/likes`, and `content/{id}/comments`. (Note: on at least one sandboxed dev environment, the emulator starts fine but pushing the ruleset to it fails with `ECONNRESET`/`fetch failed` for unrelated network reasons — if `npm run test:rules` fails that way for you, verify the same scenarios directly against a real project instead, as was done manually to validate the rules deployed here.)

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

## Engagement (Activity join/leave, Event Interested/Going)

`src/services/engagement.ts`:

- `joinActivity` / `leaveActivity` — each a single Firestore transaction that reads the Activity + the caller's own participant doc + the stats doc, then writes the participant doc and the stats counter together atomically. Rejects joining a non-Activity, an unpublished Activity, an ended Activity, or a full one (`maxParticipants`); a repeat join returns `alreadyJoined` instead of incrementing twice; a repeat leave is a safe no-op instead of going negative.
- `getActivityParticipation` / `fetchActivityParticipants` — one-shot reads for the detail screen's own join state + a capped (`limit`) participant preview list.
- `setEventResponse` / `removeEventResponse` / `fetchMyEventResponse` / `fetchEventResponseCounts` — plain reads/writes (no transaction needed, since there's no counter to keep paired) that create-or-update the caller's own response document and read real Interested/Going counts via aggregation queries.

Firestore rules enforce all of this server-side too, independent of the client: a participant/response document's `uid`/`displayName`/`username` must match the caller's own profile, a participant or response can only be created for a published, not-yet-ended Activity/Event, and the `stats/activity` counter can only change by exactly ±1 in the same atomic write as the caller's own participant document appearing/disappearing (checked via `existsAfter()`/`getAfter()` on both sides of the pair) — a client can never write `participantCount` directly, exceed `maxParticipants`, or push the count negative.

Content detail screens (`src/app/(app)/content/[contentId].tsx`, delegating to `PostDetail`/`ActivityDetail`/`EventDetail` by type) are reached by tapping anywhere on a `ContentCard` or a Happening Now card. Joining/leaving/responding disables the button, runs the write, then refetches — no realtime listeners, no optimistic counts.

## Social engagement (Likes, Comments)

`src/services/socialEngagement.ts`:

- `likeContent` / `unlikeContent` / `fetchMyLike` / `fetchLikeCount` — plain reads/writes, no transaction (there's no counter to keep paired — `fetchLikeCount` is a `getCountFromServer` aggregation). Liking requires a completed profile and published parent content; liking twice returns `alreadyLiked` instead of writing again.
- `createComment` / `deleteComment` / `fetchComments` / `fetchCommentCount` — comments are capped one-shot reads (`orderBy(createdAt desc)`, `limit(30)`), never an unbounded fetch. `fetchCommentCount` is also aggregation-based rather than loading every comment.

Every detail screen renders one shared `<EngagementSection contentId={...} />` (heart + Like count, comment icon + Comment count, a composer, and the comment list with an empty state and per-comment delete for your own comments) — the Like/Comment implementation exists in exactly one place, not duplicated across Post/Activity/Event.

Home intentionally does **not** run Like/Comment aggregation queries per card — that would be two extra reads per card × up to 20 cards on every Home load. Full engagement (counts, liking, commenting) is Content Detail only; Home cards stay exactly as they were.

## Social graph (public profiles, Follow)

`src/services/publicProfile.ts`:

- `fetchPublicProfile(uid)` / `fetchPublicProfileByUsername(username)` — the latter resolves username → uid via the existing `usernames/{usernameLower}` reservation, then reads `publicProfiles/{uid}`; it never scans `publicProfiles` itself.
- `ensureMyPublicProfile(uid)` — owner-only lazy migration for accounts that completed onboarding before Step 11. Returns the existing profile untouched if one's already there; only creates one (from the caller's own private profile) if missing. `ProfileProvider` calls this automatically, fire-and-forget, right after loading a completed profile, so it's transparent — no explicit user action required.

`src/services/following.ts`:

- `followUser` / `unfollowUser` / `isFollowing` — plain reads/writes on the deterministic `follows/{followerUid}_{followingUid}` document; no transaction needed since there's no counter to keep paired.
- `fetchFollowerCount` / `fetchFollowingCount` — `getCountFromServer` aggregation, never loads every follow edge just to count them.
- `fetchFollowers` / `fetchFollowing` — capped (`limit(30)`), no `orderBy` (a single equality filter needs no composite index this way; ordering isn't a Step 11 requirement), each edge resolved to a `publicProfiles/{uid}` read.
- `fetchFollowingUids` — same shape as `fetchFollowing` but returns bare uids instead of resolved profiles. This exists purely as a **foundation for a future personalized Following feed** — it's not wired to any UI. Around Me stays city-first (Home is unchanged); a real feed will eventually need to batch these into chunked Firestore `in` queries (30-value limit per query) or a different fan-out strategy once someone follows more people than fit on one page — intentionally not attempted here.

A subtlety worth knowing if you touch `firestore.rules`: the onboarding transaction creates `users/{uid}` and `publicProfiles/{uid}` in the **same** transaction, so the public-profile create rule can't validate against `get(users/{uid})` — that only sees the pre-transaction snapshot, and for a brand-new user the document doesn't exist there yet, which would make every signup fail. It uses `getAfter()`/`existsAfter()` instead (same pairing pattern as the participants/stats rules from Step 9), which correctly sees same-transaction writes.

`/user/{uid}` (public profile), `/user/{uid}/followers`, `/user/{uid}/following` are reachable by tapping any author, commenter, participant name, or `@username` throughout the app (`src/components/AuthorLink.tsx`) — including from inside a `ContentCard`, where it's nested inside that card's own tap-to-open-detail `Pressable` and calls `stopPropagation()` so only one of the two navigations fires.

## Location

Onboarding's city step can use `expo-location` for a one-time, foreground-only lookup ("when in use" permission only — no background location, no continuous tracking). It's used purely to derive a city + country, which get turned into a `cityKey` via `src/utils/cityKey.ts`. Raw coordinates only ever exist as local variables inside `src/services/location.ts` and are never sent to Firestore or persisted anywhere. Denying the permission doesn't block onboarding — manual city selection (country picker + city text field) always works.

## Scripts

- `npm start` — start the Metro dev server
- `npm run ios` / `npm run android` / `npm run web` — start and open on a platform
- `npm run lint` — run ESLint
- `npx tsc --noEmit` — type-check
