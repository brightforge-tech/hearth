// api/lib/throttle.mjs — database-backed login throttling.
//
// Two independent limits, both stored in public.login_attempts so they hold
// across restarts and across several API processes:
//
//   per account  LOGIN_MAX_FAILURES (default 5) consecutive failures since the
//                last successful sign-in lock the account name for
//                2^(n - max) minutes after the latest failure (1, 2, 4 ... capped
//                at LOGIN_MAX_LOCK_MINUTES, default 60);
//   per IP       LOGIN_IP_MAX_FAILURES (default 20) failures from one address
//                within LOGIN_IP_WINDOW_MINUTES (default 15) block that address
//                until the window has moved on.
//
// The account limit applies to names that do not exist, too, so the lockout
// answer cannot be used to discover which e-mail addresses have accounts.
// Attempts made while locked are not verified and not counted, so a locked
// attacker cannot keep extending the lock of a real user indefinitely.

import { query } from '../db.mjs';

function intEnv(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function throttleConfig(env = process.env) {
  return {
    maxFailures: intEnv(env, 'LOGIN_MAX_FAILURES', 5),
    maxLockMinutes: intEnv(env, 'LOGIN_MAX_LOCK_MINUTES', 60),
    ipMaxFailures: intEnv(env, 'LOGIN_IP_MAX_FAILURES', 20),
    ipWindowMinutes: intEnv(env, 'LOGIN_IP_WINDOW_MINUTES', 15),
  };
}

// lockMinutes(failures, cfg): the backoff for a run of consecutive failures.
export function lockMinutes(failures, cfg = throttleConfig()) {
  if (failures < cfg.maxFailures) return 0;
  return Math.min(2 ** (failures - cfg.maxFailures), cfg.maxLockMinutes);
}

// checkLogin(username, ip) -> { locked: false } | { locked: true, retryAfter: seconds, scope }
export async function checkLogin(username, ip, cfg = throttleConfig()) {
  const acct = await query(
    `with last_ok as (
       select max(created_at) as at from public.login_attempts where username = $1 and success
     )
     select count(*)::int as failures, max(a.created_at) as last_failure,
            extract(epoch from now())::float8 as now_s, extract(epoch from max(a.created_at))::float8 as last_s
       from public.login_attempts a, last_ok
      where a.username = $1 and not a.success
        and (last_ok.at is null or a.created_at > last_ok.at)
        and a.created_at > now() - interval '24 hours'`,
    [username]
  );
  const { failures, now_s: nowS, last_s: lastS } = acct.rows[0];
  const minutes = lockMinutes(failures, cfg);
  if (minutes > 0 && lastS) {
    const until = lastS + minutes * 60;
    if (until > nowS) return { locked: true, retryAfter: Math.ceil(until - nowS), scope: 'account' };
  }
  if (ip) {
    const byIp = await query(
      `select count(*)::int as failures,
              extract(epoch from min(created_at))::float8 as first_s,
              extract(epoch from now())::float8 as now_s
         from public.login_attempts
        where ip = $1 and not success and created_at > now() - make_interval(mins => $2)`,
      [ip, cfg.ipWindowMinutes]
    );
    const r = byIp.rows[0];
    if (r.failures >= cfg.ipMaxFailures) {
      const until = r.first_s + cfg.ipWindowMinutes * 60;
      return { locked: true, retryAfter: Math.max(1, Math.ceil(until - r.now_s)), scope: 'ip' };
    }
  }
  return { locked: false };
}

export async function recordAttempt(username, ip, success) {
  await query('insert into public.login_attempts (username, ip, success) values ($1, $2, $3)', [username, ip, success]);
}

// Housekeeping: attempts older than 30 days are of no use to the throttle.
export async function pruneAttempts() {
  await query("delete from public.login_attempts where created_at < now() - interval '30 days'");
}
