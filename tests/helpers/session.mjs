// tests/helpers/session.mjs — session tokens for suites that sign their own.
//
// The API only accepts a token whose `sid` names a live row in
// public.app_sessions (api/lib/sessions.mjs). Suites that mint tokens
// directly (instead of logging in over HTTP) use signTestToken(), which puts a
// deterministic per-user sid in the token, and call ensureTestSessions(db)
// once their users exist, which creates exactly those session rows.

import { createHash } from 'node:crypto';
import { signToken } from '../../api/lib/tokens.mjs';

// testSid(userId): md5('hearth-test-session:' + id) formatted as a uuid —
// the same value ensureTestSessions computes in SQL.
export function testSid(userId) {
  const h = createHash('md5').update(`hearth-test-session:${userId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function signTestToken(claims = {}, opts = {}) {
  const sid = claims.sid ?? (typeof claims.sub === 'string' ? testSid(claims.sub) : undefined);
  return signToken({ ...claims, ...(sid ? { sid } : {}) }, opts);
}

// ensureTestSessions(db): a live session row for every account (idempotent).
export async function ensureTestSessions(db) {
  await db.query(
    `insert into public.app_sessions (id, user_id, expires_at)
     select md5('hearth-test-session:' || u.id::text)::uuid, u.id, now() + interval '1 day'
       from public.app_users u
     on conflict (id) do update set revoked_at = null, last_seen_at = now(), expires_at = excluded.expires_at`
  );
}
