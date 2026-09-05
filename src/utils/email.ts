const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Basic client-side shape check only — real validation happens server-side at Firebase Auth. */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email);
}
