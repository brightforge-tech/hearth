// src/integrations/supabase/shim/types.ts — the types our own supabase-shaped
// client speaks (task t8). They replace the handful of types the app used to
// import from the upstream supabase-js package:
//
//   * User / Session          — src/hooks/useAuth.tsx keeps its `import type`
//     line pointed here instead of at the old package;
//   * PostgrestError          — the error objects the query/rpc chains resolve
//     as `{data, error}`; like supabase-js it is a real Error with a `code`, so
//     a page's `if (error) throw error; ... e.message` keeps working;
//   * the auth/storage/realtime response envelopes — the shapes the pages
//     destructure today (`{data: {session}}`, `{data: {user}}`, `{data: {Path}}`,
//     `{data: {publicUrl}}`, `{data: {subscription}}`).
//
// Nothing in this file reaches the network: it is the vocabulary of the shim,
// and only erasable TypeScript syntax (interfaces and type aliases), so Node's
// type-stripping can load it and nothing here can break the browser build.

/** The signed-in account. `id` is the public.app_users uuid; `roles` is the
 *  server's answer (from public.user_roles) as of the last session read —
 *  pages re-check roles through the useAuth hook anyway. */
export interface User {
  id: string;
  email?: string;
  roles?: string[];
  created_at?: string;
}

/** A browser-held session: the bearer token the API signed (api/lib/tokens.mjs)
 *  plus the identity it belongs to. Kept in localStorage and sent as
 *  `Authorization: Bearer <access_token>` — never in a URL. */
export interface Session {
  access_token: string;
  token_type?: string;
  /** Unix seconds, when known (the API reports expires_in at login). */
  expires_at?: number | null;
  expires_in?: number | null;
  user: User | null;
}

/** What every /api failure arrives as: the {"error":{"code","message"}}
 *  envelope from api/lib/http.mjs, carried in a real Error so the pages'
 *  `throw error` → toast `e.message` chain is unchanged. */
export class PostgrestError extends Error {
  code: string;
  details: string | null;
  hint: string | null;

  constructor(message: string, code = 'INTERNAL_ERROR', details: string | null = null, hint: string | null = null) {
    super(message);
    this.name = 'PostgrestError';
    this.code = code;
    this.details = details;
    this.hint = hint;
  }
}

export interface AuthError extends PostgrestError {}

/** `{data: {session}, error}` — getSession(). */
export interface AuthSessionResponse {
  data: { session: Session | null };
  error: AuthError | null;
}

/** `{data: {user, session}, error}` — signInWithPassword() / signUp(). */
export interface AuthSessionFullResponse {
  data: { user: User | null; session: Session | null };
  error: AuthError | null;
}

/** `{data: {user}, error}` — auth.admin.createUser(). */
export interface AuthAdminUserResponse {
  data: { user: User | null };
  error: AuthError | null;
}

export interface AuthSubscription {
  unsubscribe(): void;
}

/** `{data: {subscription}}` — onAuthStateChange(), as the old client returned. */
export interface AuthSubscriptionResponse {
  data: { subscription: AuthSubscription };
}

/** What `.on('postgres_changes', params, cb)` accepts: the Postgres event
 *  ('*' or INSERT/UPDATE/DELETE), the schema, the table and an optional
 *  PostgREST-style row filter (`id=eq.<uuid>`). */
export interface RealtimePostgresChangesFilter {
  event?: string;
  schema?: string;
  table?: string;
  filter?: string;
  [key: string]: unknown;
}

/** The callback payload for a postgres_changes event. Pages today ignore the
 *  argument and just invalidate a react-query cache key, so the exact row
 *  shape carries no risk — but it is the same vocabulary the old client used. */
export interface RealtimePostgresChangesPayload<T = Record<string, unknown>> {
  eventType: string;
  schema: string;
  table: string;
  new: T;
  old: Partial<T>;
  commit_timestamp?: string;
}

/** storage.from(bucket).upload() resolves this. */
export interface StorageUploadResponse {
  data: { Path: string } | null;
  error: PostgrestError | null;
}

/** storage.from(bucket).getPublicUrl() returns this (synchronous). */
export interface StoragePublicUrlResponse {
  data: { publicUrl: string };
}

/** The `{data, error}` every query/RPC chain resolves to. */
export interface QueryResponse<T> {
  data: T;
  error: PostgrestError | null;
}
