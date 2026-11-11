// api/lib/features.mjs — the optional integrations, all OFF unless configured.
//
// Hearth works fully without any of them. Each one sends data to a third
// party when switched on, which is why none is on by default:
//
//   e-mail            RESEND_API_KEY (+ RESEND_FROM_*): invoice/receipt mails
//                     and, with it, self-service password-reset mails. Patient
//                     names, e-mail addresses and invoice details go to Resend.
//   receipt scanning  RECEIPT_AI_API_KEY (+ RECEIPT_AI_BASE_URL, an
//                     OpenAI-compatible endpoint, and RECEIPT_AI_MODEL): the
//                     receipt image goes to that provider.

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const set = (v) => typeof v === 'string' && v.trim() !== '';

export function emailEnabled(env = process.env) {
  return set(env.RESEND_API_KEY);
}

export function passwordResetEmailEnabled(env = process.env) {
  return emailEnabled(env) && set(env.RESEND_FROM_SYSTEM ?? env.RESEND_FROM_INVOICE);
}

export function receiptScanningEnabled(env = process.env) {
  return set(env.RECEIPT_AI_API_KEY);
}

export function selfSignupEnabled(env = process.env) {
  return truthy(env.ALLOW_SELF_SIGNUP);
}

export function features(env = process.env) {
  return {
    email: emailEnabled(env),
    password_reset_email: passwordResetEmailEnabled(env),
    receipt_scanning: receiptScanningEnabled(env),
    self_signup: selfSignupEnabled(env),
  };
}
