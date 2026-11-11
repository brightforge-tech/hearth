// api/lib/resend.mjs — the Resend REST client the two e-mail endpoints share
// (task t11).
//
// The shipped edge functions built a Resend SDK object around
// `Deno.env.get("RESEND_API_KEY")` and hardcoded the senders: the invoice
// mail went out from Resend's shared test address and the receipt from a
// placeholder domain that can never verify. W48's fix: nothing in api/ names
// a sender any more — the addresses come from RESEND_FROM_INVOICE /
// RESEND_FROM_RECEIPT (neither legacy address is even spelled out here, so
// the milestone's grep over api/ and src/ stays quiet), and a request that
// would have to send from an unset sender never reaches the network.
//
// The wire call is exactly what the SDK does:
//
//   POST ${RESEND_API_BASE || 'https://api.resend.com'}/emails
//   Authorization: Bearer ${RESEND_API_KEY}
//   {"from":...,"to":[...],"subject":...,"html":...}
//
// RESEND_API_BASE is overridable so the tests point this at a local stub;
// production leaves it unset and gets api.resend.com. The API is the only
// process that ever sees RESEND_API_KEY or the DSN (S27).
//
// The result shape mirrors the SDK the legacy code destructured
// (`const { data, error } = await resend.emails.send(...)`): this function
// never rejects and never throws, it always resolves {data, error}. Callers
// keep the legacy branches instead of learning try/catch:
//
//   { data: { id }, error: null }                 sent — id is Resend's id
//   { data: null, error: Error('Mail sender not configured') }
//                                                 `from` empty — checked
//                                                 BEFORE any network call
//   { data: null, error: Error('Failed to send email: …') }
//                                                 non-2xx or transport failure

const DEFAULT_API_BASE = 'https://api.resend.com';

// A hung provider must not hang the request thread forever; the route then
// answers the legacy failure JSON.
const DEFAULT_TIMEOUT_MS = 30_000;

function envString(env, name) {
  const raw = env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

// resendApiBase(env): the provider endpoint. Unset/blank means production.
export function resendApiBase(env = process.env) {
  return envString(env, 'RESEND_API_BASE') || DEFAULT_API_BASE;
}

// The two verified senders, read from the environment on every call (the
// operator can change them without a code deploy, and the contract tests can
// prove the endpoints never send from a hardcoded address).
export function invoiceSender(env = process.env) {
  return envString(env, 'RESEND_FROM_INVOICE');
}

export function receiptSender(env = process.env) {
  return envString(env, 'RESEND_FROM_RECEIPT');
}

// sendEmail({from, to, subject, html, env}): hand one message to Resend.
// `to` is normalised to the array the API expects (the legacy calls passed
// [recipientEmail] too). Returns {data, error} — see the header.
export async function sendEmail({ from, to, subject, html, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // The sender gate comes first and is checked before any socket is opened:
  // milestone W48 pins that an unset RESEND_FROM_* performs NO request.
  const sender = typeof from === 'string' ? from.trim() : '';
  if (sender === '') {
    return { data: null, error: new Error('Mail sender not configured') };
  }

  const base = resendApiBase(env).replace(/\/+$/, '');
  const key = envString(env, 'RESEND_API_KEY');

  let res;
  try {
    res = await fetch(`${base}/emails`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ from: sender, to: Array.isArray(to) ? to : [to], subject, html }),
      signal: AbortSignal.timeout(Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)),
    });
  } catch (e) {
    // DNS/refused/timeout: the legacy SDK threw here and its catch reported
    // the failure; the port words it the way the shipped receipt function did.
    return { data: null, error: new Error(`Failed to send email: ${e?.message ?? 'network request failed'}`) };
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* a body-less or non-JSON answer is still judged by its status */
  }

  if (!res.ok) {
    const detail = payload?.message ?? payload?.error ?? `${res.status} ${res.statusText ?? 'request failed'}`;
    return { data: null, error: new Error(`Failed to send email: ${detail}`) };
  }

  return { data: { id: payload?.id }, error: null };
}
