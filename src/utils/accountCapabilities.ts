import type { AccountType } from '@/types/user';

/**
 * Step 30 capability helpers — centralizes `accountType === 'business'`
 * checks instead of sprinkling that comparison across Create hub,
 * /create/event, and the Events screen's CTAs. The single meaningful
 * capability difference between account types: Business = Personal +
 * the ability to create Events. This is a client-side convenience only —
 * the real guarantee is `firestore.rules`' Event-create check against the
 * caller's own canonical `users/{uid}.accountType`, not this helper.
 */

type ProfileLike = { accountType: AccountType } | null | undefined;

export function isBusinessAccount(profile: ProfileLike): boolean {
  return profile?.accountType === 'business';
}

export function canCreateEvent(profile: ProfileLike): boolean {
  return isBusinessAccount(profile);
}
