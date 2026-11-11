// api/lib/session.mjs — who is calling: requireAuth / requireOptionalAuth /
// requireRole, and the shape they attach to the request.
//
// A session is the HS256 token from api/lib/tokens.mjs, presented either as
//
//   Authorization: Bearer <token>       (the SPA: the token lives in localStorage)
//   hh_token=<token>                    (a cookie: for scripted/crawler logins)
//
// and `req.user` is then, and only then:
//
//   { id: <uuid>, email: <text>, roles: [<app_role>, ...] }
//
// The identity and the roles are read from the database on every request
// (public.app_users + public.user_roles), never trusted from the token body.
// That is what makes S32 hold after the hosted RLS is gone: revoking a role, or
// deleting an account, takes effect on the caller's next request, not when
// their token happens to expire.
//
// Status codes are the uniform ones the plan fixes:
//
//   401 UNAUTHORIZED  nothing presented, or a token this server did not sign,
//                     or an expired one, or a user that no longer exists —
//                     every /api route answers this, /api/query included;
//   403 NO_ROLE       a valid session whose account holds no role at all: it is
//                     signed in, but the ported policies have nothing to allow
//                     it with, so no table or RPC can be reached;
//   403 FORBIDDEN     requireRole(...) when the caller lacks every listed role.
//
// When JWT_SECRET is unset nothing can be verified; that is answered 401
// (fail closed) rather than 500, and warned about once on the server log.

import { query } from '../db.mjs';
import { ApiError } from './http.mjs';
import { verifyToken } from './tokens.mjs';

// The cookie that mirrors the bearer token (task t5's form login sets it;
// SameSite=Lax so a cross-site request cannot ride on it).
export const SESSION_COOKIE = 'hh_token';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let warnedNoSecret = false;

// readSessionToken(req): the bearer token, or the session cookie, or null.
// The header wins: an explicit Authorization is the caller's clearest intent,
// and it is the path a cross-site form can never forge.
export function readSessionToken(req) {
  const header = req.headers?.authorization ?? req.headers?.Authorization;
  if (typeof header === 'string') {
    const m = /^\s*bearer\s+(\S+)\s*$/i.exec(header);
    if (m) return m[1];
  }
  const cookie = parseCookies(req.headers?.cookie)[SESSION_COOKIE];
  return cookie && cookie !== '' ? cookie : null;
}

// One row per caller: the account plus its roles aggregated into a text array,
// so a user with two roles is one row. A missing row means the account is gone.
async function loadUser(id) {
  const { rows } = await query(
    `select u.id,
            u.email,
            coalesce(
              array_agg(r.role::text order by r.role) filter (where r.role is not null),
              '{}'::text[]
            ) as roles
       from public.app_users u
       left join public.user_roles r on r.user_id = u.id
      where u.id = $1
      group by u.id, u.email`,
    [id]
  );
  return rows[0] ?? null;
}

// resolveUser(req): the caller's {id, email, roles}, or throws ApiError(401/403).
// Every branch is a decision, not a fallback: this is the only place in the API
// that decides whether a session is real.
export async function resolveUser(req) {
  const token = readSessionToken(req);
  if (!token) {
    throw new ApiError(401, 'A session is required: send Authorization: Bearer <token>', 'UNAUTHORIZED');
  }
  let payload;
  try {
    payload = verifyToken(token);
  } catch (e) {
    if (e.code === 'MISSING_ENV') {
      if (!warnedNoSecret) {
        warnedNoSecret = true;
        console.error('session: JWT_SECRET is unset, so every session is refused (see .env.example)');
      }
      throw new ApiError(401, 'Sessions are not configured on this server', 'UNAUTHORIZED');
    }
    // Expired, forged, malformed or wrong-algorithm: one answer, so the API does
    // not tell an attacker which of the four they got wrong.
    throw new ApiError(401, 'The session is not valid or has expired', 'UNAUTHORIZED');
  }
  const id = typeof payload.sub === 'string' ? payload.sub : '';
  if (!UUID_RE.test(id)) {
    throw new ApiError(401, 'The session is not valid or has expired', 'UNAUTHORIZED');
  }
  const row = await loadUser(id);
  if (!row) {
    throw new ApiError(401, 'The session belongs to an account that no longer exists', 'UNAUTHORIZED');
  }
  const roles = Array.isArray(row.roles) ? row.roles : [];
  if (roles.length === 0) {
    throw new ApiError(403, 'This account has no role assigned, so it cannot access any data', 'NO_ROLE');
  }
  return { id: row.id, email: row.email, roles };
}

// requireAuth: the gate every authenticated route mounts first (the RPC route,
// the query route's non-anonymous path, the ported edge functions). Sets
// req.user or answers 401/403 and stops there — the SQL never runs.
export function requireAuth(req, res, next) {
  resolveUser(req).then(
    (user) => {
      req.user = user;
      next();
    },
    (err) => next(err instanceof ApiError ? err : Object.assign(new ApiError(401, 'The session is not valid or has expired', 'UNAUTHORIZED'), { cause: err }))
  );
}

// requireOptionalAuth: same read, never a refusal. req.user is the session or
// null — which is what the anonymous allow-list path in the query route needs
// (a bad token is treated as "no caller", exactly as the hosted anon role did).
export function requireOptionalAuth(req, res, next) {
  resolveUser(req).then(
    (user) => {
      req.user = user;
      next();
    },
    () => {
      req.user = null;
      next();
    }
  );
}

// requireRole('admin') / requireRole('admin', 'staff'): a 403 FORBIDDEN unless
// the caller holds at least one of the listed roles. Use it after requireAuth
// (or on its own: without a session it answers 401, never 403).
export function requireRole(...names) {
  const required = names.flat().filter((n) => typeof n === 'string' && n !== '');
  return (req, res, next) => {
    if (!req.user || !req.user.id) {
      return next(new ApiError(401, 'A session is required: send Authorization: Bearer <token>', 'UNAUTHORIZED'));
    }
    if (required.length === 0) return next();
    if (!required.some((role) => req.user.roles.includes(role))) {
      return next(new ApiError(403, `This action requires the ${required.join(' or ')} role`, 'FORBIDDEN'));
    }
    return next();
  };
}

// parseCookies(header): the request's cookies, first occurrence winning, with
// percent-decoding and surrounding quotes removed. A malformed header is simply
// "no cookies" — a request is never failed over a cookie string.
export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header === '') return out;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (name === '' || name in out) continue;
    let value = part.slice(at + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
