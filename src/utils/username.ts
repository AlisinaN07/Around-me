/**
 * Canonical username rule: 3–24 characters, lowercase letters, numbers, and
 * underscores only. `usernameLower` is what uniqueness is enforced on;
 * `username` preserves the caller's chosen casing for display.
 */
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

export type UsernameValidationResult =
  | { valid: true; username: string; usernameLower: string }
  | { valid: false; reason: string };

export function normalizeUsername(rawUsername: string): UsernameValidationResult {
  const username = rawUsername.trim();
  const usernameLower = username.toLowerCase();

  if (!usernameLower) {
    return { valid: false, reason: 'Username is required.' };
  }
  if (!USERNAME_PATTERN.test(usernameLower)) {
    return {
      valid: false,
      reason: 'Username must be 3–24 characters, using only letters, numbers, and underscores.',
    };
  }

  return { valid: true, username, usernameLower };
}

/**
 * Normalizes free-typed search input into the lower-case form
 * `usernameLower` is queried against — deliberately more permissive than
 * `normalizeUsername` (no length/character-set validation, since a partial
 * prefix like "a" or a still-being-typed string is never itself a valid
 * username). Only three transforms, each safe for any input: trim, strip
 * one leading "@", lowercase. Never throws, never rejects a string — a
 * plain-string Firestore range query can't be broken by unexpected
 * characters, so there's nothing else to guard against here.
 */
export function normalizeUsernameSearchQuery(rawQuery: string): string {
  const trimmed = rawQuery.trim();
  const withoutAt = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  return withoutAt.toLowerCase();
}
