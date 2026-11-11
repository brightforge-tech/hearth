// api/routes/rpc.mjs — POST /api/rpc/<name>: the RPC route (task t6).
//
// One route stands in for the hosted PostgREST `POST /rpc/<name>` call the SPA
// makes through supabase.rpc(...) — today only AdminSettings.tsx's
// `supabase.rpc('get_users_with_roles')` for the users panel.
//
// The contract:
//
//   POST /api/rpc/<name>   Authorization: Bearer <session>   -> 200 [rows...]
//   no session                                               -> 401 error JSON
//   a session the ported function rejects                    -> 403 error JSON
//   a name that is not on the allow-list                     -> 404 error JSON
//
// Two rules make this safe to expose once self-hosted (S32):
//
// 1. An allow-list, not a name passed through to SQL. The URL is a string from
//    the browser; dispatching on it means a table lookup in code, so the only
//    SQL that can ever run here is written in this file. `constructor` or
//    `__proto__` are not RPC functions either — the allow-list is a Map, so
//    Object.prototype properties are never callable.
//
// 2. The caller's identity reaches the database the way the ported policies
//    expect: withUser(req.user.id, ...) opens a transaction and issues
//    `set local app.uid = '<uuid>'` first, so public.current_uid() — and with
//    it get_users_with_roles' own `if not has_role(current_uid(), 'admin')` —
//    sees the authenticated caller and nothing else. The admin check therefore
//    lives where it already lived (in SQL, next to the data), and the API adds
//    requireAuth in front of it so an anonymous request never reaches the
//    database at all. The raise ('Access denied. Admin role required.') maps to
//    a 403 with the error envelope, so the caller learns the same thing the
//    hosted error did without a stack trace.
//
// A note on the response body: the rows themselves, as a JSON array — the
// shape the plan describes ("returning rows as JSON") and the one the shim's
// `.rpc()` wraps into supabase-js's `{data, error}` for the page. Failures use
// the shared envelope {"error":{"code","message"}} (api/lib/http.mjs).

import express from 'express';

import { withUser } from '../db.mjs';
import { ApiError, asyncHandler, sendJson } from '../lib/http.mjs';
import { requireAuth } from '../lib/session.mjs';

// The RPC allow-list. A Map on purpose: name lookups cannot reach prototype
// members, and adding an entry is the only way to expose a new function.
// `sql` is the whole statement — no parameter is interpolated into it.
export const RPC_FUNCTIONS = new Map([
  [
    'get_users_with_roles',
    {
      // db/migrations/0005_auth.sql: returns table(user_id uuid, email text,
      // created_at text, role text); raises 'Access denied. Admin role required.'
      // unless public.current_uid() holds the admin role.
      sql: 'select * from public.get_users_with_roles()',
    },
  ],
]);

// isAccessDenied(err): the function's own authorization raise, as opposed to
// some other database fault. P0001 is PL/pgSQL's raise_exception.
function isAccessDenied(err) {
  return err && err.code === 'P0001' && /access denied/i.test(String(err.message));
}

// runRpc: dispatch, then run the statement as the caller.
async function runRpc(req, res) {
  const name = req.params.name;
  const rpc = RPC_FUNCTIONS.get(name);
  if (!rpc) {
    // Which names exist is only ever acknowledged to a signed-in caller, and the
    // name is echoed back JSON-quoted, so an error message cannot be used to
    // smuggle markup into a client.
    throw new ApiError(
      404,
      `Unknown RPC function ${JSON.stringify(name)}: no such function is exposed`,
      'NOT_FOUND'
    );
  }
  // req.user.id is a uuid: requireAuth validated it against app_users first.
  let result;
  try {
    result = await withUser(req.user.id, (client) => client.query(rpc.sql));
  } catch (err) {
    if (isAccessDenied(err)) {
      throw new ApiError(403, String(err.message).split('\n')[0].trim(), 'FORBIDDEN');
    }
    // Anything else (a dropped connection, a missing function) stays a fault:
    // the error handler answers 500 without leaking the cause to the caller.
    throw err;
  }
  sendJson(res, 200, result.rows);
}

// The router. requireAuth is mounted on the group, so it applies to every
// request under /api/rpc before any dispatch or any SQL — a request without a
// session is answered 401 without the database being touched. Unknown verbs
// fall through to the shared JSON 404 in api/routes/index.mjs.
export function createRpcRouter() {
  const router = express.Router();
  router.use(requireAuth);
  router.post('/:name', asyncHandler(runRpc));
  return router;
}

export const router = createRpcRouter();

// A default export too: api/routes/index.mjs mounts whichever shape a route
// file provides, and the rpc group is documented as being picked up by name.
export default createRpcRouter;
