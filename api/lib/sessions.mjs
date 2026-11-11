// api/lib/sessions.mjs — server-side sessions (public.app_sessions).
//
// The signed token (api/lib/tokens.mjs) proves who issued it; the session row
// decides whether it is still alive:
//
//   * idle timeout      SESSION_IDLE_MINUTES (default 30) since last_seen_at
//   * absolute lifetime SESSION_MAX_HOURS (default 12; SESSION_TTL_HOURS is
//                       accepted as the older name) since created_at
//   * revocation        logout, password change, admin password reset
//
// Every login creates a NEW session id (and revokes the one the caller
// presented, if any), so a session id can never be fixed in advance.

import { query } from '../db.mjs';
import { signToken } from './tokens.mjs';
import { clientIp } from './audit.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positive(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
    err.code = 'BAD_ENV';
    throw err;
  }
  return n;
}

export function sessionIdleMinutes(env = process.env) {
  return positive(env.SESSION_IDLE_MINUTES, 30, 'SESSION_IDLE_MINUTES');
}

export function sessionMaxHours(env = process.env) {
  const raw = env.SESSION_MAX_HOURS !== undefined && env.SESSION_MAX_HOURS !== '' ? env.SESSION_MAX_HOURS : env.SESSION_TTL_HOURS;
  return positive(raw, 12, 'SESSION_MAX_HOURS');
}

// How often last_seen_at is written: at most once per this many seconds per
// session, so a busy page does not turn every request into a write.
const TOUCH_EVERY_SECONDS = 30;

// createSession(user, req, {db}) -> { token, sid, expiresIn }
export async function createSession(user, req, { db } = {}) {
  const run = db ? (sql, p) => db.query(sql, p) : query;
  const hours = sessionMaxHours();
  const { rows } = await run(
    `insert into public.app_sessions (user_id, expires_at, ip, user_agent)
     values ($1, now() + make_interval(secs => $2), $3, $4)
     returning id`,
    [user.id, Math.round(hours * 3600), clientIp(req), String(req?.headers?.['user-agent'] ?? '').slice(0, 300) || null]
  );
  const sid = rows[0].id;
  const token = signToken({ sub: user.id, email: user.email, sid }, { ttlHours: hours });
  return { token, sid, expiresIn: Math.round(hours * 3600) };
}

// checkSession(sid, userId) -> 'ok' | 'expired' | 'missing'; touches last_seen_at.
export async function checkSession(sid, userId) {
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return 'missing';
  const idle = sessionIdleMinutes();
  const { rows } = await query(
    `select revoked_at is null as live,
            expires_at > now() as within_lifetime,
            last_seen_at > now() - make_interval(secs => $3) as within_idle,
            extract(epoch from (now() - last_seen_at)) as since_seen
       from public.app_sessions
      where id = $1 and user_id = $2`,
    [sid, userId, Math.round(idle * 60)]
  );
  const row = rows[0];
  if (!row) return 'missing';
  if (!row.live || !row.within_lifetime || !row.within_idle) {
    if (row.live) await query('update public.app_sessions set revoked_at = now() where id = $1 and revoked_at is null', [sid]);
    return 'expired';
  }
  if (Number(row.since_seen) >= TOUCH_EVERY_SECONDS) {
    await query('update public.app_sessions set last_seen_at = now() where id = $1', [sid]);
  }
  return 'ok';
}

export async function revokeSession(sid, { db } = {}) {
  if (typeof sid !== 'string' || !UUID_RE.test(sid)) return;
  const run = db ? (sql, p) => db.query(sql, p) : query;
  await run('update public.app_sessions set revoked_at = now() where id = $1 and revoked_at is null', [sid]);
}

// revokeUserSessions(userId, {except, db}): every live session of a user
// (password change keeps the new one via `except`).
export async function revokeUserSessions(userId, { except = null, db } = {}) {
  const run = db ? (sql, p) => db.query(sql, p) : query;
  await run(
    'update public.app_sessions set revoked_at = now() where user_id = $1 and revoked_at is null and ($2::uuid is null or id <> $2::uuid)',
    [userId, except]
  );
}
