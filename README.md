# Around Me

Location-based social network organized around cities — "See what's happening around you, right now."

Email/password authentication, onboarding (name, username, city, interests), a full tab-based application shell (Home, Reels, Create, Inbox, Profile), and the real Firestore content backend (posts, activities, events) are implemented. Create → Post/Activity/Event → Publish is wired to that backend, and Home's Around You / Happening Now sections render the real city feed. Every content type has a real detail screen — Activity with Join/Leave, Event with Interested/Going, and all three with Likes and Comments — backed by Firestore transactions/writes and security rules. Every user also has a public social profile (separate from their private account data) with real Follow/Unfollow and follower/following lists, private 1:1 Direct Messages, and Block/Report safety controls (see the Reels section below for the newest addition — city-scoped short-video publishing and playback, backed by Cloud Storage).

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
      create/            Post/Activity/Event/Reel forms — stack screens above the tab bar, not tabs
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
                       storage.ts (Cloud Storage — Step 18), userProfile.ts (private profile
                       data layer), content.ts (posts/activities/events data layer),
                       engagement.ts (activity participation + event responses),
                       socialEngagement.ts (likes + comments), publicProfile.ts (public social
                       profiles), following.ts (follow graph), messages.ts (1:1 DMs),
                       blocks.ts, privacySettings.ts, reports.ts (safety), reels.ts
                       (Reel upload/publish/feed — see Reels section below), location.ts
                       (one-time city lookup)
  types/                Shared TypeScript types and type augmentations (user.ts = private,
                       social.ts = public profile + follow, reel.ts = Step 18 Reels)
  utils/                authErrors.ts, username.ts, cityKey.ts, cityDisplay.ts, timeFormat.ts
scripts/                delete-test-documents.cjs — explicit-ID-only disposable Firestore/Auth
                       test cleanup; delete-test-storage-objects.cjs — same pattern for exact
                       Cloud Storage object paths
firestore.rules         Firestore security rules (see Firestore section below)
firestore.indexes.json  Composite indexes the content/reels queries need
storage.rules           Cloud Storage security rules (Reel media only — see Reels section)
firebase.json           Firebase CLI config — Firestore rules/indexes + Storage rules
.firebaserc              Points the CLI at the around-me-6a437 project
```

`@/*` is aliased to `src/*` (see `tsconfig.json`), so imports look like `import { Colors } from '@/constants/theme'`.

## Firestore

App data lives in Cloud Firestore, on the same Firebase project as Auth (`around-me-6a437`). Collections so far:

- `users/{uid}` — the caller's own profile (`email`, `displayName`, `username`, `cityKey`, `interests`, etc.). **Private to its owner, always** — never made publicly readable, including after Step 11. Anything social-facing lives in `publicProfiles/{uid}` instead (see below), which is the entire reason that collection exists.
- `usernames/{usernameLower}` — a uniqueness index reserving each username to one `uid`. Created atomically with the profile in a single transaction (see `src/services/userProfile.ts`).
- `publicProfiles/{uid}` — the social-facing counterpart to `users/{uid}`, containing only what's safe to show any signed-in user: `displayName`, `username`, `usernameLower`, `cityName`, `countryCode`, `cityKey`, `interests`, `accountType`, `createdAt`, `updatedAt`. No email, GPS, tokens, or other private fields — enforced by Firestore rules requiring every field to exactly match the caller's own `users/{uid}` document on create. Created atomically alongside `users`/`usernames` during onboarding; accounts that completed onboarding before Step 11 get one lazily via `ensureMyPublicProfile()` (see Social graph below).
- `follows/{followerUid}_{followingUid}` — a directed edge in the social graph (`src/services/following.ts`), with a deterministic ID so at most one follow document can ever exist per (follower, following) pair. No copied profile data, just `followerUid`, `followingUid`, `createdAt` — resolve to `publicProfiles/{uid}` for display.
- `content/{contentId}` — one unified collection for `post` / `activity` / `event` (a discriminated union in `src/types/content.ts`), since Home will eventually be a mixed feed of all three. Reels live in their own separate `reels/{reelId}` collection instead — see the Reels section below for why.

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

For disposable Reel test videos in Cloud Storage, use the equivalent Storage-only script with exact object paths:

```bash
node scripts/delete-test-storage-objects.cjs "reels/<uid>/<reelId>/source"
```

Same rule applies: exact paths only, no bucket-wide or folder-wide delete.

## Personal and Business accounts (Step 30)

Around Me supports exactly two account types, chosen once during onboarding: **Personal** and **Business**. They are intentionally almost identical — the core rule is:

> **Business = Personal + the ability to create Events.** Nothing else differs yet.

There is no separate business application, no verification, no subscriptions, no dashboards, no analytics, no ads, no ticketing, and no organizer/company administration. "Business" does not mean "verified" — it is a self-declared account type, exactly like "Personal" is. There are no other account types (no organizer, creator, venue, admin, or "verified_business" — the Firestore rules reject any value outside the two-item allowlist).

- **Onboarding.** Account type is the *first* screen (`src/app/(onboarding)/index.tsx`), before name/username/city/interests. Both account types then go through the exact same subsequent steps (`name.tsx` → `city.tsx` → `interests.tsx`) — there is no separate business onboarding flow, and no extra fields (no company name, no org number, no business category, no multi-location support). A Business account's name lives in the same generic `displayName` field a Personal account uses.
- **Persistence.** `accountType: 'personal' | 'business'` (`src/types/user.ts`) is stored on `users/{uid}` and mirrored to `publicProfiles/{uid}` at onboarding, atomically with the rest of the profile (`src/services/userProfile.ts`). It is **immutable after creation** — the `users/{uid}` Firestore rule has no `allow update` at all, so no client code path (or Firestore Console edit, or anything short of a manual project-owner action) can ever flip an account between Personal and Business after signup.
- **Capability helper.** `src/utils/accountCapabilities.ts` exports `canCreateEvent(profile)` — the one place that checks `accountType === 'business'`. UI and route guards call this helper rather than comparing the raw field directly.
- **Create hub** (`src/app/(app)/(tabs)/create.tsx`). Personal accounts see Reel / Post / Activity. Business accounts additionally see Event. The Event option is *omitted* for Personal, not shown disabled — it isn't a "coming soon" feature, it's a capability the account doesn't have.
- **Direct-navigation guard.** Hiding Event from the Create hub is a UX nicety, not a security boundary — a Personal account could still deep-link to `/create/event` directly. That route (`src/app/(app)/create/event.tsx`) checks `canCreateEvent(profile)` itself and, if false, renders a "Event creation is for Business accounts" state with a way back to Create instead of the creation form.
- **Firestore enforcement (the real boundary).** `firestore.rules`' `isValidContentCreate()` only allows a `type: 'event'` write when the cached author profile has `accountType == 'business'` — Post and Activity stay open to both account types, untouched. This is enforced server-side regardless of what the client does; a Personal account's Firestore write for an Event is rejected with `permission-denied` even if some future client bug ever let the form render. Verified in production with disposable Personal + Business accounts against the real deployed rules: Personal Post/Activity → allow, Personal Event → deny, Business Post/Activity/Event → allow, an invalid `accountType` value (e.g. `'organizer'`) at profile-create time → deny, and an authenticated user attempting to mutate their own `accountType` after signup → deny.
- **Events discovery** (`src/app/(app)/(tabs)/events.tsx`) is not filtered by the viewer's account type — both account types browse Events identically. Its "Create event" CTAs (the empty-state action and the footer button) are gated by `canCreateEvent(profile)` and simply don't render for Personal accounts, rather than showing a disabled button or an "Upgrade to Business" prompt — there is no conversion flow to upgrade to yet.
- **Social graph, messaging, Reels, likes, comments, following** are identical and shared between the two account types — there is no second social graph, and no visual Business/Verified badge anywhere in this step. Personal and Business profiles render through the exact same Step 27 profile visual system.
- **Existing accounts.** No production account was migrated or backfilled for this step — every account created before Step 30 was already `accountType: 'personal'` from the original onboarding transaction, and no existing Event content (regardless of who authored it) was touched, hidden, or deleted.

## Create flow — visual reconstruction (Step 31)

The Create hub (`src/app/(app)/(tabs)/create.tsx`) hierarchy:

- **Personal** sees: **Reel** (primary, large hero card) → **Post**, **Activity** (secondary rows).
- **Business** sees the same, plus **Event** as a third secondary row — same capability model as Step 30, no new visual treatment (no "Business" badge, no "Verified", no "Pro"). Event is simply omitted for Personal, never shown disabled.

Reel is deliberately the visually strongest option — a full-width gradient hero card above the secondary list — because Home is a Reel-first social feed (Step 25); Post and Activity remain fully supported, just visually secondary on this one screen.

**Home City publication rule**, unchanged from Step 21: content always publishes to the signed-in user's **Home City**, never their **Active City** (the city they're currently browsing). The Create hub shows an informational banner when the two differ ("You're exploring X. New content publishes to your home city, Y.") — this is normal, not an error state, and there's no way to override it from Create.

**Post** — a general-purpose "share something with your city" post. It is no longer part of the main Home feed (Home is Reel-first as of Step 25); Post content surfaces on profiles and via direct content links. Its long-term product role is intentionally left open for a future audit — this step only redesigns its visual chrome, not its product placement.

**Activity** — "something people can join" — joining is direct and immediate (no RSVP/approval step), which the screen's own subtitle makes explicit.

**Event** — Business-only — "something people can respond to": viewers mark themselves Interested or Going rather than joining outright. No event image, ticket URL, price, or organizer-verification field exists yet; Event still has no media of its own (Storage/backend support for it doesn't exist).

Create Reel (`src/app/(app)/create/reel/index.tsx`) offers two real actions — record or choose from library — restyled as larger, filled (not dashed) media-first controls. The video preview stage dominates the screen once a video is selected, with a thin accent border signaling the "ready to publish" state; caption now uses the same shared `FormField` component as every other text field in the app (previously a separately-styled raw `TextInput`). The publish flow's three real stages (Creating → Uploading → Publishing) are unchanged; Uploading now also renders a slim progress bar under the existing percentage text, using the real upload-progress value — no fabricated progress is ever shown for stages where only a phase, not a percentage, is known. No music/filters/effects/templates/duet/stitch, no Place/Event/Business tagging (documented as future architecture only, not built) — same restrictions as Step 20/29.

The camera recording screen (`src/app/(app)/create/reel/camera.tsx`) and its permission-denied states were already at the target visual bar from Step 20 and are unchanged in this step — full-bleed camera, translucent pill overlays, real "Try again"/"Choose from library" actions, no dead buttons.

Every Post/Activity/Event/Reel creation screen now shares one subtitle style via `HeaderScreenLayout`'s new optional `subtitle` prop (previously each screen duplicated its own identical subtitle `Text`/style), and `FormField` gained a real disabled visual state (dimmed) for whenever a field is marked `editable={false}` during a busy/submitting state.

`PlaceSelector` now visually distinguishes a selected known Place (accent-colored pin icon + checkmark + accent border) from manually-typed text (a "Typed manually — not a saved place." hint, since a manually-typed place name is never a verified location). `DateTimeField`'s Start/End pills gained small calendar/clock icons for clarity — the underlying native date/time picker behavior (iOS inline spinner, Android imperative dialog, web HTML inputs) is unchanged.

Date/time fields use `@react-native-community/datetimepicker` on iOS/Android (`src/components/DateTimeField.tsx`) and plain HTML `date`/`time` inputs on web (`DateTimeField.web.tsx`, picked automatically by Metro's platform file resolution) — the picker package has no web support of its own.

Publish still calls the matching `create*` function in `src/services/content.ts` directly (screens never write to Firestore themselves); on success the app navigates back to Home, which refetches on every focus. Reel keeps its own two-phase upload lifecycle — see the Reels section below. None of this step touches Firestore rules, indexes, Storage rules, or the account-capability model — Personal/Business enforcement is exactly as Step 30 left it.

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

## City discovery: Home City vs Active City (Step 21)

Around Me is launching city-by-city (Karlstad first), and Step 21 introduces two distinct city concepts:

- **Home City** — the user's permanent social identity, read-only-derived from their completed profile (`users/{uid}.cityKey`/`cityName`/`countryCode`). Nothing in this step ever writes to `users/{uid}` or `publicProfiles/{uid}` just because someone browses a different city.
- **Active City** — a temporary, local-only browsing context that discovery surfaces query against. Starts equal to Home City; changed via the city switcher (`/cities`). Never sent to Firestore.

`src/providers/CityProvider.tsx` (`useCity()`) is the single source for both — `homeCity`, `activeCity`, `isExploringAnotherCity`, `setActiveCity(city)`, `resetToHomeCity()`. It's mounted once in the root layout (`src/app/_layout.tsx`), inside `ProfileProvider` (it needs the profile to compute Home City) and around the whole navigator, so deep-linked routes like `/reel/{id}` or `/user/{uid}` always have it available without any extra gating — Active City is discovery state, not an authorization gate, so its (brief, async) initial resolution never blocks or delays rendering those routes.

### Supported-city catalog

`src/constants/cities.ts` is the one shared source of truth — the city switcher, and the lightweight unit tests (`npm run test:cities`, via `tsx`), all read from `CITIES`, never a duplicated list. Sweden-focused for the initial launch, ten cities: Karlstad, Stockholm, Göteborg, Malmö, Uppsala, Västerås, Örebro, Linköping, Helsingborg, Jönköping. Each entry's `cityKey` is built with the exact same `buildCityKey(countryCode, cityName)` onboarding uses (`src/utils/cityKey.ts`), so a catalog entry and a real user's profile for the same city always produce an identical key with no separate mapping to keep in sync. No third-party city database (Google Places, GeoNames, Mapbox) — a small static list is sufficient for a city-by-city launch and avoids a new cost/API dependency. `searchCities(query)` is case-insensitive and diacritic-normalized (same stripping approach as `buildCityKey`), so typing "Goteborg" finds "Göteborg" without a fuzzy-search library.

### Persistence — per signed-in user

Active City is persisted in AsyncStorage under `aroundme.activeCity.{uid}` — **keyed by uid**, specifically so a shared device/browser can't leak one account's browsing city into another account's session (confirmed structurally: the key format itself makes cross-account leakage impossible, since each uid only ever reads/writes its own key). On sign-in, `CityProvider` reads that uid's stored key; if nothing is stored, or the stored value no longer resolves to a real catalog city, it falls back to that user's own Home City — never an error, never another account's city. `resetToHomeCity()` clears the stored key entirely rather than just setting it to the home value. No location history, no timestamp array, no server-side city-browsing tracking — this is exactly one current value, locally held, nothing more.

### Which surfaces use Active City

Around (`src/app/(app)/(tabs)/index.tsx`), Happening Now (same screen), and the Reels feed (`src/app/(app)/(tabs)/reels.tsx`) all query `activeCity.cityKey` — switching cities in the explorer refetches all three without an app restart, and any previous city's results are cleared immediately on switch (not just on the next successful fetch) so a stale city's content never renders under the new city's header while the fetch is in flight.

**Following stays city-aware, by design** — `FollowingFeed` receives `cityKey` from Home's Active City too, so if your Home City is Karlstad but you're exploring Stockholm, Following shows the people you follow's **Stockholm** content, not Karlstad's and not everything globally. This keeps the whole discovery context internally consistent: whatever city the header says, that's the city every discovery surface (including Following) is scoped to.

**What deliberately does NOT use Active City**: public profiles (`/user/{uid}`) always show that user's own real Home City, regardless of what the viewer is currently exploring; Inbox (Activity notifications, DM conversations) is global to the signed-in user's own social graph, not city-filtered at all; Create Post/Activity/Event/Reel always publish under the caller's **Home City** — see below.

### Creation always uses Home City — enforced by unchanged rules, not new client logic

Step 21 adds no new way for a client to supply a city when creating content. `createReelDraft`, `createPost`, `createActivity`, `createEvent` were already deriving the author/city snapshot server-side from the caller's own `users/{uid}` profile (see `src/services/reels.ts`/`content.ts`), and `firestore.rules`'s existing `isValidContentCreate`/`isValidReelCreate` already require the written `cityKey` to exactly match that profile — so a Karlstad user exploring Stockholm structurally cannot publish anything tagged Stockholm, with zero rules changes needed this step. The Create hub (`src/app/(app)/(tabs)/create.tsx`) shows an informational banner — "You're exploring Stockholm. Your posts are published to your home city, Karlstad." — whenever Active City differs from Home City, so this is never a surprise; it never blocks creation or silently changes anything.

### City switcher

`/cities` (`src/app/(app)/cities.tsx`) — a search field, a "Home" section (the user's actual Home City, with a checkmark when it's also the Active City), and an "Explore" section listing the rest of the catalog (Home City itself is filtered out of Explore to avoid a duplicate row). No map, no GPS, no external API. Tapping a city sets it Active and returns; a "Back to {Home City}" shortcut appears whenever actively exploring elsewhere.

### Empty/loading/error states are Active-City-aware

Around's empty state distinguishes "Nothing happening here yet. Be one of the first people to post in Karlstad." (on Home City) from "Not much happening in Stockholm yet. Explore another city or check back later." (while exploring) — the latter offers "Explore another city" instead of a Create CTA that would misleadingly suggest creating a Stockholm post. The Reels feed's empty state keeps its "Create Reel" CTA in both cases, but adds "Reels you create publish to your home city, {Home City}." while exploring, so the CTA is never misleading about where the Reel will land. Happening Now and Following each have their own Active-City-scoped empty copy. A failed city query shows "Couldn't load what's happening in {city}." with Try again — it never silently falls back to showing the previous city's content.

## Karlstad launch discovery (Step 22)

Step 22 doesn't add a new content model — it builds product surfaces on top of the existing `content/{contentId}` Activities/Events so Karlstad feels useful even with a small number of early posts.

### Discovery hierarchy

Home answers, top to bottom: **What's happening right now?** (Happening Now) → **What's happening today/tonight?** (Today/Tonight) → **What's coming up?** (Upcoming) → **What are people posting?** (Around feed). All four use Active City, never `profile.cityKey` (see Step 21's rule below). A dedicated `/events` screen (reached via each rail's "See all") shows the same three time-based sections merged into one filterable, chronological list — it is not a new bottom tab.

### Happening Now

Exact definition: `startsAt <= now AND endsAt >= now AND cityKey == activeCity.cityKey AND status == 'published'`, Activities and Events only — never Posts. `fetchHappeningNow` (`src/services/content.ts`, unchanged since Step 9) can't express both inequalities in one Firestore query (only one range filter per query is allowed), so it queries `startsAt <= now` ordered ascending and filters `endsAt >= now` client-side on the bounded result set — not a collection scan.

### Today / Tonight

One section, not two redundant ones (see `getTodayOrTonightWindow` in `src/utils/dateWindows.ts`): before 17:00 local time it's **Today** (the whole remaining calendar day); from 17:00 on it narrows to the evening-only window and relabels itself **Tonight**. "Local" here means a fixed `Europe/Stockholm` constant, not the viewing device's own timezone or any per-city timezone field — **content has no timezone field, and this launch is Sweden-only, so every city currently shares the same day-boundary math.** Real per-city timezone metadata is future work for international expansion; it is intentionally not persisted onto any content doc now. Day boundaries are computed by resampling the zone's actual UTC offset at the guessed instant (handles Sweden's DST transitions correctly) rather than assuming a fixed offset.

### Upcoming

The next 7 days, starting exactly where the Today/Tonight window ends (`getUpcomingWindow`) — not from `now` — so Today/Tonight and Upcoming never overlap by construction.

### Duplicate precedence

**Happening Now → Today/Tonight → Upcoming.** An item already shown in an earlier rail is filtered out of later ones by `contentId`. Today/Tonight and Upcoming can't overlap each other (see above); an item that's already started but hasn't ended yet could otherwise match both Happening Now and Today/Tonight, so `fetchDiscoverySections` (`src/services/content.ts`) explicitly excludes Happening Now's ids from Today/Tonight's results before returning. Both Home and `/events` call this one function, so precedence is enforced in exactly one place.

### Categories

Content categoryId and onboarding interests already share one taxonomy (`src/constants/interests.ts`) since Step 9 — Step 22 didn't need to add a mapping layer. `src/constants/launchCategories.ts` adds a Karlstad launch-facing shortlist as a pure DISPLAY/grouping layer over those same stable ids — no new ids were invented:

| Launch label | Existing `interests.ts` id |
| --- | --- |
| Nightlife | `nightlife` |
| Sports & Football | `sports` |
| Music | `music` |
| Food & Drink | `food` |
| Culture | `art` |
| Student | `student_life` |
| Family | `family` |
| Outdoor | `outdoors` |
| Community | `networking` |

Home's category chips filter Happening Now/Today/Upcoming in addition to the Around feed (previously they only filtered the feed) — a real categoryId (e.g. "Sports") narrows all of them; the `all`/`happening-now`/`events`/`activities` chips remain Around-feed view-mode toggles only (`isMetaCategoryFilter` in `src/constants/categoryFilters.ts`).

### No distance semantics

The app has no GPS/coordinate-distance calculation. Discovery copy always says "in Karlstad" / "around Karlstad" — never "500m away," "near you," or "closest," which would imply a capability that doesn't exist.

### Event vs Activity cards

`EventCard` (`src/components/EventCard.tsx`) is the one reusable discovery card for both types — an Activity badge or Event badge distinguishes them, plus a small "Join" pill on Activities as a visual hint (tapping still opens `/content/{contentId}`, where the real Join/Interested/Going actions already live — no separate detail architecture was created). Shows a NOW/Today/Tonight badge, category, and a tappable Place link when `placeId` is set (`/place/{placeId}`) or plain text when only a manually-typed `placeName` exists. Deliberately shows no attendance/popularity/price numbers — real RSVP/participant counts stay on the detail screen only, so a horizontal rail of cards never triggers one Firestore read per card.

### Place integration

`EventDetail`/`ActivityDetail` now make the place tappable (→ `/place/{placeId}`) whenever a known Place is linked, instead of always rendering plain text. The Place detail screen splits its existing bounded `fetchPlaceContent` result into Happening Now / Upcoming / Posts client-side (still one query, no new index) rather than one flat mixed list.

### Query/index strategy

No new Firestore indexes. Today/Tonight and Upcoming both add a second range clause on the same field (`startsAt`) to the existing `(type, cityKey, status, startsAt ASC)` composite index — Firestore allows multiple range filters on one field in a single query, so the index Step 9 already created covers Happening Now, Today/Tonight, and Upcoming. Caps: Happening Now/Today/Upcoming default to 20 each on Home, 15 each (45 total) on `/events`; no infinite scroll.

### Creation vs Home/Active City (unchanged Step 21 rule)

All discovery reads (Happening Now, Today/Tonight, Upcoming, `/events`) use `activeCity.cityKey`. Creation still always publishes under the caller's Home City — `/events`' own "Create event" CTA reads "Create event" when Active == Home, or "Create in {Home City}" with a one-line clarifying hint when exploring elsewhere; it never implies the post would land in the explored city.

### Launch-content provenance (seed tooling, not run against production)

`scripts/seed-launch-content.cjs` documents a fixture JSON shape (`type`, `title`, `description`, `categoryId`, `cityKey`, `placeId`/`placeName`, `startsAt`, `endsAt`, plus `sourceName`/`sourceUrl` for the preparer's own record) and validates it locally — but **this step never ran it against production with any real or invented events.** It deliberately does NOT reuse the `firebase login` CLI session other maintenance scripts use (that session's IAM permissions bypass Firestore Security Rules entirely) — instead, `--commit` mode signs in as a real, already-onboarded organizer account through the ordinary Firebase Auth client SDK, so every write is subject to the same rules a real user's own client would hit, and a fixture can't claim a city or identity the signed-in account doesn't actually have. `sourceName`/`sourceUrl` are never written to the public `content/{contentId}` schema — they stay in the local console log / an optional `--manifest-out` file only (see Section 33 below).

**Official Around Me city account (future, not built now):** a verified "Around Me Karlstad" account could publish launch content without needing dozens of individually-onboarded organizers, but Step 22 does not create it — that's an explicit future decision for the owner.

**Future external ingestion (not built now):** real-world event sources (a venue's calendar, a municipality listing) will eventually need `sourceUrl`/`sourceProvider`/`lastVerifiedTimestamp` provenance fields — deliberately kept OUT of the current social `content/{contentId}` schema for now, to avoid mixing a future scraping/import pipeline's concerns into the schema real users' own Posts/Activities/Events use today. `accountType` and the existing author-snapshot pattern already don't block a future `business`/`organizer` accountType from publishing Events the same way a `personal` account does.

### No-fake-content policy

No fake accounts, no fake attendance/RSVP counts, no fake distance, and no synthetic Karlstad "residents." Test accounts created for verification are disposable and deleted by exact ID immediately after (see Cleanup below).

## Home vs Events — core product separation (Step 25)

Around Me has two clearly separated primary experiences, locked in as of Step 25:

- **Home** (`src/app/(app)/(tabs)/index.tsx`) — the local, user-generated social/Reel feed. TikTok/Instagram-style vertical video, local-first. Home renders exactly one thing: Reels. It is **not** an event calendar, an event rail, an organizer feed, or a business directory — the Happening Now/Today/Upcoming/Around-feed sections that used to live here (Steps 21–22) moved to the Events tab; nothing about `fetchDiscoverySections`/`dateWindows.ts`/`EventCard` was touched, only Home's own use of them was removed.
- **Events** (`src/app/(app)/(tabs)/events.tsx`) — Event/Activity discovery. Official/local Events and Activities, whoever publishes them (see the Events visual reconstruction section below, Step 26).

Ordinary text Posts also no longer appear on Home — they still exist (`content/{contentId}`, `type: 'post'`) and remain visible on a user's own/public profile and via direct `/content/{contentId}` links, just not woven into a Home feed anymore.

### Home's two modes

- **For You** — every published Reel in Active City, newest-first (`fetchCityReels`). This is a plain reverse-chronological query, **not** a personalized ranking — no interest-based, like-based, or watch-time-based ordering exists.
- **Following** — published Reels in Active City from people the viewer follows (`fetchFollowingReels`, new this step). City-aware by the same rule as every other Following surface in this app (Step 21): if Home City is Karlstad but Active City is Stockholm, Following shows followed creators' Stockholm Reels, not Karlstad's.

Default tab is **For You**; the choice isn't persisted across a fresh mount (same non-persistence as the old Around/Following toggle it replaces).

### Following Reels — query design

`fetchFollowingReels` (`src/services/reels.ts`) mirrors `fetchFollowingFeed` in `content.ts` exactly: resolve followed uids (capped at 30) → chunk into groups of 10 → one `where('authorUid','in',chunk) + where('cityKey','==',...) + where('status','==','published')` query per chunk → merge, dedupe by `reelId`, sort by `publishedAt`, cap to the page limit. This needed exactly one new composite index — `reels` on `(cityKey, status, authorUid, publishedAt DESC)` — the only Firestore change this step made; no rules changes.

### Shared Reel feed component

`src/components/ReelFeed.tsx` is the one real feed implementation behind both Home and the standalone `/reels` route (`src/app/(app)/reels.tsx`, kept for direct navigation/compatibility — e.g. Home's future deep links — after Home itself became the primary Reel surface). It owns paging, active-item-only playback, the ±1-neighbor preload window, the options/report/block/share flow, and empty/loading/error rendering; callers only supply the fetched `reels`/`status` and a `topOverlay` (Home's city+tabs+filter row, or `/reels`' simpler back+city row). Paging/playback/engagement never exist as two drifting copies.

### Category filter

A lightweight bottom sheet (`ReelCategoryFilterSheet.tsx`) offering "All" + the existing stable `interests.ts` category ids, applied as a client-side filter over the already-bounded fetched list — not a new query parameter, not a personalization/preferences system.

### Right action rail — only real actions

Creator avatar (→ profile), like (real count, optimistic + rollback), comment (real count, → `/reel/{id}`), share (existing native share / copy-link). No bookmark/save icon (no Saved backend exists yet) and no share-count number (never tracked) — both deliberately omitted rather than faked.

### Deliberately not implemented this step

Saved/bookmarks, music/audio metadata, hashtag parsing, Reel place tagging, Reel event tagging, an inline follow-toggle on the avatar (existing Follow flow lives on the profile screen only), and any personalization/ranking signal. Reel place/event tagging is documented here as **future architecture only**: once a Reel can carry a `placeId`, an Event/Place detail page could show "Tagged at {Place}" using real linked Reels — not built now.

## Events discovery — visual reconstruction (Step 26)

Rebuilds the Events tab's layout/visual language on top of the exact same Step 22 discovery architecture (`fetchDiscoverySections`, `dateWindows.ts`, `content.ts`'s existing indexes) — no new query shapes, no new Firestore indexes, no rules changes. Home is untouched and remains the Reel-only surface (see above).

### Hierarchy

**Happening Now** (horizontal hero rail) → **Today/Tonight** (compact rows) → **This Weekend** (real Saturday+Sunday split, only shown when something in the current Upcoming window actually falls on one) → **Coming Up** (everything else in the same bounded Upcoming window). All four come from one `fetchDiscoverySections` call; "This Weekend" is a client-side filter of the already-fetched `upcoming` array by `getWeekendWindow()` (`src/utils/dateWindows.ts`) — not a second query. If nothing upcoming falls on the real Saturday/Sunday window right now, "This Weekend" is omitted entirely rather than shown empty or mislabeled onto a 7-day range.

### Header

Active City selector (left, → `/cities`, same as every other discovery surface), "Events" title (center), filter icon (right, opens `EventFilterSheet`) — deliberately does **not** carry a For You/Following toggle: that distinction belongs to Home's two Reel modes only (Step 25's locked-in product rule), even though an earlier reference screenshot showed similar-looking tabs.

### Filter

`EventFilterSheet` (`src/components/EventFilterSheet.tsx`) moves the exact same two real filters — All/Events/Activities, and the Karlstad launch category shortlist — behind the header's filter icon instead of permanent inline chrome, so the screen itself stays visual/scannable. No speculative filters (price/distance/popularity/ticket availability) — none of that data exists.

### Event vs Activity actions, directly on discovery cards

`EventActionButtons` (`src/components/EventActionButtons.tsx`) calls the exact same `src/services/engagement.ts` functions the detail screen uses (`setEventResponse`/`joinActivity`/`leaveActivity`) — Interested/Going for Events, Join/Joined for Activities, never both sets on the same card. It deliberately does **not** fetch the viewer's existing response/participation on mount: reading that once per visible card, on a screen that renders many cards, is the same N+1 read pattern real counts are excluded from (see below) — so the "selected" look is session-local optimism (what you just tapped), not a persisted read. The real, authoritative selected state and real counts still live on `EventDetail`/`ActivityDetail`, fetched once per screen visit, unchanged.

### Media fallback (no image field exists yet)

`content/{contentId}` still has no image field for Post/Activity/Event. `MediaCard` (`src/components/MediaCard.tsx`, extended this step) renders a dark gradient + soft accent glow + the item's real category emoji (from `interests.ts`) instead of a placeholder stock photo or an invented URL. `source`/real media stay fully optional on the component's props for future wiring — nothing is persisted now.

### Counts — real only, never per-card

No attendance/participant/interested/going numbers appear on any discovery card (hero, row, or upcoming) — `fetchEventResponseCounts`/`getActivityParticipation` are real aggregation reads that only make sense fetched once per detail-screen visit; fetching them for every card in a list would be exactly the N+1 read pattern this app avoids everywhere else (Reels' like/comment counts are the one precedent for small per-visible-item reads, and even there the list is capped and windowed to ~3 mounted items at once — the Events grid is not virtualized the same way, so the same tradeoff doesn't apply here).

### No fake anything

No Saved/bookmark icon (no Saved backend exists), no invented attendee counts, no "Verified"/"Official"/"Business" badges (current event authors are ordinary onboarded accounts — that distinction is real future work, not built now), no reference-screenshot content (no Vänerparken/342/27/64/Lund–Sommartider/sunset-photo placeholders were copied in).

### Future direction (documented, not built)

The product direction is for Events to eventually be published primarily by companies/venues/organizers/clubs rather than personal accounts — `content/{contentId}`'s existing author-snapshot pattern doesn't block a future `business`/`organizer` account type from publishing the same way a personal account does today, but no such account type, verification badge, or onboarding flow exists yet.

## Event card interaction state (Step 26.1)

The Step 26 discovery cards' Interested/Going/Join buttons never fetch the viewer's prior response/participation, so on a fresh load they render outlined/unfilled regardless of what the viewer actually responded previously — Step 26.1 investigated replacing that with a real, batched, N+1-free read and concluded it isn't achievable in this Firebase project without a schema change.

### What was tried

`content/{contentId}/responses/{uid}` and `content/{contentId}/participants/{uid}` both already carry a `uid` field, so a single `collectionGroup('responses'|'participants').where('uid','==', viewerUid)` query per screen visit could in principle return the viewer's own state for every currently-displayed card at once — one query total, not one read per card. Firestore's existing `allow read` rules for both subcollections don't restrict by `uid`, so no rules change looked necessary at first (`get()`-checking only the parent Event/Activity's `type`/`status`, same for every reader).

### What was found

Empirically, every `collectionGroup()` read attempt against this production project returned `permission-denied`, including:
- The intended query (`collectionGroup('responses').where('uid','==', viewer)`).
- The same query with no `where` clause at all.
- A `collectionGroup` query against a *different*, top-level collection (`publicProfiles`) with a trivially permissive rule (`allow read: if isSignedIn()`, no `get()` at all) — the exact same rule that lets a plain `collection()` query on that same collection succeed immediately.

That last test isolates the cause to the query TYPE (`collectionGroup`), not this project's specific rule content for `responses`/`participants`, not a missing index (a bare, filterless, unordered `collectionGroup` query needs none), and not rules-deploy propagation delay (retested after redeploying and waiting). An `isOwner(uid)`-based rule addition (self-contained, no `get()`) was also tried as a more Firestore-friendly rule shape for list safety-checking and made no difference. Enabling collection-group scope for the `uid` field via `firestore.indexes.json`'s `fieldOverrides` (confirmed live via `firebase firestore:indexes`) also made no difference.

### Decision

Collection-group querying is not usable in this project for this purpose without further platform-level investigation outside this step's scope. The only architecture that would deliver real batched state without collection-group queries is denormalizing membership directly onto `content/{contentId}` (e.g. a `respondedUids`/`goingUids`/`joinedUids` field, updated atomically alongside the existing subcollection writes) so the check becomes free — it comes for free with the discovery fetch already happening. That requires a schema change and new write-path invariants, which this step was explicitly told not to do, so it's documented here as **future architecture, not built now**, for the owner to decide on explicitly.

All rules/index changes made while investigating this were reverted before finishing — production `firestore.rules`/`firestore.indexes.json` are byte-identical to before this step. `EventActionButtons` therefore keeps its Step 26 design and doc comment (now noting this investigation): actionable, never claiming a false "not selected"/"not joined" state, showing only what the viewer taps within the current session — the "state-neutral" fallback the Step 26.1 spec itself sanctioned for exactly this outcome.

## Event/Activity Detail — visual reconstruction (Step 29)

Event and Activity detail (`src/app/(app)/content/[contentId].tsx` → `EventDetail`/`ActivityDetail`) are now media-first: a full-bleed `DetailHero` (shared by both) instead of the old plain header-bar-then-text-block layout. Post detail is completely untouched — it still renders inside the original `HeaderScreenLayout`, unchanged in structure, per this step's explicit scope.

### Hierarchy

Hero (media/fallback + title + category, overlaid) → date/time → Place → Interested/Going (Event) or Join/Leave + participant count (Activity) → description → creator → real engagement (likes) + comments, in that order. The one deliberate deviation from the spec's literal numbered list: "real engagement" (like count) and "comments" are the same pre-existing `EngagementSection` component with its own single real fetch — mounting it twice to place a stats-only view near the top and the full comment thread at the bottom would mean reading the same like/comment data twice per page visit. It's mounted once, at the end, rather than duplicate a read for a purely visual split.

### Hero

`DetailHero` (new, shared by Event and Activity) — the Step 26 `MediaCard` gradient/glow fallback with the item's real category emoji (no real event/activity media field exists, so no image is ever fabricated), a top scrim holding the only two hero actions (Back, and More — real Report/Block, only shown for other people's content, exactly as before), and a bottom scrim holding the real category + title. A `LIVE` pill (reusing the exact `isHappeningNow` check `EventCard` already uses) or an `Ended` pill appears only when genuinely true — never both, never invented.

### Interested/Going and Join/Leave

Unchanged backend and semantics — `EventDetail` still owns the real `setEventResponse`/`removeEventResponse` + `fetchEventResponseCounts` calls, `ActivityDetail` still owns real `joinActivity`/`leaveActivity` + `fetchActivityParticipants`. Only the buttons' visual language changed, to the same star/checkmark pill style `EventActionButtons` already uses on discovery cards (Step 26) — plus real counts next to each, since the detail screen (unlike a discovery card) already fetches them efficiently, once per visit.

### Event vs Activity — kept semantically distinct

Interested/Going (a lightweight RSVP) and Join/Leave (real membership, with a participant list and a `maxParticipants` cap) are genuinely different relationships, not a styling choice — `ActivityDetail` was not collapsed into `EventDetail`'s shape. They share the hero, the date/time/place rows, description, creator, and `EngagementSection` layout only.

### "Tagged at {Place}" — future architecture, not built

The reference screenshot's "Tagged at Nöjesfabriken" Reel rail is a real, locked-in **future** product concept, not a Step 29 deliverable: the Reels shown there would be **ordinary user-generated Reels from the normal Home feed** that happen to be tagged to the same Place/venue as the Event — never a special "Event Reel" content type, and Events/Reels remain two separate data models. `Reel` has no `placeId`/`eventId`/`businessId` field today, and Step 29 does not add one (no schema change, per the explicit constraint). A new `TaggedReelsSection` component exists (`src/components/TaggedReelsSection.tsx`) — it accepts a real `Reel[]` and a Place name, renders `Tagged at {name}`, and returns `null` for an empty array — but it is **not mounted anywhere in production**, since no real caller can ever produce a non-empty array yet. The intended future insertion point (right after the creator row in `EventDetail`) is marked with a comment.

### Loading/error

Shape-aware skeleton (hero-sized block + two text-line blocks) replaces the old plain "Loading…" text for the not-yet-typed loading state (content type isn't known until the fetch resolves, so this same skeleton briefly appears before either the media-first or the Post layout mounts). `ErrorState` (Step 24) replaces the ad hoc error panel; retry re-runs the real fetch.

### Firebase/security

No changes. No new Firestore rules, indexes, schema fields, or Storage rules — every real value shown was already being read before this step.

## Inbox — visual reconstruction (Step 28)

Inbox keeps its exact real information architecture — **Activity** (notifications) and **Messages** (1-to-1 conversations) — restyled into the Step 24/26/27 visual language. Never renamed to "Primary"/"Groups" from the reference screenshot: Groups (group chats) doesn't exist in this app, and relabeling around a feature that isn't there would misdescribe what the tab actually shows.

### Mode tabs

A local `InboxModeTabs` pill selector (Activity/Messages) with a real unread-message-count badge on the Messages pill — replacing the old `Messages (3)`-in-the-label text approach with a proper badge, matching the reference's visual treatment without inventing new data (the count is the same `conversation.unreadCounts[uid]` sum already computed before this step). Kept local to Inbox rather than folded into the shared `SegmentedControl`, so its badge support can't affect that component's other caller (Events' type filter).

### Messages search — real, local only

A search field appears in Messages mode **only when at least one real conversation exists** (no dead search box on a first-time empty Inbox). It filters the already-fetched, bounded conversation list (capped at 30 by `fetchConversations`) in memory by the other participant's real `displayName`/`username` or the real `lastMessageText` — no new Firestore read, no debounce (a plain in-memory `Array.filter` needs none), no global user search, no new route. An empty result shows "No conversations found." rather than the normal empty state, so a real empty inbox and a non-matching search are never confused.

### Conversation rows / notification rows

`ConversationRow`/`NotificationRow` avatars bumped 44→52px for more presence, and their unread-row tint fixed from a stale, hardcoded pre-Step-24 orange (`rgba(255, 107, 44, 0.08)`, left over from before the Step 24 pink-red accent shift) to the real `Colors.accentMuted` token — a genuine visual bug fix, not a new design decision. All other real behavior (tap-through to `/user/{uid}`, `/reel/{reelId}`, `/content/{contentId}`, or `/chat/{uid}`; mark-read/mark-all-read; pull-to-refresh) is unchanged.

### Loading/empty/error

Row-shaped skeletons (avatar circle + two lines, via the shared `SkeletonBlock`) replace the old plain skeleton bars for both Activity and Messages while loading. Empty/error states now use the shared `EmptyState`/`ErrorState` components. Messages' old "Explore Around" empty-state button was removed — it routed to `/` (Home, the Reel feed as of Step 25), which doesn't actually help start a conversation; the empty copy ("Start a conversation from someone's profile.") is enough on its own, per this step's explicit "don't invent a fake Find People button" instruction.

### Deliberately not implemented

Friend Requests row, Groups/group chats, online presence, the reference's active-people/story avatar strip, message media, typing indicators, read receipts, and push notifications — none of that exists in this app's real backend. The reference screenshot's Requests row and people strip are omitted entirely rather than rendered with fake counts or fake presence dots.

### Firebase/security

No changes. No new Firestore rules, indexes, or schema fields — the search is pure client-side filtering over data already being fetched.

## Profile v1 — visual reconstruction (Step 27)

Own Profile (`src/app/(app)/(tabs)/profile.tsx`) and public profile (`src/app/(app)/user/[uid]/index.tsx`) now share one visual system — `ProfileHeader`, `InterestPills`, `ProfileTabBar` — rather than two independently-styled screens. Own Profile's data-fetching was rebuilt to match public profile's existing real architecture (`fetchFollowerCount`/`fetchFollowingCount`/`fetchPublicUserContent`/`fetchProfileReels`) instead of the static placeholders it had before this step.

### Stats — real only

**Posts / Following / Followers**, in that order, on both screens. Follower/Following counts are real `getCountFromServer` aggregations (unchanged, cheap). Posts is `content.filter(item => item.type === 'post').length` over the same bounded `fetchPublicUserContent` result (`DEFAULT_FEED_LIMIT` = 20, mixed post/activity/event) already fetched for the content tabs — **not** a second query. This means an account with more than 20 total posts/activities/events combined can show an undercounted Posts number (only whichever posts fall within the newest 20 mixed items) — an explicit, documented MVP limitation, not a bug, matching the same "bounded and honest, not exact" tradeoff used elsewhere in this app (e.g. Following's 30-uid cap).

**No Likes total** — this app has no efficient authoritative aggregated like count across a profile's content, and computing one would mean an N+1 aggregation per profile visit. Not shown, not faked.

### No bio

`UserProfile`/`PublicProfile` have no bio field. No placeholder biography text is rendered — `ProfileHeader` simply has no bio slot to leave a gap in. Adding a real bio field is future work, not a Step 27 schema change.

### Content tabs

**Reels, Posts, Events, Activities** — in that order on both own and public profile, all four real and data-backed (the previous own-Profile screen's "Posts"/"Activities" tabs were static placeholders regardless of real data, and a "Saved" tab existed with no Saved backend at all — both fixed/removed this step). Reels render via `ReelPreviewCard` (now using `MediaCard`'s Step 26 gradient+glow fallback for a more premium grid look — no thumbnail generation, still no fake media). Posts/Events/Activities render via the existing `ContentCard`, tapping through to `/content/{contentId}` exactly as before.

### Edit profile — omitted, not disabled

No edit-profile route or profile-update service function exists anywhere in the codebase. The previous own-Profile screen showed a permanently `disabled` "Edit profile" button; Step 27 removes it entirely rather than keep a dead control — the Settings screen's Account section is likewise entirely omitted for the same reason (see below).

### Settings — real rows only

New `/settings` home screen (`src/app/(app)/settings/index.tsx`) using new `SettingsSection`/`SettingsRow` components (rounded dark card, icon + label + optional value + chevron, thin separators, destructive-red styling for Log out). Reached from Own Profile's top-right gear icon (replacing the old inline "Privacy & safety" row and the old inline Log out button, both moved here).

Sections shown, and only these:
- **Privacy** — "Message privacy" (shows the real current setting as its value) and "Blocked accounts" (shows the real blocked count), both routing to the existing `/settings/privacy` screen, which still handles both and is otherwise unchanged (message-privacy `everyone`/`people_i_follow`/`nobody` semantics and blocked-list unblock behavior are untouched).
- **Session** — Log out (moved from Profile; no longer duplicated in two places).

Sections deliberately **not shown**: **Account** (its only candidate row, Edit profile, isn't real), **Notifications** (no notification-preference backend or push system exists — no toggles that do nothing), **Content & Reels** (no real per-account content preferences exist). **Private Account** is not shown anywhere — this app has no private-account/follow-request architecture. **Delete account** is not shown — account deletion doesn't exist yet; that's explicit future work, not this step.

### Activity discovery-card state (Step 26.1 follow-up)

Reviewed per this step's instructions: the Step 26 discovery Activity cards already render Join as a plain, neutral, actionable pill (never a confident "Joined" claim before a real tap) — exactly the "state-neutral" outcome Step 26.1 investigated and landed on. No further change was made; swapping it for a "View activity" link would have been a regression (removing a real, direct action Step 26 was explicit about preferring), not a fix for anything still broken.

### Firebase/security

No changes. No new Firestore rules, indexes, or schema fields — every stat/tab above is computed from data already fetched by existing, unchanged services.

## Reels (Cloud Storage — Step 18)

Reels are short (≤60s), video-only posts with vertical, city-scoped playback — the first feature in this app to use Cloud Storage rather than Firestore alone. They live in their own root collection, `reels/{reelId}`, separate from `content/{contentId}` (posts/activities/events): a Reel has a media-upload lifecycle and Storage metadata that the other content types never had, and folding it into `content` would have meant giving every Post/Activity/Event query an upload-status field it never needs.

### Two-phase lifecycle

A Reel is never created already "published." `src/services/reels.ts` enforces two phases:

1. **`createReelDraft`** — writes `reels/{reelId}` with `status: "uploading"`, `publishedAt: null`, and every author/city/media field fixed up front (author snapshot from the caller's own `users/{uid}`, category, caption, and the video's own declared `storageContentType`/`fileSizeBytes`/`durationMs`/`width`/`height`).
2. **`uploadReelVideo`** — a resumable upload (`uploadBytesResumable`) of the picked video to `reels/{authorUid}/{reelId}/source`, the exact Storage path the draft already committed to. Progress (0–100%) is surfaced to the Create Reel screen; cancelling calls `discardReelDraft`, which best-effort deletes both the Storage object and the Firestore draft.
3. **`publishReel`** — the *only* allowed Firestore update on a Reel: `status: "uploading" → "published"`, `publishedAt: null → serverTimestamp()`. Every other field is immutable — enforced in `firestore.rules`, not just assumed client-side.

The Reels feed (`fetchCityReels`) only ever queries `status == "published"`, so an in-progress or abandoned upload never appears there, and its draft document remains readable only by its own author.

### The 50 MB / 60-second limits — what's actually enforced vs. declared

- **50 MB file size** is enforced by `storage.rules` against the **real, transferred byte count** (`request.resource.size`) — a client can't lie about this.
- **60-second duration** is a different story: Cloud Storage/Firestore Rules have no way to inspect a video file's actual duration. What's enforced is that the **declared** `durationMs` (read from the picker's own asset metadata) is ≤ 60,000 and matches what Firestore Rules validated at create time. A maliciously modified client could, in principle, declare a short duration while uploading a longer file. Real duration enforcement would require trusted server-side media processing (a Cloud Function that probes/transcodes the upload) — explicitly out of scope for Step 18. Treat the 60-second limit as a strong product convention backed by rules-level validation of the declared value, not a cryptographic guarantee about the video itself.

### Storage rules

`storage.rules` governs `reels/{authorUid}/{reelId}/source`, and independently cross-checks every operation against the real Firestore `reels/{reelId}` document via `firestore.get()`/`firestore.exists()` — Firebase's documented mechanism for a Storage rule to read Firestore:

- **Create**: caller must own the `authorUid` path segment; the uploaded object's *actual* size and content type (`video/.*`) are checked by Storage itself; `resource == null` makes this create-once (Cloud Storage has no real "update file content" operation — a second upload to an existing path is evaluated under this same `create` rule, not `update`, so the overwrite guard has to live here, not in `allow update`); **and** a matching Firestore Reel must exist, be owned by this exact `authorUid`, still be `"uploading"`, and have a `storagePath` field that exactly equals this object's path — so uploading before the Firestore draft exists, into someone else's path, or against an already-published Reel are all rejected by Storage itself, not just by convention.
- **Update**: always denied (no metadata-only replacement either).
- **Read**: any authenticated user, but *only* once the corresponding Firestore Reel is `status == "published"`. The app never needs an uploader to read their own still-uploading object via Storage (the Create Reel screen previews from the local picked file, never from Storage), so no such carve-out exists — an unrelated user can never read an "uploading" Reel's media.
- **Delete**: only the author, and only while the corresponding Firestore Reel is still `"uploading"` — `discardReelDraft`'s cleanup delete now actually succeeds for a genuine cancelled/failed upload. A published Reel's media can never be deleted by a client.

#### A real infrastructure gap this project hit (now fixed)

Getting the cross-service check working required one genuine IAM fix, discovered and resolved as a follow-up hardening pass (Step 18.1) after Step 18 originally shipped without it. Cross-service Storage→Firestore rules require the project's Cloud Storage service agent (`service-<PROJECT_NUMBER>@gcp-sa-firebasestorage.iam.gserviceaccount.com`) to hold the `roles/firebaserules.firestoreServiceAgent` IAM role (Firebase's own documented role for exactly this purpose, granting only `datastore.entities.get`). Firebase's docs say this gets granted via an interactive prompt "in the Firebase Console or Firebase CLI" the first time you publish rules using these functions — but deploying via the `firebase-tools` npm CLI (as this project always has) does **not** trigger that prompt (confirmed with `--debug` deploy output: no IAM-related call happens at all). The binding was missing, so every cross-service call failed as if the Firestore document didn't exist. Once the project owner granted that exact role through the Google Cloud Console, a dedicated diagnostic (an isolated `step18-diagnostic/{uid}/probe` Storage path plus a temporary `step18Diagnostic/{uid}` Firestore collection, both removed immediately afterward) confirmed `firestore.exists()` and `firestore.get()` both work correctly, and the rules above were restored to their originally-intended design.

An earlier, incorrect hypothesis (visible in this file's git history) blamed a Firestore/Storage region mismatch (`europe-north2` vs. `US-EAST1`). That was never an officially documented requirement, was disproven by the diagnostic above, and the bucket's region was correctly never changed. Cross-region Storage↔Firestore reads do cost extra latency per Google's own docs (~75ms per Firestore read) — a performance note, never an authorization cause.

### Playback

`storagePath` is what's persisted in Firestore — never a `getDownloadURL()` token URL. Playback URLs are resolved from `storagePath` at call time (`resolveReelPlaybackUrl`, cached in-memory for the session) via `expo-video`'s `useVideoPlayer`/`VideoView`. The vertical feed (`src/app/(app)/(tabs)/reels.tsx` + `src/components/ReelFeedItem.tsx`) tracks the active item via `FlatList`'s `onViewableItemsChanged` and only ever plays the currently-active item's player — every other item is paused, so at most one video decodes at a time. The Reel detail route (`src/app/(app)/reel/[reelId].tsx`) reuses the exact same playback architecture for a single, non-feed player.

### Preload/player-resource strategy (Step 19)

`useVideoPlayer`'s underlying `useReleasingSharedObject` recreates (and releases the previous) native player instance whenever its source changes — passing `null` as the source is a real, supported "no player resources held" state, not a placeholder. `ReelFeedItem` takes this a step further with a `shouldPrepare` prop: only the active item and its immediate neighbor on each side ever resolve a real playback URL or hold a live player; every other item's `playbackUrl` is forced back to `null` (releasing whatever it held) the moment it falls outside that window. `ReelsScreen` computes this window as `Math.abs(index - activeIndex) <= 1` and pairs it with `windowSize={3}` on the `FlatList` so distant items aren't even mounted. The result: at most 3 prepared players exist at once regardless of feed length, only 1 ever plays, and scrolling releases resources as it goes rather than accumulating them.

### Reel engagement (Step 19)

Reel Likes and Comments are **Firestore-only** — no Storage involvement, structurally parallel to `content/{contentId}`'s own Likes/Comments (`src/services/socialEngagement.ts`) but kept in a dedicated `src/services/reelEngagement.ts` module since Reels are a separate root collection:

- **Likes**: `reels/{reelId}/likes/{uid}` — `{ uid, createdAt }`, document ID is the liker's own uid (at most one Like per user). Self-likes are allowed (matches content Like behavior); unliking stays allowed even if a Block was created after the Like, so a Block can never trap a stale Like.
- **Comments**: `reels/{reelId}/comments/{commentId}` — `{ commentId, authorUid, authorDisplayName, authorUsername, body, createdAt, updatedAt }`, 1–500 characters, no edit, no replies. Same author-snapshot validation pattern as content comments.
- **Counts**: always `getCountFromServer()` aggregation queries (`fetchReelLikeCount`, `fetchReelCommentCount`) — no `likeCount`/`commentCount` field is stored on the Reel document itself, avoiding write amplification on every Like/Comment.
- **Block-aware**: both Like and Comment creation deny if either user has blocked the other (`isNotBlockedEitherWay`, same helper as content).

Notifications gain two new types, `reel_like` and `reel_comment`, alongside a new optional `reelId` field on `Notification` (`src/types/notification.ts`). Exactly one of `contentId`/`reelId` is ever non-null for a given notification; every existing `like`/`comment`/`follow` write now sets `reelId: null` explicitly. Old, pre-Step-19 notifications that predate the field entirely keep working — `isValidNotificationUpdate` in `firestore.rules` reads it via `.get('reelId', null)` rather than plain dot access, specifically because Firestore Rules errors out on dot-accessing a genuinely absent map key. Both new types follow the exact same atomic-pairing pattern as their content equivalents: the Like/Comment write and its notification land in the same `writeBatch`, and Firestore Rules independently verify (via `existsAfter`) that the real Like/Comment actually exists before allowing the notification — a client can never fabricate one.

Notification navigation: `NotificationRow` shows "{Actor} liked your Reel" / "{Actor} commented on your Reel" (with preview) and routes to `/reel/{reelId}` on tap (`src/app/(app)/(tabs)/inbox.tsx`'s `handleRowPress`), reusing the same `read`/mark-as-read plumbing as every other notification type.

### Reel detail route

`src/app/(app)/reel/[reelId].tsx` — a stable, ID-addressable route (fetches the Reel fresh by ID, never relies on feed-index state) used by notification taps, profile Reel cards, and anywhere else a direct link to one Reel is needed. Shows a single video player (native controls, muted-by-default autoplay), author, caption, and `ReelEngagementSection` (like button + comment list + composer, structurally parallel to `EngagementSection`). Report/Block are available via the same `OptionsMenu`/`ReportModal`/`ConfirmDialog` components used everywhere else in the app.

### Public profile Reels tab

The public profile screen (`src/app/(app)/user/[uid]/index.tsx`) gained a fourth content tab, "Reels", alongside Posts/Activities/Events. `fetchProfileReels` (`src/services/reels.ts`) queries `authorUid == uid && status == 'published'`, ordered by `publishedAt desc`, capped at 30 — a dedicated, explicitly-limited query, never the whole `reels` collection filtered client-side. Since Step 19 has no thumbnail generation, each Reel renders as a compact `ReelPreviewCard` (play icon, caption, published time on a plain surface card) rather than a real video frame — no video is loaded just to populate a grid. Tapping a card opens `/reel/{reelId}`. Empty state offers a "Create Reel" shortcut on the viewer's own profile.

### Reel creation: camera + library, one unified flow (Step 20)

Create Reel (`src/app/(app)/create/reel/index.tsx`) offers **Record video** and **Choose from library** side by side before either permission is ever requested — no camera/microphone prompt until "Record video" is tapped, no photo-library prompt until "Choose from library" is tapped (same minimum-permissions rule as Step 18). "Record video" is only shown on native (`Platform.OS !== 'web'`): `expo-camera`'s `CameraView` implements video recording (`recordAsync`/`stopRecording`) only on Android/iOS — its web ref exposes picture capture only, no recording methods at all — so offering it on web would be a dead end rather than a working feature.

Recording (`src/app/(app)/create/reel/camera.tsx`) is a focused, filter-free screen: camera + microphone permissions requested together on entry (audio recording needs both), a 60-second hard cap via `recordAsync({ maxDuration: 60 })` — enforced by the API itself, not just a UI countdown — front/back toggle (disabled mid-recording, since flipping cameras stops an in-progress recording per `expo-camera`'s own docs), and a live `00:07 / 01:00` timer. A denied permission shows "Camera access is needed to record a Reel." with **Try again** and **Choose from library** — never a dead end.

Both sources normalize into one local-only `SelectedReelVideo` type (`src/types/reel.ts`: `uri`, `source: 'camera' | 'library'`, and nullable `fileSizeBytes`/`durationMs`/`width`/`height`/`mimeType`) that the rest of the screen — preview, validation, publish — treats identically regardless of origin. `source` exists purely to drive UI copy ("Retake" for camera vs. "Choose another" for library) and is never written to the published `Reel` document; there's no product reason for that to be visible anywhere.

The two sources differ in what metadata they hand back: `expo-image-picker`'s library asset already carries real fileSize/duration/width/height. `expo-camera`'s `recordAsync()` resolves to only `{ uri }`. For camera-sourced video, `resolveCameraVideoMetadata` (`src/utils/cameraVideoMetadata.ts`) fills in the gap for real — it briefly loads the recording into an `expo-video` `createVideoPlayer` instance and reads `duration` + `availableVideoTracks[0].size` from the player's own `sourceLoad` event, and file size comes from `expo-file-system`'s current `File` class (`new File(uri).size`). If either can't be determined before an 8s timeout, the result is `null` — **never a fabricated number** — and `validateSelectedReelVideo` (`src/utils/reelVideoValidation.ts`, the one shared validator both sources now go through) rejects the selection with an honest error instead of letting an unverifiable video reach Publish. mimeType for a camera recording is inferred from its real file extension (`.mp4`/`.mov`/`.m4v`/`.webm`) — an unrecognized extension is rejected, never defaulted.

The recorded-video handoff from the camera route back to the entry screen (`src/services/reelCameraHandoff.ts`) is a one-shot module-level value read via `useFocusEffect` when the entry screen regains focus — not a router param, since Expo Router params aren't meant for handing an ephemeral local-file URI back to the exact screen instance already underneath the camera route on the navigation stack.

Preview adds a play/pause toggle (no scrubbing, no trim, no filters — out of scope) and never uploads until Publish is pressed; retaking a camera recording or choosing a different library video before that point never touches Firestore or Storage, since `createReelDraft` is only ever called from the Publish handler. Publish shows plain-language progress ("Creating Reel…" → "Uploading NN%" → "Publishing…") and, on upload/publish failure, a dedicated banner with **Try again** (retries the whole publish, keeping the local video selected — no need to re-record) and **Cancel** (discards the failed draft via the existing `discardReelDraft` cleanup and returns to the ready-to-publish state). On success, navigation goes to `/reel/{reelId}` — not the feed — so the user gets deterministic confirmation of exactly which Reel published.

### Share (Step 20)

A published Reel's shareable identity is always its `reelId` via the app's own `/reel/{reelId}` route (`src/utils/reelShare.ts`) — never a Storage path, a `getDownloadURL()` token, or a feed position. Share is only ever offered once a Reel is confirmed loaded and published (Reel detail's overflow menu, and each feed item's own overflow menu now that it's shown for own Reels too, not just others').

`shareReel` uses React Native's own `Share.share()` — react-native-web forwards this to `navigator.share()` and rejects cleanly (a catchable error, not a crash) when the browser doesn't support it, which is exactly what happens today: no separate sharing package was needed. On that rejection (or if the user just wants a link instead of the OS share sheet), **Copy link** uses `expo-clipboard`'s `setStringAsync`, with a small in-screen toast ("Link copied") — no system alert.

`buildReelShareUrl` picks the link itself based on what's actually running:
- **Web**: `${window.location.origin}/reel/{reelId}` — the real, currently-serving origin (confirmed by `expo export --platform web` actually emitting `/reel/[reelId]` as a route), never a hardcoded guess like `aroundme.com`. We don't own a production domain yet, so in local development this is a `localhost` URL — genuinely correct for what's running, not a placeholder.
- **Native**: `aroundme://reel/{reelId}` — the app's own registered scheme (`app.json`'s `"scheme": "aroundme"`, already in place before Step 20). This only resolves for someone who already has this exact app installed; without a web domain to back a Universal Link/App Link, there's no graceful "open the App Store instead" fallback yet. That's a real, documented limitation of not having shipped a web presence, not something client code can paper over.

Deep-link foundation: Expo Router derives everything from the file-based routes plus `app.json`'s `scheme` automatically — there is no separate linking-config file in this project, and Step 20 didn't need to add one. `/reel/{reelId}` (and `aroundme://reel/{reelId}` on native) already resolves to the same route that fetches a Reel fresh by ID and shows a clean "Reel not available" for a missing/unpublished Reel rather than crashing or leaking uploading-Reel metadata — this was already true from Step 19's own detail route and needed no change here.

Nothing here adds a `shareCount`, a `viewCount`, or any "shares" collection — sharing and playback both stay writes-free, matching the existing no-view-count/no-analytics boundary.

### Own profile Reels tab (Step 20)

The own-Profile tab screen (`src/app/(app)/(tabs)/profile.tsx`) gained a real, data-backed "Reels" tab (its Posts/Activities/Saved tabs remain the pre-existing static placeholders — out of scope for this step) using the same `fetchProfileReels`/`ReelPreviewCard` the public profile tab already used. Empty state offers a "Create Reel" CTA, since this screen is always the viewer's own profile.

### Not in Step 20 (or earlier)

A video timeline editor, trimming UI, transitions, filters, beauty filters, a music catalogue, licensed audio, text overlays, stickers, AR effects, duets, stitches, reposts, view counts, saves, creator analytics, transcoding, Cloud Functions, and push notifications are all explicitly out of scope.

## Location

Onboarding's city step can use `expo-location` for a one-time, foreground-only lookup ("when in use" permission only — no background location, no continuous tracking). It's used purely to derive a city + country, which get turned into a `cityKey` via `src/utils/cityKey.ts`. Raw coordinates only ever exist as local variables inside `src/services/location.ts` and are never sent to Firestore or persisted anywhere. Denying the permission doesn't block onboarding — manual city selection (country picker + city text field) always works.

## Scripts

- `npm start` — start the Metro dev server
- `npm run ios` / `npm run android` / `npm run web` — start and open on a platform
- `npm run lint` — run ESLint
- `npx tsc --noEmit` — type-check
- `npm run test:cities` — city catalog unit tests (Step 21)
- `node scripts/seed-launch-content.cjs --file <fixtures.json>` — validates a launch-content fixture file (dry run by default; see the Karlstad launch discovery section above for the fixture shape and why `--commit` requires a real organizer account, never the CLI/IAM session)
- `node scripts/delete-test-documents.cjs` — exact-ID cleanup for disposable verification accounts/documents
