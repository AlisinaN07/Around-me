# providers

React Context providers for app-wide state.

- `AuthProvider.tsx` — Firebase Auth session state (`user`, `isLoading`, `isAuthenticated`) and `signUp` / `signIn` / `signOut` actions. Consume via `@/hooks/useAuth`.
- `ProfileProvider.tsx` — the signed-in user's Firestore profile (`profile`, `isProfileLoading`, `profileError`, `hasCompletedOnboarding`, `refreshProfile`). Consume via `@/hooks/useProfile`.
- `OnboardingDraftProvider.tsx` — in-memory draft (name, username, city, interests) shared by the 3 onboarding screens. Scoped to `(onboarding)/_layout.tsx`; not persisted.
