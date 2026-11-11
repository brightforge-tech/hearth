// The server's password rules (POST /api/auth/change-password, admin user
// creation, password reset), listed in the UI. The server is the authority:
// the client-side check below only catches the obvious cases early.
export const PASSWORD_RULES = [
  "At least 12 characters",
  "Not only digits",
  "Not a common password",
  "Not the same as your e-mail address",
] as const;

export const PASSWORD_MIN_LENGTH = 12;

/** A first, local check; returns the problem or null. */
export function passwordProblem(password: string, email?: string | null): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `The password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (/^\d+$/.test(password)) return "The password must not be only digits.";
  if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return "The password must not be your e-mail address.";
  return null;
}
