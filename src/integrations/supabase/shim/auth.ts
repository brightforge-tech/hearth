// src/integrations/supabase/shim/auth.ts — the `supabase.auth` half of the
// browser shim (task t8). It replaces supabase-js's auth namespace with our
// own against the API's session endpoints (api/routes/auth.mjs):
//
//   getSession()            -> GET  /api/auth/session      (verify the stored token)
//   signInWithPassword()    -> POST /api/auth/login
//   signUp()                -> POST /api/auth/signup       (role 'user', no mail)
//   signOut()               -> POST /api/auth/logout + drop the token
//   admin.createUser()      -> POST /api/auth/admin/users  (roleless: the page
//                              then grants the role through user_roles itself)
//   onAuthStateChange(cb)   -> local listener list; events fire on sign-in,
//                              sign-out and the first getSession() resolution
//
// The token is the API's HS256 JWT. It lives in localStorage under this one
// key and rides on every request as `Authorization: Bearer <token>` — except
// when there is no session, where the header is left off entirely so the
// landing page's public reads/writes reach the API's anonymous allow-list
// (api/lib/authorization.mjs) exactly as the hosted anon role did.

import type {
  AuthAdminUserResponse,
  AuthError,
  AuthSessionFullResponse,
  AuthSessionResponse,
  AuthSubscriptionResponse,
  Session,
  User,
} from './types.ts';
import { PostgrestError } from './types.ts';

/** localStorage's key for the persisted session. */
export const SESSION_STORAGE_KEY = 'hh.session';

/** The auth events onAuthStateChange reports: the same names the old client
 *  used, so any code switched on them keeps its vocabulary. */
export type AuthEvent = 'SIGNED_IN' | 'SIGNED_OUT' | 'INITIAL_SESSION' | 'TOKEN_REFRESHED';

export type AuthStateCallback = (event: AuthEvent, session: Session | null) => void;

export interface AuthClient {
  getSession(): Promise<AuthSessionResponse>;
  getUser(): Promise<{ data: { user: User | null }; error: AuthError | null }>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<AuthSessionFullResponse>;
  signUp(credentials: {
    email: string;
    password: string;
    options?: { emailRedirectTo?: string; data?: Record<string, unknown> };
  }): Promise<AuthSessionFullResponse>;
  signOut(): Promise<{ error: AuthError | null }>;
  onAuthStateChange(callback: AuthStateCallback): AuthSubscriptionResponse;
  admin: {
    createUser(credentials: {
      email: string;
      password: string;
      email_confirm?: boolean;
      role?: string | null;
    }): Promise<AuthAdminUserResponse>;
  };
  /** Internal: the bearer token for the transport, or null when anonymous. */
  getToken(): string | null;
}

interface StoredSession {
  access_token: string;
  token_type?: string;
  expires_at?: number | null;
  expires_in?: number | null;
  user: User | null;
}

// The storage layer. localStorage in the browser; an in-memory fallback
// everywhere else (Node runs the shim in the regression tests) so importing
// this module never throws just because a window is missing.
function resolveStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  try {
    const local = (globalThis as { localStorage?: Storage }).localStorage;
    if (local && typeof local.getItem === 'function' && typeof local.setItem === 'function') return local;
  } catch {
    // Access to localStorage itself can throw (private mode); fall through.
  }
  const memory = new Map<string, string>();
  return {
    getItem: (key: string) => (memory.has(key) ? memory.get(key)! : null),
    setItem: (key: string, value: string) => void memory.set(key, value),
    removeItem: (key: string) => void memory.delete(key),
  };
}

function readStoredSession(storage: ReturnType<typeof resolveStorage>): Session | null {
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (typeof parsed?.access_token !== 'string' || parsed.access_token === '') return null;
    return {
      access_token: parsed.access_token,
      token_type: parsed.token_type ?? 'Bearer',
      expires_at: parsed.expires_at ?? null,
      expires_in: parsed.expires_in ?? null,
      user: parsed.user ?? null,
    };
  } catch {
    return null;
  }
}

function writeStoredSession(storage: ReturnType<typeof resolveStorage>, session: Session | null): void {
  try {
    if (session) storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // A storage that refuses writes (quota/private mode) only costs
    // persistence across reloads, never the current session.
  }
}

function envelopeError(status: number, body: unknown): AuthError {
  const err = body as { error?: { code?: string; message?: string; details?: string } } | null;
  const message =
    (err && typeof err.error?.message === 'string' && err.error.message) ||
    (status === 401 ? 'Invalid login credentials' : `The API answered ${status}`);
  return new PostgrestError(message, err?.error?.code ?? (status === 401 ? 'INVALID_LOGIN' : 'HTTP_ERROR'), err?.error?.details ?? null) as AuthError;
}

/** createAuthClient({ baseUrl, fetch }): the auth object for one API origin. */
export function createAuthClient({
  baseUrl,
  fetch: fetchImpl = globalThis.fetch,
}: {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
}): AuthClient {
  const storage = resolveStorage();
  // The live session, hydrated from storage on first use and kept mirrored
  // there; every method works through these two helpers so one sign-in is
  // visible to every other client instance sharing this storage.
  let session: Session | null | undefined;
  const current = (): Session | null => {
    if (session === undefined) session = readStoredSession(storage);
    return session;
  };
  const set = (next: Session | null): Session | null => {
    session = next;
    writeStoredSession(storage, next);
    return next;
  };

  const listeners = new Set<AuthStateCallback>();
  const emit = (event: AuthEvent, value: Session | null): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event, value);
      } catch {
        // A page's listener throwing must not corrupt the auth state machine.
      }
    }
  };

  async function post(path: string, body: unknown, token?: string | null): Promise<{ status: number; json: unknown }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const bearer = token === undefined ? current()?.access_token ?? null : token;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body ?? {}),
      });
    } catch (e) {
      throw new PostgrestError(`Cannot reach the API at ${baseUrl}${path}: ${(e as Error).message}`, 'FETCH_ERROR');
    }
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      // no/invalid body — the status still decides
    }
    return { status: response.status, json };
  }

  /** Turn an API success body into the Session the shim hands to the pages. */
  function sessionFrom(json: { access_token: string; user?: User; expires_in?: number } & Record<string, unknown>): Session {
    const now = Math.floor(Date.now() / 1000);
    return {
      access_token: json.access_token,
      token_type: typeof json.token_type === 'string' ? json.token_type : 'Bearer',
      expires_in: typeof json.expires_in === 'number' ? json.expires_in : null,
      expires_at: typeof json.expires_in === 'number' ? now + json.expires_in : null,
      user: json.user ?? null,
    };
  }

  const auth: AuthClient = {
    async getSession(): Promise<AuthSessionResponse> {
      let stored = current();
      if (stored) {
        // The token is opaque, so "have a session" means "the API still
        // accepts it": one cheap GET verifies signature, expiry and that the
        // account (and its roles) still exist. A refusal means the stored
        // token is dead — drop it, so the UI lands on the sign-in page
        // instead of a page full of 401 toasts.
        try {
          const response = await fetchImpl(`${baseUrl}/api/auth/session`, {
            method: 'GET',
            headers: { authorization: `Bearer ${stored.access_token}` },
          });
          if (response.ok) {
            const body = (await response.json().catch(() => null)) as { user?: User } | null;
            stored = set({ ...stored, user: body?.user ?? stored.user });
          } else if (response.status === 401 || response.status === 403) {
            stored = set(null);
          }
          // any other status (a fault): keep the stored session; a query that
          // still needs it will surface the real error itself.
        } catch {
          // network fault: same as above — keep what we have.
        }
      }
      // The old client delivered INITIAL_SESSION to a fresh listener once the
      // session was known; useAuth's loading gate ends on that event or on
      // this promise, whichever lands first, and both carry the same value.
      emit('INITIAL_SESSION', stored);
      return { data: { session: stored }, error: null };
    },

    async getUser() {
      const { data } = await auth.getSession();
      return { data: { user: data.session?.user ?? null }, error: null };
    },

    async signInWithPassword({ email, password }): Promise<AuthSessionFullResponse> {
      try {
        const { status, json } = await post('/api/auth/login', { email, password }, null);
        if (status !== 200) return { data: { user: null, session: null }, error: envelopeError(status, json) };
        const fresh = set(sessionFrom(json as never));
        emit('SIGNED_IN', fresh);
        return { data: { user: fresh?.user ?? null, session: fresh }, error: null };
      } catch (e) {
        return { data: { user: null, session: null }, error: e as AuthError };
      }
    },

    async signUp({ email, password }): Promise<AuthSessionFullResponse> {
      try {
        const { status, json } = await post('/api/auth/signup', { email, password }, null);
        if (status !== 200) return { data: { user: null, session: null }, error: envelopeError(status, json) };
        // No verification mail is sent and the account is immediately usable
        // (api/routes/auth.mjs, W18); the response already carries a session.
        const fresh = set(sessionFrom(json as never));
        emit('SIGNED_IN', fresh);
        return { data: { user: fresh?.user ?? null, session: fresh }, error: null };
      } catch (e) {
        return { data: { user: null, session: null }, error: e as AuthError };
      }
    },

    async signOut() {
      const token = current()?.access_token ?? null;
      set(null);
      emit('SIGNED_OUT', null);
      if (token) {
        // Best-effort: clearing the cookie. The SPA's own token is already
        // gone, and an expired token is worthless by itself.
        try {
          await post('/api/auth/logout', {}, token);
        } catch {
          // the local sign-out already happened
        }
      }
      return { error: null };
    },

    onAuthStateChange(callback: AuthStateCallback): AuthSubscriptionResponse {
      listeners.add(callback);
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              listeners.delete(callback);
            },
          },
        },
      };
    },

    admin: {
      async createUser({ email, password, email_confirm, role }): Promise<AuthAdminUserResponse> {
        try {
          // role: null on purpose. This mirrors the hosted auth.admin.createUser,
          // which created the account WITHOUT any grant; the caller (the Admin
          // Settings users panel) then inserts the chosen role into user_roles
          // itself. Granting 'user' here would collide with that insert
          // (user_roles unique (user_id, role)) or silently double-grant.
          const { status, json } = await post('/api/auth/admin/users', {
            email,
            password,
            email_confirm: email_confirm ?? true,
            role: role === undefined ? null : role,
          });
          if (status !== 200 && status !== 201) return { data: { user: null }, error: envelopeError(status, json) };
          const body = json as { user?: User };
          return { data: { user: body?.user ?? null }, error: null };
        } catch (e) {
          return { data: { user: null }, error: e as AuthError };
        }
      },
    },

    getToken(): string | null {
      return current()?.access_token ?? null;
    },
  };

  return auth;
}

export default createAuthClient;
