// src/lib/api.ts — the browser's fetch helper for the three endpoints that
// replaced the Supabase Edge Functions (task t12): /api/quickbooks-export,
// /api/send-invoice-email and /api/send-receipt-email.
//
// It is what Billing.tsx and Exports.tsx now call instead of the Edge
// Function invoke call: same POST + JSON-body shape those calls carried,
// but aimed at our own API, and with the caller's session attached — the API
// gates every one of these routes behind requireAuth/requireRole (W42), so an
// unauthenticated fetch is a 401 and never a CSV or a sent mail.
//
// The three endpoint paths are written here and nowhere else in src/ (task
// t16, W61): the pages reach the endpoints through the named helpers at the
// bottom of this file — QUICKBOOKS_EXPORT_PATH, SEND_INVOICE_EMAIL_PATH and
// SEND_RECEIPT_EMAIL_PATH are the only literals, and a grep for any of the
// three /api/... strings must find only this file.
//
//   * Authorization: the bearer token of the shim session, read fresh from the
//     session store (the `hh.session` localStorage entry that
//     src/integrations/supabase/shim/auth.ts owns) on every call, so a
//     sign-in performed anywhere in the app is immediately visible here. With
//     no session the header is left off entirely — the API answers those the
//     same 401 JSON a forged token gets.
//   * Base URL: the same resolution as the client singleton
//     (src/integrations/supabase/client.ts) — VITE_API_URL when the bundler
//     (or a plain-node test) defines it, else the page's own origin, since
//     the API is served under /api on that origin in every deployment we
//     have. It is resolved per call, not at import, so a test may point it
//     at its own server after the module loaded.
//   * accept 'text' returns the raw body text — that is how Exports.tsx
//     keeps building its text/csv Blob; accept 'json' (the default) parses
//     the JSON body — that is how Billing.tsx's email mutations keep their
//     {success, message, emailId} contract.
//   * a non-2xx answer throws an ApiError (an Error subclass) carrying the
//     server's own message: the {"error":{"code","message"}} envelope of the
//     API routes or the flat {"error":"..."} string body the ported function
//     contracts keep — so the pages' `catch (error)` toasts read exactly as
//     they did against the Edge Functions ("Invalid date range" et al.).
//
// `createApiFetch` is the same helper with the base URL and token source
// injected; the regression tests build one to pin the wire contract against
// a running API. Pages use the `apiFetch` export below.

import { SESSION_STORAGE_KEY } from '../integrations/supabase/shim/auth.ts';

/** The three ported edge functions, served as API endpoints. These three
 *  strings are the ONLY place the endpoint paths appear in src/ (t16/W61);
 *  the pages never spell them out — they call the named helpers at the
 *  bottom of this file. */
export const QUICKBOOKS_EXPORT_PATH = '/api/quickbooks-export';
export const SEND_INVOICE_EMAIL_PATH = '/api/send-invoice-email';
export const SEND_RECEIPT_EMAIL_PATH = '/api/send-receipt-email';

export interface ApiFetchOptions {
  /** HTTP method; 'POST' as before, the edge-function contracts were POST-only. */
  method?: string;
  /** Sent as JSON (with Content-Type) when defined; omitted sends no body. */
  body?: unknown;
  /** How to read a successful body: parsed JSON (default) or raw text. */
  accept?: 'json' | 'text';
}

/** The error apiFetch throws on a non-2xx answer or an unreadable reply:
 *  an Error (every `catch (error)` and `instanceof Error` check keeps
 *  working) plus the HTTP status, so a caller can branch without a second
 *  round trip. */
export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** apiFetch's shape: a string when accept is 'text' (checked FIRST, so the
 *  call sites that ask for text get a string), parsed JSON otherwise. */
export interface ApiFetch {
  (path: string, opts: ApiFetchOptions & { accept: 'text' }): Promise<string>;
  (path: string, opts?: ApiFetchOptions): Promise<unknown>;
}

/** The base-URL resolution of src/integrations/supabase/client.ts, kept
 *  identical so the shim's queries and these calls always aim at the same
 *  API. Resolved per call (see the header note). */
function resolveBaseUrl(): string {
  let baseUrl: string | undefined;
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) {
    baseUrl = import.meta.env.VITE_API_URL as string;
  }
  if (!baseUrl && typeof process !== 'undefined' && process.env?.VITE_API_URL) {
    baseUrl = process.env.VITE_API_URL;
  }
  if (!baseUrl && typeof window !== 'undefined' && window.location?.origin) {
    baseUrl = window.location.origin;
  }
  return String(baseUrl ?? '').replace(/\/$/, '');
}

/** The shim session's bearer token: the access_token of the `hh.session`
 *  store entry, read fresh so sign-in/sign-out anywhere in the app takes
 *  effect on the next call. No store, no entry, unparsable entry — no
 *  session, no header. */
export function sessionToken(): string | null {
  try {
    const raw = globalThis.localStorage?.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { access_token?: unknown };
    return typeof parsed.access_token === 'string' && parsed.access_token !== ''
      ? parsed.access_token
      : null;
  } catch {
    return null;
  }
}

/** Pull the message out of a failed response's body. The API's envelope is
 *  {"error":{"code","message"}}; the ported edge-function contracts keep the
 *  legacy flat {"error":"..."} string ({"success":false,...} as well — its
 *  error key carries the same text). Anything else falls back to the status
 *  line so the toast never shows an empty description. */
function failureMessage(status: number, bodyText: string): string {
  let payload: unknown = null;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    /* a non-JSON failure body: the status line speaks for it */
  }
  const error = (payload as { error?: unknown } | null)?.error;
  if (typeof error === 'string' && error) return error;
  const message = (error as { message?: unknown } | null)?.message;
  if (typeof message === 'string' && message) return message;
  return `The API answered ${status}`;
}

/** createApiFetch({ baseUrl, getToken, fetch }): the helper against an
 *  injected origin/token source. Defaults are what the pages get: the
 *  per-call base-URL resolution above and the shim session's token. */
export function createApiFetch({
  baseUrl,
  getToken,
  fetch: fetchImpl,
}: {
  baseUrl?: string | (() => string);
  getToken?: () => string | null;
  fetch?: typeof globalThis.fetch;
} = {}): ApiFetch {
  const resolve = typeof baseUrl === 'function' ? baseUrl : () => String(baseUrl ?? '').replace(/\/$/, '');
  const readToken = getToken ?? sessionToken;
  // Resolved per call, not captured at creation: the module-level apiFetch
  // is built at import time, and a test (or a host that patches fetch later)
  // must be able to swap globalThis.fetch without re-importing this module.
  const doFetch = () => fetchImpl ?? globalThis.fetch;

  const apiFetchImpl = async (path: string, opts: ApiFetchOptions = {}): Promise<unknown> => {
    const { method = 'POST', body, accept = 'json' } = opts;
    const url = `${resolve()}${path}`;

    const headers: Record<string, string> = {};
    const bearer = readToken();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const sendsBody = body !== undefined;
    if (sendsBody) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await doFetch()(url, {
        method,
        headers,
        body: sendsBody ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new ApiError(`Cannot reach the API at ${url}: ${(e as Error).message}`, 0);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw new ApiError(failureMessage(response.status, bodyText), response.status);
    }

    if (accept === 'text') return response.text();
    if (response.status === 204) return null;
    const bodyText = await response.text();
    try {
      return JSON.parse(bodyText);
    } catch {
      throw new ApiError(`The API answered ${response.status} with unreadable JSON`, response.status);
    }
  };

  // One implementation behind the two overload signatures above (a single
  // function cannot be structurally assignable to both).
  return apiFetchImpl as ApiFetch;
}

/** The call site used by the three endpoint helpers below. */
export const apiFetch: ApiFetch = createApiFetch({ baseUrl: resolveBaseUrl });

// --- the three ported edge functions, by name (task t16, W61) ---------------
//
// The endpoint paths live here, in src/lib/api.ts, and in no other src file:
// Billing.tsx and Exports.tsx call the endpoints only through the helpers
// below, so every request they make goes through apiFetch — which attaches
// `Authorization: Bearer <session token>` and, for a JSON body,
// `Content-Type: application/json`.

/** POST /api/quickbooks-export — the CSV as raw text, exactly what Exports.tsx
 *  feeds to its text/csv Blob. Resolves with the CSV string, or throws the
 *  server's message ("Invalid export type", "Invalid date range", …). */
export function apiQuickBooksExport(body: unknown): Promise<string> {
  return apiFetch(QUICKBOOKS_EXPORT_PATH, { body, accept: 'text' });
}

/** POST /api/send-invoice-email — the {success, message, emailId} contract
 *  Billing.tsx's invoice-email mutation consumes. */
export function apiSendInvoiceEmail(body: unknown): Promise<unknown> {
  return apiFetch(SEND_INVOICE_EMAIL_PATH, { body });
}

/** POST /api/send-receipt-email — the same contract for a payment receipt. */
export function apiSendReceiptEmail(body: unknown): Promise<unknown> {
  return apiFetch(SEND_RECEIPT_EMAIL_PATH, { body });
}

export default apiFetch;
