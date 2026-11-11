// api/lib/tokens.mjs — HS256 session tokens (the session layer's crypto).
//
// A session token is a plain JSON Web Token signed with HMAC-SHA256:
//
//   header   {"alg":"HS256","typ":"JWT"}
//   payload  {"sub":<app_users id>, "email":<email>, "iat":<s>, "exp":<s>}
//   sig      base64url(HMAC-SHA256(header.payload, JWT_SECRET))
//
// Nothing sensitive belongs in the payload: it is readable by whoever holds it
// (the SPA keeps it in localStorage), and the server never trusts the claims it
// cannot verify — the signature decides who issued it, `exp` decides when it
// stops working, and the caller's roles are re-read from public.user_roles on
// every request (api/lib/session.mjs), so revoking a role takes effect at once.
//
// Failure modes are codes, not HTTP: this module is used by the route layer,
// which turns them into 401s. They are never swallowed — a token this module
// cannot vouch for is always rejected:
//
//   MISSING_ENV       JWT_SECRET is unset: nothing can be verified (fail closed)
//   TOKEN_MISSING     nothing was presented
//   TOKEN_MALFORMED   not three base64url parts, or the payload is not JSON
//   TOKEN_ALG         the header does not say exactly HS256 (blocks alg:none and
//                     the RS256/HS256 confusion attacks on verifiers)
//   TOKEN_EXPIRED     exp has passed (or exp is absent — a token must expire)
//   TOKEN_SIGNATURE   the signature does not match the secret

import { createHmac, timingSafeEqual } from 'node:crypto';

// Matches the default the plan documents for SESSION_TTL_HOURS.
export const DEFAULT_TTL_HOURS = 12;

// The only accepted algorithm, spelled exactly as it appears in the header.
const ALGORITHM = 'HS256';
const HEADER = { alg: ALGORITHM, typ: 'JWT' };

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(input, secret) {
  return createHmac('sha256', String(secret)).update(input, 'utf8').digest();
}

// sessionTtlHours(env): how long a freshly issued token is valid.
export function sessionTtlHours(env = process.env) {
  const raw = env.SESSION_TTL_HOURS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_TTL_HOURS;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw fail('BAD_ENV', `SESSION_TTL_HOURS must be a positive number of hours, got ${JSON.stringify(raw)}`);
  }
  return hours;
}

// signToken(claims, {secret, ttlHours, now}): issues a token. `iat`/`exp` are
// always written here — a caller cannot pass them in and so cannot mint a
// session that outlives the configured TTL.
//   signToken({ sub: id, email }, { secret })
export function signToken(claims = {}, { secret = process.env.JWT_SECRET, ttlHours, now } = {}) {
  if (typeof secret !== 'string' || secret === '') {
    throw fail('MISSING_ENV', 'JWT_SECRET is not set: session tokens cannot be signed (see .env.example)');
  }
  const hours = ttlHours === undefined ? sessionTtlHours() : ttlHours;
  if (!Number.isFinite(hours) || hours <= 0) {
    throw fail('BAD_TTL', `ttlHours must be a positive number of hours, got ${JSON.stringify(ttlHours)}`);
  }
  const issuedAt = Math.floor(now === undefined ? Date.now() / 1000 : now);
  // iat/exp are ours to set, never the caller's: whatever came in is dropped
  const rest = { ...claims };
  delete rest.iat;
  delete rest.exp;
  const payload = { ...rest, iat: issuedAt, exp: issuedAt + Math.round(hours * 3600) };
  const signingInput = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${b64url(sign(signingInput, secret))}`;
}

// decodeToken(token): the parts of a token WITHOUT checking the signature.
// Only for display/diagnostics — nothing may make an authorization decision on
// this. Returns null when the string is not a JWT at all.
export function decodeToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 3 || parts.some((p) => p === '')) return null;
  const [header, payload, signature] = parts;
  const json = (part) => {
    try {
      const text = Buffer.from(part, 'base64url').toString('utf8');
      const value = JSON.parse(text);
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  };
  const h = json(header);
  const p = json(payload);
  if (!h || !p) return null;
  return { header: h, payload: p, signingInput: `${header}.${payload}`, signature };
}

// verifyToken(token, {secret, now}): the payload of a token this server signed
// and that has not expired. Throws an Error carrying one of the codes above.
export function verifyToken(token, { secret = process.env.JWT_SECRET, now } = {}) {
  if (typeof secret !== 'string' || secret === '') {
    throw fail('MISSING_ENV', 'JWT_SECRET is not set: session tokens cannot be verified (see .env.example)');
  }
  if (token === undefined || token === null || String(token).trim() === '') {
    throw fail('TOKEN_MISSING', 'No session token was presented');
  }
  const decoded = decodeToken(token);
  if (!decoded) throw fail('TOKEN_MALFORMED', 'The session token is malformed');
  if (decoded.header.alg !== ALGORITHM || decoded.header.typ !== 'JWT') {
    throw fail('TOKEN_ALG', `The session token must be an ${ALGORITHM} JWT`);
  }
  const expected = sign(decoded.signingInput, secret);
  const got = Buffer.from(decoded.signature, 'base64url');
  // timingSafeEqual throws on a length mismatch, which is itself a side channel
  // a caller can probe, so compare lengths first and always run the comparison.
  const scratch = Buffer.alloc(expected.length);
  const equal = got.length === expected.length && timingSafeEqual(got, expected);
  if (!equal) {
    timingSafeEqual(scratch, scratch);
    throw fail('TOKEN_SIGNATURE', 'The session token was not signed by this server');
  }
  const seconds = Math.floor(now === undefined ? Date.now() / 1000 : now);
  if (!Number.isInteger(decoded.payload.exp)) {
    throw fail('TOKEN_MALFORMED', 'The session token has no expiry');
  }
  if (decoded.payload.exp <= seconds) throw fail('TOKEN_EXPIRED', 'The session token has expired');
  return decoded.payload;
}
