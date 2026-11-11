// Browser client for the self-hosted /api surface, shaped like supabase-js.
//
// Milestone 3 of the migration (work order brief-9.md, task t8): the
// upstream `supabase-js` client library dependency is gone and this file assembles the
// hand-written shim — `from()`/`rpc()` query builder (shim/query.ts),
// `auth.*` (shim/auth.ts), realtime channels (shim/realtime.ts) and storage
// (shim/storage.ts) — over the same call sites the pages were already using.
//
// Base URL: import.meta.env.VITE_API_URL when the bundler defines it, else
// process.env.VITE_API_URL (plain-node tests), else the page's own origin —
// the API is served under /api on the same origin in every deployment we
// have (the vite dev server proxies /api; production nginx serves both).
//
// `createSupabaseClient` exists so tests can build isolated clients (their
// own token storage, their own baseUrl). Pages keep importing the `supabase`
// singleton below, exactly as before.

import { createAuthClient } from './shim/auth.ts';
import { createQueryClient } from './shim/query.ts';
import { createRealtimeClient } from './shim/realtime.ts';
import { createStorageClient } from './shim/storage.ts';

export function createSupabaseClient(options: { baseUrl?: string } = {}) {
  let baseUrl = options.baseUrl;
  if (!baseUrl && typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) {
    baseUrl = import.meta.env.VITE_API_URL as string;
  }
  if (!baseUrl && typeof process !== 'undefined' && process.env?.VITE_API_URL) {
    baseUrl = process.env.VITE_API_URL;
  }
  if (!baseUrl && typeof window !== 'undefined' && window.location?.origin) {
    baseUrl = window.location.origin;
  }
  // Still nothing: same-origin relative requests. That is the correct
  // production behavior (the API is served under /api on the page's own
  // origin) and keeps this module importable by plain-node tests, which
  // always build their own client with an explicit baseUrl anyway.
  baseUrl = String(baseUrl ?? '').replace(/\/$/, '');

  // The auth client owns the access token; query/realtime/storage read it
  // per request so a sign-in on this client is immediately visible to them.
  const auth = createAuthClient({ baseUrl });
  const ctx = { baseUrl, getToken: (): string | null => auth.getToken() };

  const realtime = createRealtimeClient(ctx);
  const query = createQueryClient(ctx);

  return {
    ...query,
    auth,
    channel: realtime.channel,
    removeChannel: realtime.removeChannel,
    storage: createStorageClient(ctx),
    // Deliberately no `.functions` member: the brief says so, and the two
    // pages that used to invoke the hosted Edge Functions now reach the
    // ported endpoints through the named helpers in src/lib/api.ts.
  };
}

export const supabase = createSupabaseClient();

// The pages that upload patient documents call supabase.storage.from(...).
// There is deliberately no `.functions` member — see createSupabaseClient.
export default supabase;
