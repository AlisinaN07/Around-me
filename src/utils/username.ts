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
