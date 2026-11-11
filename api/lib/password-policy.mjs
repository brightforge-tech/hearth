// api/lib/password-policy.mjs — the rules every NEW password must meet
// (sign-up, admin-created accounts, password changes and resets). Login never
// applies them, so tightening the policy can never lock an existing account out.
//
//   * at least MIN_LENGTH (12) characters, at most 1024;
//   * not only digits;
//   * not on a short list of the most common passwords (case-insensitive,
//     also with trailing digits/symbols stripped: "Password123!" is rejected);
//   * not the account's own e-mail address or its local part.

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 1024;

// A compact list of the most frequently breached passwords and patterns
// (lower-case). Small on purpose: the length rule does most of the work.
const COMMON = new Set([
  'password', 'password1', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'qwerty', 'qwertyuiop', 'qwerty123',
  'letmein', 'welcome', 'welcome1', 'admin', 'administrator', 'changeme', 'changeit', 'secret',
  'iloveyou', 'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess', 'shadow',
  'master', 'superman', 'trustno1', 'abc123', 'abcdef', 'abcdefgh', 'abcdefghijkl', 'login',
  'starwars', 'whatever', 'freedom', 'hello', 'helloworld', 'computer', 'internet', 'default',
  'doctor', 'nurse', 'clinic', 'hospital', 'medical', 'health', 'healthcare', 'patient',
  'hearth', 'reception', 'receptionist', 'summer', 'winter', 'spring', 'autumn', 'january',
  'temp', 'temporary', 'test', 'testing', 'guest', 'user', 'root', 'access', 'mustang',
  'michael', 'jennifer', 'jordan', 'hunter', 'ranger', 'harley', 'batman', 'charlie',
  'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', '1q2w3e4r', '1qaz2wsx', 'qazwsx', 'aaaaaa',
  'passwordpassword', 'adminadmin', 'administrator1', 'letmeinplease', 'iloveyou123',
]);

const SEQUENCES = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function isCommon(password) {
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return true;
  const stripped = lower.replace(/[\d\W_]+$/u, '').replace(/^[\d\W_]+/u, '');
  if (stripped.length > 0 && COMMON.has(stripped)) return true;
  if (/^(.)\1+$/u.test(lower)) return true; // one character repeated
  for (const seq of SEQUENCES) if (seq.includes(lower) || (lower.length >= 8 && seq.includes(stripped) && stripped.length >= 6)) return true;
  return false;
}

// checkPassword(password, {email}) -> null when acceptable, else a message
// the user can act on.
export function checkPassword(password, { email } = {}) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters long.`;
  }
  if (password.length > MAX_LENGTH) return `Password must be at most ${MAX_LENGTH} characters long.`;
  if (/^\d+$/.test(password)) return 'Password must not consist of digits only.';
  if (isCommon(password)) return 'This password is too common. Choose something less predictable, e.g. a few unrelated words.';
  if (typeof email === 'string' && email) {
    const lower = password.toLowerCase();
    const mail = email.trim().toLowerCase();
    const local = mail.split('@')[0];
    if (lower === mail || (local.length >= 4 && lower.includes(local) && lower.length - local.length < 6)) {
      return 'Password must not be based on your e-mail address.';
    }
  }
  return null;
}

export const PASSWORD_RULES_TEXT = `At least ${MIN_LENGTH} characters, not only digits, not a common password, not based on your e-mail address.`;
