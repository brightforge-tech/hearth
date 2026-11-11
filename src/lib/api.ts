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
  /** The envelope's error.code (e.g. SESSION_EXPIRED, LOGIN_LOCKED), when the
   *  server sent one; null for flat {"error":"..."} bodies and network faults. */
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
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

/** The envelope's error.code, when there is one. */
function failureCode(bodyText: string): string | null {
  try {
    const payload = JSON.parse(bodyText) as { error?: { code?: unknown } } | null;
    const code = payload?.error?.code;
    return typeof code === 'string' && code ? code : null;
  } catch {
    return null;
  }
}

/** Listeners for answers meaning "this session is over" (401 SESSION_EXPIRED)
 *  or "change the password first" (403 PASSWORD_CHANGE_REQUIRED). The app
 *  registers one handler (src/components/AuthFailureHandler.tsx); apiFetch
 *  reports every such answer to it. */
type AuthFailureListener = (error: ApiError) => void;
const authFailureListeners = new Set<AuthFailureListener>();

export function onAuthFailure(listener: AuthFailureListener): () => void {
  authFailureListeners.add(listener);
  return () => {
    authFailureListeners.delete(listener);
  };
}

/** True for the two codes the auth-failure handler deals with. */
export function isAuthFailureCode(code: string | null | undefined): boolean {
  return code === 'SESSION_EXPIRED' || code === 'PASSWORD_CHANGE_REQUIRED';
}

/** Hand an error (ApiError, or a shim PostgrestError with the same code) to
 *  the registered handler when it is one of the two auth-failure codes. */
export function reportAuthFailure(error: { code?: string | null; message?: string; status?: number } | null | undefined): void {
  if (!error || !isAuthFailureCode(error.code)) return;
  const failure =
    error instanceof ApiError
      ? error
      : new ApiError(error.message ?? 'Unauthorized', error.code === 'SESSION_EXPIRED' ? 401 : 403, error.code ?? null);
  for (const listener of [...authFailureListeners]) {
    try {
      listener(failure);
    } catch {
      /* a listener's fault must not mask the original error */
    }
  }
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
      const failure = new ApiError(failureMessage(response.status, bodyText), response.status, failureCode(bodyText));
      reportAuthFailure(failure);
      throw failure;
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

// --- Hearth endpoints added after the port (auth, bookings, audit, receipts) --
//
// Same rule as above: every /api path string lives in this file only.

export const AUTH_FEATURES_PATH = '/api/auth/features';
export const AUTH_CHANGE_PASSWORD_PATH = '/api/auth/change-password';
export const AUTH_ADMIN_USERS_PATH = '/api/auth/admin/users';
export const PASSWORD_RESET_REQUEST_PATH = '/api/auth/password-reset/request';
export const PASSWORD_RESET_CONFIRM_PATH = '/api/auth/password-reset/confirm';
export const PUBLIC_BOOKING_REQUESTS_PATH = '/api/public/booking-requests';
export const BOOKING_REQUESTS_PATH = '/api/booking-requests';
export const AUDIT_PATH = '/api/audit';
export const AUDIT_EXPORT_PATH = '/api/audit/export';
export const ANALYZE_RECEIPT_PATH = '/api/expenses/analyze-receipt';

/** GET /api/auth/features (public). */
export interface Features {
  password_reset_email: boolean;
  email: boolean;
  receipt_scanning: boolean;
  self_signup: boolean;
}

export const NO_FEATURES: Features = {
  password_reset_email: false,
  email: false,
  receipt_scanning: false,
  self_signup: false,
};

export async function apiFeatures(): Promise<Features> {
  const body = (await apiFetch(AUTH_FEATURES_PATH, { method: 'GET' })) as Partial<Features> | null;
  return {
    password_reset_email: body?.password_reset_email === true,
    email: body?.email === true,
    receipt_scanning: body?.receipt_scanning === true,
    self_signup: body?.self_signup === true,
  };
}

/** The login-shaped answer of /api/auth/login and /api/auth/change-password. */
export interface LoginPayload {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  user?: { id: string; email?: string; roles?: string[]; must_change_password?: boolean; is_doctor?: boolean };
  roles?: string[];
  must_change_password?: boolean;
}

/** POST /api/auth/change-password: answers with a NEW token, which the
 *  caller stores with supabase.auth.setSessionFromLogin(). */
export function apiChangePassword(body: { current_password: string; new_password: string }): Promise<LoginPayload> {
  return apiFetch(AUTH_CHANGE_PASSWORD_PATH, { body }) as Promise<LoginPayload>;
}

/** POST /api/auth/admin/users/:id/reset-password (admin): the one-time
 *  temporary password. */
export async function apiAdminResetPassword(userId: string): Promise<{ temporary_password: string }> {
  return (await apiFetch(`${AUTH_ADMIN_USERS_PATH}/${encodeURIComponent(userId)}/reset-password`, {
    body: {},
  })) as { temporary_password: string };
}

/** POST /api/auth/password-reset/request: always 202 {ok:true}. */
export function apiPasswordResetRequest(email: string): Promise<unknown> {
  return apiFetch(PASSWORD_RESET_REQUEST_PATH, { body: { email } });
}

/** POST /api/auth/password-reset/confirm. */
export function apiPasswordResetConfirm(body: { token: string; new_password: string }): Promise<unknown> {
  return apiFetch(PASSWORD_RESET_CONFIRM_PATH, { body });
}

/** The landing page's booking form (no session). `website` is the honeypot
 *  and is always sent empty. */
export interface PublicBookingRequest {
  first_name: string;
  last_name: string;
  email?: string;
  phone?: string;
  date_of_birth?: string;
  reason: string;
  preferred_date: string;
  preferred_time: string;
  website: string;
}

export function apiSubmitBookingRequest(body: PublicBookingRequest): Promise<unknown> {
  return apiFetch(PUBLIC_BOOKING_REQUESTS_PATH, { body });
}

/** POST /api/booking-requests/:id/approve (staff). */
export async function apiApproveBookingRequest(
  id: string,
  body: { patient_id?: string; scheduled_start?: string } = {},
): Promise<{ patient_id: string; appointment_id: string }> {
  return (await apiFetch(`${BOOKING_REQUESTS_PATH}/${encodeURIComponent(id)}/approve`, { body })) as {
    patient_id: string;
    appointment_id: string;
  };
}

/** POST /api/booking-requests/:id/decline (staff). */
export function apiDeclineBookingRequest(id: string, reason?: string): Promise<unknown> {
  return apiFetch(`${BOOKING_REQUESTS_PATH}/${encodeURIComponent(id)}/decline`, {
    body: reason ? { reason } : {},
  });
}

/** Audit log filters (admin). Empty values are left out of the query. */
export interface AuditFilters {
  from?: string;
  to?: string;
  actor?: string;
  action?: string;
  entity_type?: string;
  entity_id?: string;
  limit?: number;
  offset?: number;
}

export interface AuditRow {
  id: string;
  at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  ip: string | null;
  summary: Record<string, unknown> | string | null;
}

function auditQuery(filters: AuditFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function apiAuditList(filters: AuditFilters): Promise<{ rows: AuditRow[]; total: number }> {
  const body = (await apiFetch(`${AUDIT_PATH}${auditQuery(filters)}`, { method: 'GET' })) as {
    rows?: AuditRow[];
    total?: number;
  } | null;
  return { rows: body?.rows ?? [], total: typeof body?.total === 'number' ? body.total : 0 };
}

/** GET /api/audit/export: the CSV text (paging is not sent). */
export function apiAuditExport(filters: AuditFilters): Promise<string> {
  const rest: AuditFilters = { ...filters };
  delete rest.limit;
  delete rest.offset;
  return apiFetch(`${AUDIT_EXPORT_PATH}${auditQuery(rest)}`, { method: 'GET', accept: 'text' });
}

/** POST /api/expenses/analyze-receipt (admin/moderator, optional feature). */
export interface ReceiptAnalysis {
  description?: string;
  amount?: number | string;
  category?: string;
  expense_date?: string;
  reference?: string;
  notes?: string;
}

export function apiAnalyzeReceipt(image: string): Promise<ReceiptAnalysis> {
  return apiFetch(ANALYZE_RECEIPT_PATH, { body: { image } }) as Promise<ReceiptAnalysis>;
}

export default apiFetch;
