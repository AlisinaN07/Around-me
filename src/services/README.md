# services

API clients and external integrations.

- `firebase.ts` — Firebase App initialization (config only).
- `auth.ts` — Firebase Auth instance, persisted via AsyncStorage.
- `firestore.ts` — Firestore instance, initialized from the same Firebase App.
- `userProfile.ts` — user profile data layer (fetch, check username availability, create initial profile). UI code should only ever go through here, never touch Firestore directly.
- `content.ts` — city content data layer for the unified `content/{contentId}` collection (posts, activities, events): create functions, city feed / upcoming events / upcoming activities / happening-now reads. Same rule: UI never touches Firestore directly.
