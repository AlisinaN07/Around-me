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

The reference screenshot's "Tagged at Nöjesfabriken" Reel rail is a real, locked-in **future** product concept, not a Step 29 deliverable: the Reels shown there would be **ordinary user-generated Reels from the normal Home feed** that happen to be tagged to the same Place/venue as the Event — never a special "Event Reel" content type, and Events/Reels remain two separate data models. `Reel` has no `placeId`/`eventId`/`businessId` field today, and no step adds one yet (no schema change).

Step 29 added a `TaggedReelsSection` component as speculative future-ready scaffolding, wired nowhere. Step 32's product audit and a fresh re-check at Step 35 both confirmed it was never mounted by any live screen and had no real caller that could ever produce a non-empty array — dead code, not a dormant feature — so Step 35 deleted `src/components/TaggedReelsSection.tsx` and the commented-out `<TaggedReelsSection ... />` JSX/doc-comment that referenced it in `EventDetail.tsx`. **This did not touch the product decision above** — "Tagged at {Place}" remains approved future work; building it for real means adding a `placeId` (or `eventId`) to `Reel`, a real tagging UI, a real "Tagged at {Place}" query, and only then a real rendering component — none of which existed here, so there was nothing worth preserving in code, only in this document.

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

**Posts / Following / Followers**, in that order, on both screens. All three are now real, exact `getCountFromServer` aggregations — see "Profile Posts stat accuracy (Step 35)" below for why Posts changed from an in-memory derivation to its own count query.

**No Likes total** — this app has no efficient authoritative aggregated like count across a profile's content, and computing one would mean an N+1 aggregation per profile visit. Not shown, not faked.

### Bio

As of Step 33, `UserProfile`/`PublicProfile` have a real optional `bio` field — see "Profile editing and account recovery (Step 33)" below. `ProfileHeader`'s bio slot renders only when non-empty, same rule as before.

### Content tabs

**Reels, Posts, Events, Activities** — in that order on both own and public profile, all four real and data-backed (the previous own-Profile screen's "Posts"/"Activities" tabs were static placeholders regardless of real data, and a "Saved" tab existed with no Saved backend at all — both fixed/removed this step). Reels render via `ReelPreviewCard` (now using `MediaCard`'s Step 26 gradient+glow fallback for a more premium grid look — no thumbnail generation, still no fake media). Posts/Events/Activities render via the existing `ContentCard`, tapping through to `/content/{contentId}` exactly as before.

### Edit profile

As of Step 33, Edit Profile is real — see "Profile editing and account recovery (Step 33)" below. (Step 27 itself removed the old permanently-`disabled` "Edit profile" button rather than keep a dead control, since no backend existed yet at that point.)

### Settings — real rows only

New `/settings` home screen (`src/app/(app)/settings/index.tsx`) using new `SettingsSection`/`SettingsRow` components (rounded dark card, icon + label + optional value + chevron, thin separators, destructive-red styling for Log out). Reached from Own Profile's top-right gear icon (replacing the old inline "Privacy & safety" row and the old inline Log out button, both moved here).

Sections shown, and only these:
- **Privacy** — "Message privacy" (shows the real current setting as its value) and "Blocked accounts" (shows the real blocked count), both routing to the existing `/settings/privacy` screen, which still handles both and is otherwise unchanged (message-privacy `everyone`/`people_i_follow`/`nobody` semantics and blocked-list unblock behavior are untouched).
- **Session** — Log out (moved from Profile; no longer duplicated in two places).

As of Step 33 an **Account** section is also shown, with a real "Edit profile" row (see below). Still deliberately **not shown**: **Notifications** (no notification-preference backend or push system exists — no toggles that do nothing), **Content & Reels** (no real per-account content preferences exist). **Private Account** is not shown anywhere — this app has no private-account/follow-request architecture. **Delete account** is not shown — account deletion doesn't exist yet; that's explicit future work (Step 34), not this step.

### Activity discovery-card state (Step 26.1 follow-up)

Reviewed per this step's instructions: the Step 26 discovery Activity cards already render Join as a plain, neutral, actionable pill (never a confident "Joined" claim before a real tap) — exactly the "state-neutral" outcome Step 26.1 investigated and landed on. No further change was made; swapping it for a "View activity" link would have been a regression (removing a real, direct action Step 26 was explicit about preferring), not a fix for anything still broken.

### Firebase/security

No changes. No new Firestore rules, indexes, or schema fields — every stat/tab above is computed from data already fetched by existing, unchanged services.

## Profile editing and account recovery (Step 33)

The first functional-completion step after the Steps 24–31 visual reconstruction. Adds the two account fundamentals every real user needs: editing your own profile, and recovering access if you forget your password. Account **deletion** is deliberately not part of this step — its cleanup/security model needs its own isolated review (Step 34).

### Editable fields

`/profile/edit` (`src/app/(app)/profile/edit.tsx`, reached from Own Profile's new "Edit profile" button and from Settings → Account → Edit profile) lets a signed-in user change:

- **Display name** — same 2–50 character rule as onboarding (`DISPLAY_NAME_MIN_LENGTH`/`DISPLAY_NAME_MAX_LENGTH` in `src/types/user.ts`, now shared by both `name.tsx` and this screen instead of duplicated).
- **Username** — same normalization/format rules as onboarding (`normalizeUsername`), same live-availability check (`checkUsernameAvailability`) — with one addition: keeping your *current* username is recognized and short-circuits the availability check instead of reporting it "taken" against yourself.
- **Bio** — new, optional, plain text, capped at 160 characters (`BIO_MAX_LENGTH`). No HTML parsing, no links, no hashtags.
- **Interests** — same shared `InterestSelector` component (extracted from the onboarding screen, which now uses it too instead of its own inline copy) and the same 3–8 count rule.

**Home City** and **Account Type** are shown read-only in a small info panel at the bottom of the form and are never included in the update payload at all — not merely hidden by the UI, but structurally absent from what the client ever sends.

### Bio

Stored as a real, always-present string — never `null`, never a missing key. New accounts get `bio: ''` at onboarding (`createInitialUserProfile`). **Existing-user compatibility**: accounts created before this step have no `bio` field in Firestore at all; `fetchUserProfile`/`fetchPublicProfile` normalize a missing `bio` to `''` at the read boundary, so every other call site can treat `profile.bio` as always a real string. No production migration was run and no existing document was touched — the normalization happens purely at read time, and a legacy account gets a real `bio` field the first time it's ever edited.

Displayed on `ProfileHeader` (own and public profile) only when non-empty — no "Add a bio" placeholder is ever shown on someone else's profile.

### Username transaction

Changing your username is one atomic Firestore transaction (`updateMyProfile` in `src/services/userProfile.ts`), mirroring the exact sequence `createInitialUserProfile` already used at onboarding:

1. Read the caller's current `users/{uid}` document (all reads happen before any write, per Firestore transaction rules).
2. If the normalized new username differs from the current one: read `usernames/{newUsernameLower}` — if it already exists, abort with `username-taken`.
3. Update `users/{uid}` and `publicProfiles/{uid}` together with the same field values (`displayName`, `username`, `usernameLower`, `bio`, `interests`, `updatedAt: serverTimestamp()`).
4. Only if the username actually changed: reserve `usernames/{newUsernameLower}` and delete `usernames/{oldUsernameLower}` — in the same commit as step 3.

If the username is unchanged, steps 2 and 4 never touch the `usernames` collection at all — no unnecessary delete/recreate of your own reservation.

### Firestore profile security

`users/{uid}` gained a narrow owner-only `allow update` (previously there was none at all — profile editing didn't exist). It permits changing only `displayName`, `username`/`usernameLower`, `bio`, and `interests`; every other field (`uid`, `email`, `cityName`, `countryCode`, `cityKey`, `accountType`, `onboardingCompleted`, `createdAt`) must be byte-identical to its prior value, enforced field-by-field, plus a fresh `isServerTimestamp(updatedAt)` on every update and the same `keys().hasOnly([...])` allowlist as create.

`publicProfiles/{uid}` gained a matching owner-only `allow update` (previously `if false`) that requires the editable fields to exactly equal the **post-commit** `users/{uid}` document via `getAfter()` — the same technique `isValidPublicProfileCreate` already used for the onboarding transaction — so the public mirror can never drift from the private profile, and immutable fields must match what `publicProfiles/{uid}` already had.

`usernames/{usernameLower}` gained a narrow `allow delete`: a user may delete a reservation only if it names them as owner (`resource.data.uid == request.auth.uid`) **and** their own `users/{uid}` document, read via `getAfter()` in the same commit, now has a *different* `usernameLower` than the document being deleted. This is only ever true during a real rename happening in the same atomic write — it can't be used to delete another user's reservation, and can't be used to delete your own *current* reservation while leaving `users/{uid}` still pointing at it.

Full ALLOW/DENY matrix (owner edits, cross-user denial, accountType/cityName/email/uid/onboardingCompleted/createdAt immutability, bio length, interests count, username format, username theft, reservation-deletion misuse, publicProfiles drift, extra fields) is in `tests/firestore.rules.test.mjs` and was verified against the real deployed rules in production with disposable accounts (the local emulator has the same sandbox networking limitation documented in Step 30/31).

### AccountType immutability

Unchanged from Step 30, and now doubly guaranteed: the create rule's allowlist check still exists, and the new update rule independently asserts `accountType` is unchanged on every edit. Edit Profile's form never includes `accountType` in its payload at all — there is no code path, malicious or otherwise, by which this screen could send it.

### Home City immutability

Home City is not editable in this step — shown read-only on `/profile/edit`. Active City (browsing another city) remains completely separate and unaffected. Home City editing is intentionally deferred as its own, more deliberate future step.

### Historical snapshots

Editing your profile changes your `users`/`publicProfiles` documents and therefore every *future* profile view and *future* content you create. It does **not** rewrite `authorDisplayName`/`authorUsername` already stored on existing Post/Activity/Event/Reel/comment/message documents — those are point-in-time snapshots taken at creation, by design (see the Firestore section above). This is intentional MVP behavior, not a bug: an old Post keeps showing the display name you had when you posted it.

### Settings

Settings gained a real **Account** section with one row, "Edit profile" — Settings' existing "real rows only" rule (Step 27) is preserved; this row is included specifically because it now has a real route and a real backend, not despite that rule.

### Password reset

`AuthProvider.resetPassword(email)` (`src/providers/AuthProvider.tsx`) wraps Firebase Auth's `sendPasswordResetEmail` directly — no custom reset-token screen exists or is needed, since Firebase's own emailed link handles the actual password change outside the app. Login gained a "Forgot password?" link to the new `/(auth)/forgot-password` screen, which asks only for an email and shows a clear "Check your email" confirmation with a "Back to login" action — it never auto-logs the user in.

**Account enumeration safety**: whether or not the entered email actually belongs to an account, the user sees the identical neutral confirmation ("If an account exists for this email, we've sent password reset instructions."). Only genuine service failures (network problems, rate limiting) surface as a real, retryable error — `auth/user-not-found` specifically is treated the same as success.

## Trusted account-deletion backend (Step 34.2)

Steps 34 (read-only design audit) and 34.1 (read-only feasibility proof) established that account deletion cannot be done from the client: `content/{contentId}` and published `reels/{reelId}` have no client-side delete rule under any circumstance, `conversations`/`messages`/`reports` are `allow delete: if false` unconditionally, and there is no way for a client to discover every cross-user artifact (likes/comments/responses/participation left on *other* users' content) without either a reverse-index registry or a trusted backend. Step 34.1 proved, against production, that the Admin SDK's `collectionGroup()` queries succeed once the right Firestore indexes exist — they hit `FAILED_PRECONDITION` (missing index), never `permission-denied` — so **no reverse-index/denormalized-ownership registry is required**. This step builds the real backend on that finding.

### What this step does NOT do

No Delete Account UI exists yet (no Settings row, no confirmation screen, no reauthentication prompt) — that is Step 34.3. This callable also never calls any Firebase Auth deletion API; the Auth account itself is untouched and remains signed-in-capable after this callable runs. Both are deliberate, locked decisions from the Step 34 audit: Auth deletion must happen last, once, only after every other cleanup step has already succeeded, and only behind a real reauthentication UX.

### Cloud Functions foundation

`functions/` is a minimal Firebase Cloud Functions 2nd-gen (`firebase-functions/v2/https`) TypeScript workspace, requiring Node 22 (`firebase-admin@14.3.0`'s own `engines` constraint) — separate from the mobile app's Node 20. Deployed to **`europe-north1`** (Finland): Firestore lives in `europe-north2` (Stockholm), which is not itself a supported 2nd-gen Functions region, so this is the closest region that actually is, chosen by genuine geographic proximity after confirming (via Firebase's own docs) there's no direct mapping for Stockholm.

### The callable: `deleteMyAccountData`

A single `onCall` callable. **Security boundary**: the target uid comes exclusively from `request.auth.uid` — there is no `uid`/`targetUid`/`userId` parameter of any kind, and `request.data` is never read for identity. An unauthenticated call is denied (`unauthenticated`); a call that deliberately sends `{ uid: someoneElse }` has that payload silently ignored, verified in production. Runs at `timeoutSeconds: 300`, `memory: '256MiB'` — sized for pagination-based cleanup of up to roughly 100 Reels and 1,000 follows per user, not for holding everything in memory at once.

**Deletion policy** (owner-locked in Step 34):

| Data | Policy |
| --- | --- |
| Posts/Activities/Events the caller authored | DELETE (subcollections first, then the parent) |
| Reels the caller authored | DELETE Firestore doc + Storage object + subcollections |
| Caller's own likes/comments/responses/participation on *other* users' content/Reels | DELETE |
| Follow graph, block graph (both directions) | DELETE |
| Notifications (as recipient and as actor) | DELETE |
| Conversations/messages | **RETAIN** — never mutated, deleted, or read for content; a future "Deleted user" chat-display fallback is a later concern |
| Reports (in every direction) | **RETAIN** — never mutated or deleted; reason/details text never appears in this callable's response |
| Profile documents | DELETE last, in dependency order (see below) |

**Idempotency**: every phase treats a missing document/object as "already cleaned," never an error. Verified in production by invoking the callable twice in a row for the same account — the second call returns all-zero counts with no errors.

**Pagination**: every query that could return many documents uses "query a bounded page (≤400 docs), delete it, repeat until empty," never an unbounded `get()` or a cursor (a cursor is unsafe here since deleting shifts the result set out from under it).

**Activity participation — counter integrity**: `content/{activityId}/stats/activity.participantCount` is an invariant-protected counter. When the caller is a participant on *someone else's* still-existing Activity, their participant doc is removed and the counter decremented by exactly 1 inside one Admin Firestore transaction — verified by production test to decrement exactly once on the first call and not again on a retry. When the caller is deleting their *own* Activity, other participants' docs are not individually counter-corrected — the whole `stats/activity` doc is removed with the parent, so a per-doc decrement would be wasted work. If a cross-user Activity's stats document is missing or its `participantCount` looks corrupt, that one item is left untouched and recorded as an error rather than risking corruption of another user's data.

**Reels**: Storage objects are deleted only at their exact, schema-derived path (`reels/{authorUid}/{reelId}/source`) — never a prefix, never a recursive folder delete — using `ignoreNotFound: true` so an already-missing object counts as success. Both still-`uploading` drafts and `published` Reels go through this same authoritative path, unlike the client-only `discardReelDraft()`.

**Profile documents**, deleted last and in this order: `privacySettings/{uid}` → `publicProfiles/{uid}` → `usernames/{usernameLower}` (read from the still-present `users/{uid}` document, and only deleted if that reservation's own `uid` field actually still matches the caller — a mismatch is left untouched and recorded, never force-deleted) → `users/{uid}` **last of all**, since `usernameLower` must still be readable from it right up until that point.

**No reverse-index architecture**: confirmed unnecessary. The only Firestore change this step needed was four collection-group indexes (`likes.uid`, `comments.authorUid`, `responses.uid`, `participants.uid`, all `COLLECTION_GROUP` scope, configured via `firestore.indexes.json`'s `fieldOverrides` rather than its composite `indexes` array, since these are single-field indexes) — no Firestore Rules change and no Storage Rules change were needed or made; the Admin SDK bypasses both via IAM, not by loosening either.

### Production verification

Verified against real disposable accounts (no emulator — this sandbox's Firestore emulator networking is broken, the established fallback throughout this project): a Personal account (own Post/Activity/Reel-with-real-Storage-object, plus every cross-user interaction type on a second account's content) and a Business account (own Event + Reel). Confirmed independently via direct Firestore reads (not just trusting the callable's own response): full cross-user cleanup, the Activity counter decrementing exactly once and not on retry, both accounts' own content/Reels/Storage/profile fully gone, the DM conversation and report documents fully intact and unaltered on both sides, and — for the Business account — the Firebase Auth account still able to sign in after its data was deleted. All fixture data (including both disposable Auth accounts) was removed afterward via `scripts/delete-test-documents.cjs`'s exact-ID deletion; the real owner account was never touched.

## User-facing account deletion (Step 34.3)

The trusted backend from Step 34.2 had no way for a user to actually reach it. This step builds that path: Settings → Delete account → explanation → type DELETE → password → the backend runs → the Firebase Auth user is deleted last → the user lands back at the signed-out welcome screen. All logic lives in one shared component, `src/components/DeleteAccountFlow.tsx`, used both for a fresh deletion and for resuming an interrupted one.

### Exact sequence

1. **Confirm** — the user types `DELETE` (exact, case-sensitive — no normalization) and enters their password. The destructive CTA stays disabled until both conditions hold.
2. **Reauthenticate** — `EmailAuthProvider.credential` + `reauthenticateWithCredential`, via a new `AuthProvider.reauthenticateWithPassword`. This happens **before** any deletion, not after, and this order is deliberate (see below).
3. Only once reauthentication succeeds: a local marker is set (`aroundme.deletionPending.{uid}`, see below), then
4. **Backend** — `deleteMyAccountData` (Step 34.2) is invoked with no arguments; the callable derives everything from the caller's own ID token.
5. **Auth deletion** — only after the backend reports success, `AuthProvider.deleteCurrentUser()` calls Firebase Auth's `deleteUser`, using the still-fresh reauthentication from step 2.
6. Local cleanup (the deletion-pending marker, the deleted uid's stored Active City preference, a one-shot "just deleted" notice) and the user is automatically returned to the signed-out `(auth)` stack once `isAuthenticated` flips false — no manual navigation needed.

### Why reauthentication happens before the backend, not after

The original naive order — delete data, then reauthenticate only if Firebase complains the login is stale — has a real failure mode: the backend succeeds, cleanup completes, and *then* Auth deletion fails on a "recent login" requirement, leaving an Auth-only account with no Around Me profile and no easy way back in. Reauthenticating first means that by the time Auth deletion runs, the login is always fresh, and the failure mode shrinks to "Auth deletion itself failed for some other reason" — handled explicitly (see below), not silently.

### Settings entry and warning screen

Settings' Account section gained a destructive "Delete account" row (`src/app/(app)/settings/index.tsx`) leading to `/settings/delete-account`. The warning screen explains specifically what's deleted (profile, Reels, Posts, Activities, follows/social interactions, plus **published Events** for Business accounts specifically) and specifically what's retained (messages already sent may remain visible in other people's conversations; reports are retained for safety/moderation history) — no implementation terms like Firestore/Storage, and no vague "this cannot be undone" standing alone. A single bold line states deletion is permanent with no grace period, no temporary deactivation, and no recovery window — because none exist (locked policy, Step 34).

### Wrong password / network failure

`reauthenticateWithPassword` throws the raw Firebase error; `auth/wrong-password`/`auth/invalid-credential` shows "Incorrect password.", `auth/network-request-failed` shows a retry-safe network message — in both cases the backend is never called, no local marker is ever set, and no account data changes. If the signed-in user unexpectedly has no email at all (Section 11's edge case), the screen stops before asking for a password and shows a controlled "contact support" state instead of guessing credentials.

### Partial-failure handling

If the backend call itself fails, the screen shows "We couldn't finish deleting your account. Try again." and offers a retry that re-invokes the same idempotent callable — no re-authentication needed for that retry, since the ID token is still valid. If the backend succeeds but Auth deletion fails (rare — e.g. the reauthentication window closed), the screen shows "Your Around Me data has been removed, but we couldn't finish deleting your login account," asks for the password again, and retries both the (now-trivially-idempotent) backend call and the Auth deletion. The local deletion-pending marker is deliberately **not** cleared on this path — see below.

### Deletion-pending recovery (local marker, no new Firestore schema)

`src/utils/deletionPending.ts` stores one flag per uid (`aroundme.deletionPending.{uid}`, AsyncStorage) — set right after reauthentication succeeds, immediately before the first destructive backend call, and cleared only after the Auth user is actually deleted. This solves a real routing bug: `src/app/_layout.tsx`'s root navigator otherwise reads a missing `users/{uid}` document as "onboarding incomplete" and would route a signed-in user whose data was already deleted (but whose Auth session survived a crash/close mid-flow) straight into onboarding. With the marker, the root navigator instead routes to a new top-level `deletion-recovery` route (outside `(app)`/`(onboarding)`/`(auth)`, since it must override both) whenever `isAuthenticated && isDeletionPending`, ahead of the onboarding/app guards. That screen reuses the same `DeleteAccountFlow` (in `mode="recovery"`) — no DELETE retyping (that destructive decision was already made), just a fresh password and a retry of backend + Auth deletion. Explicitly evaluated and rejected: a persistent Firestore "deletion job" document — the existing idempotent, re-derivable-from-existence-queries backend made that unnecessary; the marker is local UX/recovery routing only, never a security boundary (the backend still trusts only `request.auth.uid`).

### Local data cleanup

On full success, the deleted uid's stored Active City preference (`aroundme.activeCity.{uid}`, `src/providers/CityProvider.tsx`) is removed via a new exported `clearStoredActiveCityForUid` — never any other uid's. `ProfileProvider` needed no change: its profile value is already derived as `result.uid === currentUid ? result.profile : null`, so it naturally reads as `null` the instant `user` becomes `null` post-deletion — no stale cached profile risk existed.

### Deleted-user chat fallback and send-blocking

Conversations and messages are retained forever (locked policy) — meaning a surviving participant can open a conversation whose other side no longer has a `publicProfiles/{uid}` document. `ConversationRow` and the Chat screen (`src/app/(app)/chat/[uid].tsx`) now render "Deleted user" with a generic initials avatar instead of a blank/broken state, message history stays fully intact and readable, and the composer is replaced with a plain notice instead of a live input. No fake profile is ever reconstructed. Sending a **new** message to a deleted account was already impossible before this step: `sendMessage` (`src/services/messages.ts`) has always required the target's `publicProfiles/{uid}` to exist before writing anything, for both a brand-new conversation and a reply on an existing one — verified, not assumed, and required no rule or service change.

### Testing

Verified against three disposable production accounts (no emulator) through the real browser UI, not just the backend directly: a Personal account (wrong password rejected with nothing changed, then a correct full deletion — backend cleanup, Auth deletion, session cleared, old credentials confirmed to fail login afterward) and a Business account (same flow, with the Business-only "published Events" line visible on the warning screen; its authored Event and Reel confirmed gone via direct navigation as a third account, Storage cleanup already proven by Step 34.2). The retained conversation between the two accounts was confirmed fully intact and readable by the survivor, showing the "Deleted user" fallback correctly. Both reports (one per direction) were confirmed retained with their reason/details unaltered, read via the trusted CLI session since both reporters' Auth accounts were by then gone. Notably, **all three accounts' Auth entries were already gone by the time cleanup ran** — the feature's own Auth-deletion step had already done that job; only the locked-RETAIN conversation/messages/reports needed explicit exact-ID cleanup afterward. The deletion-pending recovery marker's persistence was independently confirmed via the one-shot post-deletion notice (identical AsyncStorage read/write path) correctly surviving a full page reload and displaying after a real deletion; a live reproduction of the exact mid-flight-interruption scenario itself could not be forced in this browser-automation environment, since the full reauth→backend→Auth-delete sequence for a small fixture account completes faster than the tooling's round-trip latency — the routing guard in `src/app/_layout.tsx` was instead verified by direct code review.

## Profile Posts stat accuracy + dead-code cleanup (Step 35)

A small, scoped cleanup step — no visual redesign, no new features. Around Me's account lifecycle (password reset, Edit Profile, account deletion, Personal/Business handling, deletion recovery) was left untouched.

### Profile Posts stat accuracy

Both profile screens (own `src/app/(app)/(tabs)/profile.tsx` and public `src/app/(app)/user/[uid]/index.tsx`) previously derived the "Posts" stat as `content.filter(item => item.type === 'post').length` over `fetchPublicUserContent`'s bounded, mixed (Post/Activity/Event) result — capped at `DEFAULT_FEED_LIMIT` (20). An account with more than 20 total pieces of content could have older Posts silently excluded from that array, undercounting a number the UI presents as authoritative.

Fixed with a new `fetchProfilePostCount(uid)` in `src/services/content.ts`, using Firestore's server-side `getCountFromServer` aggregation — one count read, zero documents transferred, no client-side scan, and no `limit()` clause of any kind, so it's exact regardless of how much content a user has authored. Its filter (`authorUid == uid`, `type == 'post'`, `status == 'published'`) matches `fetchPublicUserContent`'s own published/visibility semantics exactly, so a user's Posts stat can never disagree with what a profile would otherwise consider "their published content." Both profile screens now fetch this in the same `Promise.all` as their other stats/content — a failure surfaces through the screen's existing error state (`ErrorState`/retry), exactly like a Follower-count failure already did, rather than ever rendering a confidently wrong "0". The Reels/Posts/Events/Activities content **tabs** are deliberately unchanged — they still use the same bounded `fetchPublicUserContent`/`fetchProfileReels` queries as before; only the Posts **stat number** became exact.

No Firestore Rules change: `getCountFromServer` is subject to the same `content` read rule as every other query here (`status == 'published'`, readable by any signed-in user). No new Firestore index was needed — verified empirically against production (not assumed): the three-equality-filter count query (`authorUid`/`type`/`status`, no `orderBy`) succeeded immediately, and a small real fixture (3 Posts + 2 Activities for one disposable account) confirmed the count returns exactly 3, distinct from the 5-item mixed total — proving the `type` filter, not just the query's absence of a `limit()`, is doing real work. Cost: one additional aggregation read per profile visit, no listeners.

### Legacy Map route removed

`src/app/(app)/map.tsx` — orphaned since the Map tab was removed from the tab bar and replaced by Inbox (Step 15) — was re-verified unreachable at this step's HEAD (no `/map` string, `router.push`, `href`, or import referencing it anywhere in `src/`) and deleted. This is a **route** removal only: `MapPlaceExplorer`, `NativeMapScreen`, `NativeCityMap.*`, `useCityPlaces`, `PlaceFilters`, `PlaceList`, the `expo-maps` package, and every other piece of real Place architecture are untouched — Places, place detail, `PlaceSelector`, `placeId`/`placeName` on content, and the future geographic-discovery direction they represent are not what was dead here; only the one abandoned tab screen was.

### TaggedReelsSection removed — concept preserved

See "'Tagged at {Place}' — future architecture, not built" above: the unused `TaggedReelsSection` component and its commented-out JSX/doc-comment reference in `EventDetail.tsx` were deleted as dead code. The underlying "Tagged at {Place}" product concept remains fully documented and approved for future work — nothing about that decision changed, only the premature, never-mounted scaffolding for it.

### Dead-code search (this step's scope)

Beyond the two removals above, this step's repo-wide search for `/map` references and `TaggedReelsSection` references found no other orphaned routes or dead component references in scope. A broader dead-code sweep (e.g. auditing every component for live importers) was not performed — out of scope for this step's three named goals.

## Auth/onboarding/secondary-screen visual polish (Step 36)

A visual-consistency step only — no new product features, no Firebase/Rules/Storage/Functions changes. The goal: a new user should never feel a jump from "old prototype UI" to "polished app" while moving through Auth, onboarding, or the social-list/city screens.

### What was actually legacy

A source-level audit found that Auth (Welcome, Login, Signup, Forgot Password), all four onboarding screens (Account Type, Name/Username, City, Interests), and the Cities screen already used the Step 24+ design system (`FormField`/`Button`/`FormScreenLayout`/`HeaderScreenLayout`/`OnboardingProgress`/`InterestSelector`, `Colors`/`Spacing`/`Radius` tokens) from earlier steps — they needed no changes. The one genuinely legacy surface was `src/components/UserList.tsx`, the shared list behind Followers/Following, which still used ad-hoc `Pressable`/`Text` styling instead of the shared components.

### UserList rebuilt

`UserList` was rewritten to compose existing shared components rather than introduce new ones: `HeaderScreenLayout` for the screen chrome, `LoadingState`/`ErrorState`/`EmptyState` for its three non-happy-path states, and `AuthorLink` (unchanged, already handled `router.push` + `stopPropagation`) for each row's tap-through, wrapping an `Avatar` + display name + `@username` + city. The external prop API (`title`/`emptyText`/`fetcher`) was kept identical, so the calling routes (`src/app/(app)/user/[uid]/followers.tsx` and `following.tsx`) needed no changes.

### Interests screen: selected-count indicator

`src/app/(onboarding)/interests.tsx` gained a small `"{n} of {MAX_INTERESTS} selected"` text between the `InterestSelector` and the error text, using the already-exported `MAX_INTERESTS` constant. `InterestSelector` itself already enforced the cap internally; this only makes the cap visible.

### Features intentionally omitted

Per the step's scope, these were deliberately not added anywhere in Auth/onboarding, since none of them exist elsewhere in the app: social login, GPS beyond the already-existing `detectCurrentCity` on the City screen, friend requests, online-presence indicators, fake/algorithmic recommendations, and verification badges.

### No Firebase/security changes

No Firestore Rules, Storage Rules, Functions, or index changes — this step touched only two client-side view files (`UserList.tsx`, `interests.tsx`).

## Global people search (Step 37)

Closes the basic social-discovery loop: Home → Search → type a username → tap a result → real Public Profile → Follow/Message from there.

### Scope: username only, no external search service

Search is a `usernameLower` prefix range query directly against `publicProfiles` — the same collection every other profile lookup here already reads from. There is no display-name search, no `displayNameLower`/`searchTokens` schema, no Algolia/Typesense/Elasticsearch, and no recommendations — this is intentionally the smallest possible discovery primitive. Personal and Business accounts are equally searchable and rendered identically in results: no verified/official/business badge exists anywhere in this app, and this step didn't add one.

### Query and normalization

`searchPublicProfilesByUsername(normalizedQuery)` in `src/services/publicProfile.ts` runs `where('usernameLower', '>=', q)` / `where('usernameLower', '<=', q + '')`, `orderBy('usernameLower')`, `limit(20)` — the standard Firestore prefix-range pattern, capped at 20 reads per completed query, no pagination. `normalizeUsernameSearchQuery` in `src/utils/username.ts` strips one leading `@`, trims, and lowercases — deliberately more permissive than `normalizeUsername` (no length/character-set validation), since a partial prefix like `"a"` is never itself expected to be a valid username. A plain-string range query can't be broken by unexpected input, so there's nothing else to guard against.

Empirically verified against production (not assumed): the query succeeded immediately with no missing-index error and no Firestore Rules change — `publicProfiles` already allows `read` (covering `list`) to any signed-in user (Step 11), and Firestore's automatic single-field index on `usernameLower` is sufficient for a pure range query with no additional filters. `firestore.rules` and `firestore.indexes.json` are both untouched by this step.

### Search screen (`src/app/(app)/search.tsx`)

A 300ms debounce and a 2-character minimum keep this from querying on every keystroke or on an empty/near-empty string. A monotonic generation counter discards any in-flight response that a newer keystroke has already superseded (typing `al` → `ali` → `alix` quickly can never let `al`'s slower response overwrite `alix`'s). Five distinct states are rendered explicitly and never conflated: idle (before 2 normalized characters — "Find people on Around Me / Search by username."), loading (a small inline spinner, not a full-screen takeover), loaded-with-results, loaded-with-zero-results ("No people found" — only ever shown after a query actually completes), and error (a real retryable state, never silently downgraded to "no results"). The current user's own uid is filtered out of results client-side. My own outgoing blocks are fetched once per screen visit via the existing bounded `fetchMyBlockedUserIds` (the same mechanism Home already uses for its own client-side content filtering) and filtered out client-side too — this is one-directional by design: there's no efficient way to check whether someone has blocked *me* without an extra read per result, so that direction is left entirely to Public Profile's own pre-existing, unmodified block guard.

Search results intentionally carry no inline Follow/Message action — tapping a row always goes to the real Public Profile first, which is the sole owner of Follow/Message/Block/Report. This keeps each result to exactly one document read (its own `publicProfiles` doc, nothing more).

### Global, not Active-City scoped

People Search deliberately ignores Active City — a Karlstad user can search and find a Stockholm user directly by username. Each result still shows its home city for context (reusing the same `formatCityDisplayName` + row layout as Followers/Following, via a shared `ProfileList`/`ProfileRow` extracted from `src/components/UserList.tsx`).

### Entry point

A `search-outline` icon was added to Home's existing top-right icon group, next to the pre-existing category-filter icon — Active City, Following/For You, and the filter button are all unchanged. `/search` is a plain authenticated route (`src/app/(app)/search.tsx`), not a tab — the bottom navigation stays Home/Events/Create/Inbox/Profile.

### Regression-tested against real production fixtures

Using three disposable accounts (Personal, Business, Personal), verified: a shared prefix returns both the Personal and Business account identically; an exact full username returns only that account; a leading `@` normalizes to the same result as without it; a nonexistent prefix returns zero, not an error. Renaming a disposable account's username through the real Step 33 `updateMyProfile` transaction confirmed the old prefix stops matching and the new one starts matching immediately — there's no separate search index to go stale, since search reads `publicProfiles` directly. Calling the real deployed `deleteMyAccountData` trusted-backend callable (Step 34.2) against a disposable account confirmed it disappears from search the moment its `publicProfiles/{uid}` document is gone.

## Event / Activity engagement notifications (Step 38)

Completes the in-app notification set alongside like/comment/follow/reel_like/reel_comment (Step 15/19): responding to someone's Event, and joining someone's Activity, now notify that Event/Activity's author. In-app Inbox only — no push infrastructure of any kind was added.

### Event response — one logical notification per (event, actor)

A response notification is keyed deterministically as `event_response_{eventId}_{actorUid}` — there is never a separate "Interested" and "Going" notification for the same person's response to the same Event. Switching Interested ↔ Going updates this same document: `responseStatus` changes to the new value, `read` is forced back to `false`, and `createdAt` is deliberately bumped to a fresh server timestamp (not preserved) so the notification re-sorts to the top of the recipient's Inbox — the product intent is that a changed response reads as a new Activity update, not a stale entry. Only `notificationId`/`recipientUid`/`actorUid`/`actorDisplayName`/`actorUsername`/`type`/`contentId` are immutable identity fields; nothing about the underlying Like/Follow-style "everything except read is frozen" pattern applies to this one field. Tapping the same response again is a client-side no-op (`setEventResponse` only touches the notification when the status actually changes) and is additionally backstopped at the rules layer (a same-value "update" is rejected). Removing a response deletes the paired notification in the same transaction.

### Activity join — one notification per (activity, actor), while joined

Keyed as `activity_join_{activityId}_{actorUid}`. Created only on a genuinely first-time join (the existing "already joined" early-return means this is always a create, never an update) and deleted the moment the actor leaves. A join rejected for being full or ended never reaches the notification write at all — the participant document's existence is what the notification-create rule checks, so "notification exists" already implies "a real join succeeded."

### Self-notifications: never

Both flows compare the actor's uid against the content's `authorUid` before touching the notification — an author responding to or joining their own content (where the product doesn't already block that) writes the response/participation but never a notification, both client-side and as a Firestore Rules backstop.

### Atomicity

`setEventResponse`/`removeEventResponse` were converted from plain reads/writes into `runTransaction` calls (previously not transactional) so the response and its notification always land — or fail — together. `joinActivity`/`leaveActivity` already used a transaction for the participant + `stats/activity` counter pairing (Step 9); the notification create/delete was added into that same transaction rather than a separate write, so a join can never produce a notification without the participant doc, or vice versa.

### Firestore Rules

Two new narrow create-validators (`isValidEventResponseNotification`, `isValidActivityJoinNotification`) follow the exact same "the underlying doc must existAfter() in the same write, and its content must match the notification's claim" pattern as every prior notification type. A new `isValidEventResponseStateUpdate` function is the only rule in this collection that ever allows a non-`read` field to change — gated to the notification's own actor (not the recipient), requiring the new `responseStatus` to actually differ from the old one, and requiring `getAfter()` on the response doc to match. `isValidNotificationDelete` gained two more type-specific `existsAfter()` branches (response absent / participant absent).

One necessary, narrowly-scoped rule correction was required and confirmed empirically against production before it shipped: notifications were previously readable only by their `recipientUid`, but `setEventResponse`/`removeEventResponse`/`leaveActivity` all need the **actor** to read their own already-existing notification inside a transaction (to decide create-vs-update, or whether a delete is needed at all) — an unconditional delete/update of a notification the actor can't even read would either be denied outright or risk the documented "null `resource`" failure mode this codebase has hit before. The read rule now also allows `actorUid == request.auth.uid`, but **only** for `event_response`/`activity_join` — every other notification type's read permission is completely unchanged.

### No new fields beyond what's needed

`Notification` gained exactly one new field, `responseStatus: EventResponseStatus | null` — null for every pre-existing type (mirroring how `reelId` was introduced in Step 19), set only for `event_response`. No Event/Activity title snapshot was added to the notification — copy reads "is interested in **your** event" / "joined **your** activity," which needs no target-content text, keeping the schema minimal.

### Reused, not duplicated

Recipient is always `content.authorUid` — never participants, followers, or anyone else. Navigation reuses the Inbox's existing generic `contentId` → `/content/{id}` branch unchanged (no new routing code). Actor snapshot fields come from the same `resolveTrustedFields`/profile read the response/join write already needed — no extra profile read added for notification purposes. The unread count is the existing real `!notification.read` filter — no second counter, no new listener. `deleteMyAccountData` required zero Functions changes: it already deletes every `notifications` doc where `recipientUid == uid` or `actorUid == uid`, regardless of type — verified against production that an Activity-join notification an account generated is correctly removed when that account is deleted through the existing trusted backend.

## Moderation authorization foundation (Step 39.1)

Step 39 (read-only architecture audit) found reports (Step 17) had no reviewer, no status, and one rule inconsistency. Step 39.1 builds the smallest secure moderation foundation on top of that finding — admin identity, a report lifecycle, and exactly one moderation action (dismiss) — without building any admin UI, report queue, content-removal action, or account suspension/ban. Those are explicitly later phases.

### Admin identity is a Firebase Auth custom claim, never `accountType`

Moderator authorization is the standard `admin: true` Firebase Auth custom claim, set only via the Admin SDK from a trusted operator context — never via any client write, never derived from `users/{uid}.accountType`, and never a hardcoded uid in shipped code. `AccountType` stays exactly `'personal' | 'business'`; admin is a completely orthogonal token claim that either account type can independently carry. The real owner account has **not** been granted this claim — moderation was proven end-to-end using disposable synthetic Firebase Auth accounts only, created, tested, and fully deleted within this step. Granting the owner's own account the claim is a deliberate later decision, not something this step does automatically.

### Report lifecycle: `open` → `dismissed` / `resolved`

`Report` (`src/types/report.ts`) gained three fields: `status: 'open' | 'dismissed' | 'resolved'`, `moderatedAt: Timestamp | null`, `moderatedByUid: string | null`. Every new report is created `status: 'open'` with both moderation fields `null` — `src/services/reports.ts`'s four report-creation functions all spread the same `INITIAL_MODERATION_FIELDS` constant, and `firestore.rules`' `isValidReportBase` independently enforces the exact same three values on create, so a client can never submit a report that's pre-seeded as `dismissed`/`resolved` or carries a fabricated `moderatedAt`/`moderatedByUid`. `resolved` is reserved for a future moderation-removal callable (Step 39.2+) — nothing in this step ever sets it.

Reports created before this step have none of these three fields. They are never migrated — trusted backend code (the `dismissReport` callable) simply treats a missing `status` as `'open'` when read, and writes the canonical fields only as part of a genuine dismiss.

### Content self-report fix

Step 39's audit found `reportUser`, `reportReel`, and `reportMessage` all blocked self-reporting (client service **and** Rules), but `reportContent` — the shared path for Post/Activity/Event, since all three are `content/{contentId}` documents — did not. `reportContent` now rejects `content.authorUid === reporterUid` before submitting, and `firestore.rules`' `isValidContentReport` independently requires `data.targetUid != request.auth.uid`, matching `isValidUserReport`/`isValidReelReport` exactly. Since Activity/Event share this same `content` report path, the fix applies identically to all three content types with no type-specific branching.

### Firestore report security is otherwise unchanged — no admin exception

Read remains reporter-only (`resource.data.reporterUid == request.auth.uid`, plus the pre-existing `resource == null` allowance for the duplicate-check). `allow update: if false` and `allow delete: if false` remain unconditional for **every** client, including one carrying the `admin` custom claim — Firestore Rules never reference `request.auth.token.admin` anywhere in this collection, by design. A custom claim only ever authorizes a trusted Cloud Function in this app; it grants no direct Firestore privilege. This was verified in production: a client signed in with the admin claim still gets `permission-denied` reading another reporter's report, updating one, or deleting one — the claim only works through `dismissReport`.

### `dismissReport` — the one moderation action this step ships

A `europe-north1`, Node 22, Cloud Functions v2 `onCall`, in the same `functions/src/index.ts` codebase as `deleteMyAccountData` (no second Functions stack). A shared `requireAdmin(request)` helper is the single choke point: throws `unauthenticated` if `request.auth` is missing, `permission-denied` if `request.auth.token.admin !== true` — checked before anything else, so a spoofed payload (`{ reportId, isAdmin: true, moderatedByUid: adminUid }`) is denied identically to a bare `{ reportId }`, since authorization never looks at `request.data` at all.

Input is exactly `{ reportId }`. The callable loads `reports/{reportId}` via the Admin SDK inside a transaction, normalizes a missing `status` to `'open'`, and:
- `open` (or status-less) → `dismissed`, `moderatedAt: serverTimestamp()`, `moderatedByUid: request.auth.uid` — no other field touched.
- already `dismissed` → returns `{ status: 'dismissed', reportId, alreadyDismissed: true }` without a second write — `moderatedAt`/`moderatedByUid` never change on a repeat call.
- `resolved` → throws `failed-precondition`; the report is left completely unchanged. `dismissReport` can never regress a `resolved` report back to `dismissed` — only a future removal callable owns that transition.
- nonexistent `reportId` → `not-found`.

The response is action metadata only (`status`, `reportId`, `alreadyDismissed`) — never `reason`/`details`/`reporterUid`/`targetUid` or any message content. This is an action endpoint, not a report-reading endpoint; there is still no `listReports`/`getReport` callable of any kind.

### Production verification

Verified against real disposable Firebase Auth accounts and a live-deployed `dismissReport` (no emulator — this sandbox's Firestore emulator networking remains broken, the established fallback throughout this project): a disposable admin-claimed account correctly dismissed an open report (fields set exactly as designed), repeated the call idempotently (no field changes on the second call), normalized a synthetic status-less "legacy" report to `dismissed`, and was correctly refused by the resolved-report guard (report left untouched). A disposable non-admin account and an unauthenticated caller were both denied, including with a spoofed `isAdmin`/`moderatedByUid` payload. The same admin-claimed account was denied reading, updating, and deleting reports directly via the client Firestore SDK. The reported user was confirmed unable to read the report about them at any point. A cross-user content report (`A reports B's post`) was confirmed to `ALLOW` and land with the correct `open`/`null`/`null` defaults, while `A reports own post` was confirmed `DENY`. All disposable Auth accounts, Firestore documents (`users`, `publicProfiles`, `usernames`, `content`, `reports`), and the admin-claimed test identity itself were deleted afterward by exact ID — no privileged synthetic account, temporary claim-grant script, or fixture data was left behind.

### What this step deliberately does not build

No admin route, admin settings row, or report-queue UI anywhere in the consumer Expo app — normal users have no way to discover that moderation exists. The Firebase Console (backed by IAM/Admin SDK, which bypasses Rules the same way `deleteMyAccountData` already does) remains the v1 report-review surface; there is still no `listReports` callable. No content/Reel/Activity/Event removal, no message removal, no account suspension or ban — all deferred to later, narrower phases once this authorization foundation is in place. `deleteMyAccountData` is unchanged: reports remain retained (never read, mutated, or deleted by that callable) regardless of who authored or was named in them.

## Trusted removal of reported public content (Step 39.2)

Step 39.1 built admin identity and a report lifecycle but no way to actually act on a report beyond dismissing it. Step 39.2 adds real enforcement for public content — Post, Activity, Event, and Reel — while deliberately leaving messages, bans, and suspension for later, narrower steps.

### reportId-only targeting — never an arbitrary delete API

`removeReportedContent` and `removeReportedReel` (`functions/src/index.ts`, same `europe-north1`/Node 22/Cloud Functions v2 codebase as `deleteMyAccountData`/`dismissReport`) both accept exactly `{ reportId }`. The target id is read from the trusted `reports/{reportId}` document via the Admin SDK — never from `request.data`. A payload like `{ reportId, contentId: 'someone-elses-post', isAdmin: true }` has its extra fields silently ignored: only the contentId the report itself named is ever touched. This was verified in production — a call naming Post A's report but smuggling Post B's id in `contentId` removed exactly Post A; Post B was confirmed untouched afterward. Without this design, a moderation callable would effectively be a general-purpose "delete anything by id" endpoint gated only by the admin claim — a far larger blast radius than "resolve the one thing a report named."

### Status behavior: open → resolved, dismissed is a hard stop, resolved is idempotent

Both callables normalize a missing `status` to `'open'` (same as `dismissReport`, for reports predating Step 39.1). A `dismissed` report cannot be used for removal — `failed-precondition`, target left completely untouched, verified against a report dismissed via the existing `dismissReport` callable immediately beforehand. A `resolved` report short-circuits to a safe idempotent response (`alreadyResolved: true`) without re-reading or re-deleting anything and without bumping `moderatedAt` — verified by calling the same callable twice on the same report and confirming byte-identical `moderatedAt`. The report only becomes `resolved` **after** its target cleanup finishes; if any step throws, the report is left `open` so a retry can resume safely.

### Post / Activity / Event removal — one shared primitive, reused from account deletion

`content/{contentId}` and its subcollections (`likes`, `comments`, `participants`, `responses`, `stats/activity`) are deleted by `deleteContentDocumentAndSubcollections` — a new function extracted from the account-deletion backend's existing `deleteOwnContent` loop, which now calls the same primitive per document it owns. This is a pure extraction (identical operations, same order, same idempotent guarantees) — `deleteMyAccountData`'s own behavior is unchanged, confirmed by code-level diff review and a clean Functions typecheck. The same four subcollections are drained unconditionally regardless of whether the target is actually a Post/Activity/Event (an absent subcollection just costs one empty paginated read) — the same approach `deleteOwnContent` already used, so Activity's `participants`/`stats` and Event's `responses` are covered without any type-specific branching. Since the whole Activity is being removed, `participantCount` is never decremented — the `stats/activity` document itself is deleted, not adjusted. Verified in production for all three types: Post (root + likes + comments gone), Activity (root + participants + stats + likes + comments gone), Event (root + responses + likes + comments gone) — in every case the corresponding report ended up `resolved` with the correct `moderatedByUid`.

### Reel + Storage removal

`removeReportedReel` mirrors the same shape via a new `deleteReelDocumentAndSubcollections` primitive (also extracted from the account-deletion backend's `deleteOwnReels`, same no-behavior-change guarantee): drains `likes`/`comments`, deletes the exact Storage object at the Reel's own `storagePath` (never a prefix or folder delete), then deletes the Firestore document. Verified in production: Reel doc, likes, comments, and the real uploaded Storage object were all confirmed gone, with the report resolved.

### Storage-retry safety for a partially-failed prior attempt

If the Firestore `reels/{reelId}` document is already gone (e.g. an earlier attempt deleted it but failed before Storage cleanup) but the report is still `open`, the callable can't read a `storagePath` off a document that no longer exists. Instead it re-derives the canonical path as `reels/{report.targetUid}/{reelId}/source` — safe specifically because `isValidReelReport` (`firestore.rules`) already pinned `targetUid` to the Reel's real `authorUid` at report-creation time, and `authorUid` is never mutated afterward, so this is exactly the same path `reelStoragePath()` would derive client-side. This was verified against a real production scenario: a Reel's Firestore document was deleted directly (simulating a partial prior failure) while its real Storage object and open report were left in place; invoking `removeReportedReel` again correctly derived the path, deleted the orphaned Storage object, and resolved the report (`targetAlreadyMissing: true`). Had the report schema not guaranteed that author/reel pairing, this retry path would have been unsafe to build — it would have meant guessing an author uid, which this callable never does.

### Missing-target handling

If a report's target was already independently removed by the time removal runs (verified in production by directly deleting a Post's Firestore document while its report stayed `open`), the callable does not error — it treats the target as already cleaned, still drains any notifications referencing it, and resolves the report with `targetAlreadyMissing: true`.

### Notification cleanup

Every notification carrying the removed content's `contentId` (covering `like`, `comment`, `event_response`, and `activity_join` — all four share that one field) or a removed Reel's `reelId` (covering `reel_like`/`reel_comment`) is deleted via the existing `drainQuery` pagination helper. `contentId`/`reelId` are plain equality filters, which Firestore auto-indexes — no new composite index was needed or added. Verified in production: an `event_response` notification and a `reel_like` notification were both confirmed gone after their respective target's removal, so a user's Inbox never keeps an actionable row pointing at content that no longer exists.

### Client Firestore security is completely unchanged

No Firestore Rules were touched in this step. Report read stays reporter-only; `allow update: if false` / `allow delete: if false` remain unconditional for every client. Verified again in production with the admin-claimed disposable account itself: direct client attempts to delete content, update a report, or delete a report were all denied identically to Step 39.1 — the admin claim still authorizes these two trusted Functions only, never a Firestore Rules exception.

### Production verification summary

Using disposable Firebase Auth accounts and real production data (no emulator, same established fallback as every prior step): the invalid-report-type guard (Reel report rejected by `removeReportedContent`, content report rejected by `removeReportedReel`), the spoofed-target-override test, Post/Activity/Event removal, Post idempotency, Reel removal with a real Storage object, the Storage-retry scenario, the missing-target scenario, the dismissed-report guard, non-admin and unauthenticated denial (including a spoofed `isAdmin` payload) for both callables, and the direct-client-Firestore security checks were all confirmed — every check passed. All synthetic Firestore documents, the real Storage objects, every synthetic report, and all five disposable Auth accounts (including the admin-claimed one) were deleted afterward by exact ID; the disposable admin uid was independently re-confirmed gone via a follow-up `getUser` call.

### What this step still deliberately does not build

No message review or removal (Step 39.3, if pursued, is the narrow scoped follow-up). No account suspension or ban. No admin UI of any kind — the Firebase Console remains the v1 review surface. No `listReports`/`getReport` callable. The real owner account still does not carry the `admin` claim.

## Narrow reported-message review and removal (Step 39.3)

Around Me already lets users report a DM message (Step 17), but that report path terminated in an inert record — nobody could see what was reported or act on it, which isn't an acceptable gap for an owner-approved v1 given DM harassment is a real report category. Step 39.3 closes it with the narrowest possible privileged DM access: **one reportId names exactly one message**, and that message is the only thing either new callable can ever read or delete. There is no conversation browsing, no surrounding-message access, and no generic "read/delete any message" endpoint of any kind.

### getReportedMessageForReview — exact response payload

`europe-north1`, Node 22, Cloud Functions v2, same codebase as every other moderation callable. `requireAdmin(request)` first, then `{ reportId }` only. `conversationId`/`messageId` are read from the trusted `reports/{reportId}` document — never from the request — so a payload smuggling a different `conversationId`/`messageId`/`targetUid` alongside the real `reportId` is verified to have zero effect: the response is always for the report's real target. No status gate: review is a pure read with no side effects, so it's allowed for `open`, `dismissed`, or `resolved` reports alike (gating a harmless read by status would add complexity without adding real protection).

Verified exact response shape in production:
```json
{
  "reportId": "...",
  "status": "open",
  "report": { "reason": "harassment", "details": "..." },
  "message": { "messageId": "...", "senderUid": "...", "body": "...", "createdAt": "..." }
}
```
`reporterUid` is never present — confirmed directly against the live response. Neither neighboring message's id nor text ever appeared in the response in a three-message-conversation test (message 1 and message 3 surrounding the reported message 2) — the callable does exactly one `doc().get()` against the one named message path, never a query. If the message no longer exists, the response is `{ reportId, status, messageMissing: true }` with no substitute content fetched.

### removeReportedMessage — why reportId-only

Same shape as `removeReportedContent`/`removeReportedReel`: `requireAdmin` first, `{ reportId }` only, target derived from the trusted report. Verified live with the same spoofed-payload test used in Step 39.2 — a call naming Report A while smuggling a different conversation/message/targetUid in the payload still only affected Report A's real message; the "other" message named in the spoofed fields was independently confirmed untouched afterward.

### Report status behavior

Identical policy to every other removal callable: missing status normalizes to `open`. `dismissed` → `failed-precondition`, message untouched — verified by dismissing a report via the existing `dismissReport` callable first, then confirming removal was refused and the message still existed. `resolved` → idempotent short-circuit, `alreadyResolved: true`, `moderatedAt` provably unchanged — verified with a genuine repeat call after a real removal.

### Exact message deletion

Deletes exactly `conversations/{conversationId}/messages/{messageId}` — nothing else. Verified: the reported message was gone afterward while the conversation root, the other two messages in that same conversation, and an entirely separate synthetic conversation between different users were all confirmed untouched.

### Conversation metadata repair

`conversations/{conversationId}` (`src/types/message.ts`) denormalizes `lastMessageId`/`lastMessageText`/`lastMessageSenderUid`/`lastMessageAt` so the Inbox never has to query every conversation's messages just to render a preview row. If the removed message is **not** the conversation's current `lastMessageId`, nothing about the conversation document is touched — verified by comparing the full conversation document before and after removal and confirming byte-identical `lastMessage*` fields and `updatedAt` (no unnecessary write). If the removed message **is** the current latest and other messages survive, the preview is repaired from a single bounded query — `messages.orderBy('createdAt', 'desc').limit(1)`, never a history scan — verified live: reporting and removing a conversation's genuinely-latest message correctly repaired `lastMessageId`/`lastMessageText`/`lastMessageSenderUid` to point at the next-newest surviving message.

**Step 39.3.1 fix:** if the removed message was the *only* message in the conversation, the `Conversation` document itself is now deleted rather than left with a stale preview. The original Step 39.3 design left `lastMessageText`/`lastMessageId` pointing at the deleted message in this case — reasoned as a narrow, self-correcting gap — but that meant the Inbox could keep showing a moderated-away message's text indefinitely if the two participants never messaged again, and the "reports never retain message content" privacy claim was quietly false in this one edge case. Deleting the conversation root instead is safe because `sendMessage`'s own transaction already creates a `Conversation` from scratch on a pair's very first message (`src/services/messages.ts`) — a future message between the same two users simply takes that exact path again, and until then `fetchConversations`' `participantUids` query just doesn't return a document that no longer exists, identical to the "never messaged" state the Inbox already renders correctly for any two users who haven't spoken yet. Verified live: a conversation's sole message was reported and removed — the message, the conversation document, and every trace of `lastMessageText` were confirmed gone (independently, via Admin SDK, since the deleted conversation is no longer even reachable through the normal client read path); a fresh message was then sent between the same two users through the real client `sendMessage` service, and the conversation was recreated correctly — new `lastMessageId`/`lastMessageText` pointing only at the new message, no trace of the moderated text anywhere, and `unreadCounts` freshly initialized exactly as it is for any brand-new conversation.

### Unread behavior

`unreadCounts` (`Record<uid, number>`) is a per-recipient **sent-message counter** incremented by `sendMessage` on every send — not a live count of existing message documents (confirmed by reading `sendMessage`'s transaction directly). There is no way to "correctly" decrement it for one deleted message without knowing whether the recipient had already read it, so `removeReportedMessage` deliberately leaves it untouched when the conversation survives — inventing a decrement here would be exactly the kind of unproven counter repair this step was told not to do. The impact is bounded: `markConversationRead` already resets a participant's own count to `0` unconditionally the next time they open that conversation, so any one-off overcount from a moderated message self-corrects on the recipient's next visit regardless. When the conversation is deleted outright (the sole-message case above), `unreadCounts` is deleted along with it — verified live: after the sole-message conversation was recreated by a fresh send, `unreadCounts` came back exactly as `sendMessage` initializes it for any new conversation, with no stale value carried over.

### Message-report body privacy

Reconfirmed unchanged: `reports/{reportId}` for `targetType: 'message'` still stores only `conversationId`/`messageId`/`targetUid` — never a copy of the message body (`src/types/report.ts`, `src/services/reports.ts`). The only place a message's body is ever readable by an admin is a live `getReportedMessageForReview` call while the message still exists; after removal, the report stays retained as a permanent record that a report existed and was actioned, but the message text itself is genuinely gone — the report never becomes a second archive of DM content.

### Missing-message handling

Verified live: a message was deleted directly (via Admin SDK, simulating a scenario with no client-reachable equivalent) while its report stayed `open`. `removeReportedMessage` treated the target as already clean and resolved the report with `targetAlreadyMissing: true` — no error, no substitute content touched. A subsequent review of that same report correctly returned `messageMissing: true` rather than fetching anything else.

### Direct client Firestore security — unchanged

No Firestore Rules changes in this step (confirmed via `git diff`). Verified again with the admin-claimed disposable account itself, via the plain client SDK: reading a message in a conversation it isn't a participant of — denied; deleting a message directly — denied (`allow delete: if false` already covered every client, admin claim included); reading another user's report — denied; updating a report directly — denied. The claim authorizes these two trusted Functions only, exactly like every other moderation callable in this app.

### Account deletion policy — unchanged, code-level regression only

`deleteMyAccountData` was not modified in this step (confirmed via `git diff` — the only file touched besides README is the addition of these two new callables). DMs/messages remain retained on self-deletion; this step's message removal is a narrow, separate, report-triggered safety action against exactly one message, never a change to that policy. This was a code-level review, not a fresh production account-deletion run — no shared helper was touched by this step, so there was nothing new to regression-test.

### No generic DM access anywhere

Confirmed by reviewing every Functions export: there is no `getConversation`, `getMessages`, `searchMessages`, `adminMessages`, `deleteMessage`, or `deleteConversation` — only `getReportedMessageForReview` and `removeReportedMessage`, both permanently reportId-scoped.

### Production verification summary

Disposable Firebase Auth accounts and real production data (no emulator, same established fallback throughout this project): the exact review payload shape, the neighbor-message privacy guarantee (a 3-message conversation with the middle one reported), an entirely separate conversation's total isolation, exact single-message removal, the dismissed-report guard, resolved idempotency (verified with a genuine repeat call), the missing-message scenario, the invalid-report-type guard (a content report rejected by both message callables), the preview-repair path (removing a conversation's actual latest message), the spoofed-target-override test for both callables, non-admin and unauthenticated denial (including spoofed `isAdmin` payloads), the direct-client-Firestore checks, and reporter-identity privacy were all confirmed. All synthetic conversations/messages/reports/content, and all disposable Auth accounts (including the admin-claimed one), were deleted afterward by exact ID; the disposable admin uid was independently re-confirmed gone via a follow-up `getUser` call.

### What this step still deliberately does not build

No account suspension or ban. No admin UI of any kind. No message-status field, no "reviewed" state beyond the existing open/dismissed/resolved lifecycle. The real owner account still does not carry the `admin` claim.

## Posts product role + author content self-delete (Step 40 / Step 40.1)

### Locked Post role (Step 40, read-only audit — no code changed)

Around Me Posts are **persistent local text notes** that live on a user's Profile and, when connected to a Place, also on that Place's page. Posts remain **completely absent from Home** — Home renders exactly one thing (Reels; see Step 25 above), and that stays true after this step. Posts are text-only (no media), have no edit capability, and Place stays optional. This was a locked product decision among four options (remove, profile-only, profile+place, separate discovery surface); profile+place was chosen and approved before any Step 40.1 code was written.

### Author self-delete (Step 40.1)

Personal authors can permanently delete their own Post, Activity, or Reel; Business authors can additionally delete their own Event. This is deliberately **not** an edit feature (none exists) and **not** a recycle bin — deletion is immediate and permanent, matching the locked policy: *you may delete public content you authored, never content authored by anyone else.*

Two new trusted callables, `europe-north1`, Node 22, Cloud Functions v2, same codebase as every moderation callable:

- **`deleteMyContent({ contentId })`** — loads `content/{contentId}` via the Admin SDK, checks `content.authorUid === request.auth.uid`, rejects any type other than `post`/`activity`/`event`, then reuses the exact same `deleteContentDocumentAndSubcollections` primitive Step 39.2's moderation and Step 34.2's account deletion already share (likes/comments/participants/responses/stats drained first, root deleted last) plus `drainNotificationsByField`.
- **`deleteMyReel({ reelId })`** — same shape for `reels/{reelId}`, reusing `deleteReelDocumentAndSubcollections` (likes/comments drained, exact Storage source object deleted by its literal path, then the Firestore doc deleted last).

**This is not moderation** — `requireAdmin` is never called here. Authorization is exclusively `request.auth.uid === <trusted document's own authorUid>`, loaded server-side via the Admin SDK; nothing from `request.data` (`authorUid`, `ownerUid`, `accountType`, `isOwner`, `isAdmin`) can influence the result — confirmed with a spoofed-payload production test (a non-owner sending the real owner's `authorUid` alongside the real `contentId` was still denied).

**Root-last retry design:** every dependent cleanup step (subcollections, notifications, the Reel's Storage object) completes before the root document is deleted, because the root is the only proof of ownership a retry can re-check. A call that fails partway can simply be retried — every step is already idempotent. A **second** call after a genuinely successful deletion returns a controlled `not-found`, not a fake idempotent success: once the root is gone there is nothing left to re-authorize ownership against, unlike moderation callables, which can stay idempotent because the *report* document survives as an anchor.

**Reports are never touched.** Neither callable references the `reports` collection — verified in production: a report filed against a Post survived that Post's own self-deletion with `status: 'open'` and its `reportId` unchanged.

### UI

Content detail (`src/app/(app)/content/[contentId].tsx`) and Reel detail (`src/app/(app)/reel/[reelId].tsx`) show a **Delete** option in the overflow menu only to the author (never Report, which is what a non-author sees instead); `ReelFeed.tsx` (shared by Home and `/reels`) adds the same **Delete Reel** option to its own-Reel menu. All four confirmations use the shared `ConfirmDialog` with exact copy ("Delete post?"/"Delete activity?"/"Delete event?"/"Delete reel?" + "This can't be undone."), disable both buttons while the call is in flight, and show the real error message in place of the dialog body on failure. On success: `router.canGoBack() ? router.back() : router.replace(...)`, falling back to `/events` for a deleted Event or `/profile` otherwise — **never Home**, since Posts/Activities/Events never render there. `ReelFeed` reuses its existing `onReload()` refresh (the same one already used after a successful Block) rather than any new local-removal logic.

### Firestore/Storage Rules — unchanged

Zero diff to either `firestore.rules` or `storage.rules` this step. `allow delete: if false` remains in force for `content/{contentId}` and `reels/{reelId}` — both callables delete exclusively via the Admin SDK, bypassing Rules through IAM, never through a client-facing exception.

### Production verification

Ran across two script executions (30 effective checks total — see the commit history for the exact breakdown): non-owner denial for all four content types plus a spoofed-`authorUid` payload (all denied); real author deletion of a Post, an Activity, a Business-owned Event, and a published Reel, each independently verified via subsequent reads that the root, likes, comments, participants/stats/responses (as applicable), and target notifications were gone; a second `deleteMyContent` call on the already-deleted Post returned `functions/not-found`; the report on that Post survived with `status: 'open'` untouched; and the Reel's exact Cloud Storage source object (`reels/{authorUid}/{reelId}/source`) was independently confirmed absent via an Admin SDK check run separately from this app's own client — a Storage read from the client is gated on the Firestore Reel doc existing, so a client-only check could never have told deleted-doc-therefore-permission-denied apart from object-still-there-therefore-permission-denied. All synthetic fixtures (3 disposable Auth accounts, their `users`/`publicProfiles`/`usernames` docs, and the retained report) were deleted by exact ID afterward and independently re-verified absent.

### What this step does not build

No content editing of any kind (Post, Activity, Event, or Reel). No recycle bin, no grace period, no "restore" affordance. No new Rules exception. No `accountType`-based authorization at deletion time (a Business author deletes their own Event purely because `authorUid` matches, the same as every other type).

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
