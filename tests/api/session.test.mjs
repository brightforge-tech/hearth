// tests/api/session.test.mjs — the session primitives behind the RPC route
// (task t6): api/lib/tokens.mjs signs and verifies the HS256 token, and
// api/lib/session.mjs decides from it who the caller is.
//
// No database and no server here: every case is chosen so the code paths under
// test never reach Postgres — an absent or unverifiable token is refused before
// the caller lookup, and requireRole/requireOptionalAuth work on req.user alone.
// The paths that do read public.user_roles (a real session, a roleless account,
// a role revoked between two calls) are proven over real HTTP against a real
// database in tests/api/rpc.test.mjs.

import { createHmac } from 'node:crypto';

import { ApiError } from '../../api/lib/http.mjs';
import { parseCookies, readSessionToken, requireAuth, requireOptionalAuth, requireRole } from '../../api/lib/session.mjs';
import { decodeToken, sessionTtlHours, signToken, verifyToken } from '../../api/lib/tokens.mjs';

const SECRET = 'unit-test-secret-0123456789abcdef';
const SUB = '11111111-2222-3333-4444-555555555555';

const token = (claims = { sub: SUB, email: 'a@b.test' }, opts = {}) => signToken(claims, { secret: SECRET, ...opts });

// run(middleware, req): invoke a middleware and report what it handed to
// next(). Async middleware settles on the microtask queue, so this waits — with
// a bound, because a middleware that never calls next() would hang the suite.
function run(middleware, req = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => reject(new Error('the middleware never called next()')), timeoutMs);
    const next = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ req, err, nextCalled: true });
    };
    let returned;
    try {
      returned = middleware(req, {}, next);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
      return;
    }
    if (returned && typeof returned.catch === 'function') returned.catch(() => {});
  });
}

const isApiError = (err, status, code) => err instanceof ApiError && err.status === status && err.code === code;

export default [
  {
    name: 'a signed token verifies, and carries the claims plus iat/exp',
    async fn() {
      const t = token();
      const payload = verifyToken(t, { secret: SECRET });
      if (payload.sub !== SUB || payload.email !== 'a@b.test') throw new Error(`claims: ${JSON.stringify(payload)}`);
      if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) throw new Error(`iat/exp: ${JSON.stringify(payload)}`);
      if (payload.exp - payload.iat !== 12 * 3600) throw new Error(`the default TTL must be 12 hours, got ${(payload.exp - payload.iat) / 3600}h`);
      const header = decodeToken(t).header;
      if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new Error(`header: ${JSON.stringify(header)}`);
      // three base64url parts, and the payload is readable without the secret —
      // which is exactly why roles are re-read from the database, not from here
      if (t.split('.').length !== 3) throw new Error('not a compact JWS');
      if (decodeToken(t).payload.sub !== SUB) throw new Error('the payload should be readable without the secret');
    },
  },
  {
    name: 'signToken writes iat/exp itself: a caller cannot mint a longer session',
    async fn() {
      const year = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
      const payload = verifyToken(token({ sub: SUB, exp: year, iat: 0 }, { secret: SECRET }), { secret: SECRET });
      if ((payload.exp - payload.iat) / 3600 !== 12) throw new Error(`a passed-in exp must be overridden, got a ${((payload.exp - payload.iat) / 3600).toFixed(1)}h session`);
      const short = verifyToken(token({ sub: SUB }, { secret: SECRET, ttlHours: 0.5 }), { secret: SECRET });
      if (Math.round(((short.exp - short.iat) / 3600) * 100) / 100 !== 0.5) throw new Error(`ttlHours ignored: ${JSON.stringify(short)}`);
      let caught = null;
      try {
        signToken({ sub: SUB }, { secret: SECRET, ttlHours: 0 });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.code !== 'BAD_TTL') throw new Error(`ttlHours=0 must be refused, got ${caught?.code ?? 'accepted'}`);
    },
  },
  {
    name: 'SESSION_TTL_HOURS sets the lifetime, and a bad value is refused',
    async fn() {
      if (sessionTtlHours({}) !== 12) throw new Error('the documented default is 12 hours');
      if (sessionTtlHours({ SESSION_TTL_HOURS: '' }) !== 12) throw new Error('an empty value must fall back to the default');
      if (sessionTtlHours({ SESSION_TTL_HOURS: '2.5' }) !== 2.5) throw new Error('SESSION_TTL_HOURS=2.5');
      for (const bad of ['0', '-1', 'abc']) {
        let caught = null;
        try {
          sessionTtlHours({ SESSION_TTL_HOURS: bad });
        } catch (e) {
          caught = e;
        }
        if (!caught || caught.code !== 'BAD_ENV') throw new Error(`SESSION_TTL_HOURS=${bad} must be refused with BAD_ENV, got ${caught?.code}`);
      }
      // and the value is what signToken issues
      const saved = process.env.SESSION_TTL_HOURS;
      process.env.SESSION_TTL_HOURS = '1';
      try {
        const payload = verifyToken(signToken({ sub: SUB }, { secret: SECRET }), { secret: SECRET });
        if ((payload.exp - payload.iat) / 3600 !== 1) throw new Error(`SESSION_TTL_HOURS=1 ignored: ${JSON.stringify(payload)}`);
      } finally {
        if (saved === undefined) delete process.env.SESSION_TTL_HOURS;
        else process.env.SESSION_TTL_HOURS = saved;
      }
    },
  },
  {
    name: 'a tampered payload, a foreign signature, or a forged algorithm is rejected',
    async fn() {
      const t = token();
      const [h, p, s] = t.split('.');

      // the payload swapped for one that grants the admin role, signature kept
      const forgedPayload = Buffer.from(
        JSON.stringify({ sub: SUB, email: 'a@b.test', role: 'admin', exp: Math.floor(Date.now() / 1000) + 3600 })
      ).toString('base64url');
      let caught = null;
      try {
        verifyToken(`${h}.${forgedPayload}.${s}`, { secret: SECRET });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.code !== 'TOKEN_SIGNATURE') throw new Error(`tampered payload: ${caught?.code ?? 'accepted'}`);

      // signed by someone else
      caught = null;
      try {
        verifyToken(token({ sub: SUB }, { secret: 'a-completely-different-secret-xyz' }), { secret: SECRET });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.code !== 'TOKEN_SIGNATURE') throw new Error(`foreign signature: ${caught?.code ?? 'accepted'}`);

      // alg:none, with the signature left in place
      const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      caught = null;
      try {
        verifyToken(`${noneHeader}.${p}.${s}`, { secret: SECRET });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.code !== 'TOKEN_ALG') throw new Error(`alg:none: ${caught?.code ?? 'accepted'}`);

      // the RS256 downgrade header
      caught = null;
      try {
        verifyToken(`${Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')}.${p}.${s}`, { secret: SECRET });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.code !== 'TOKEN_ALG') throw new Error(`RS256 header: ${caught?.code ?? 'accepted'}`);

      for (const junk of ['', '   ', 'not-a-token', `${h}.${p}`, null, undefined, {}, []]) {
        let err = null;
        try {
          verifyToken(junk, { secret: SECRET });
        } catch (e) {
          err = e;
        }
        if (!err || !['TOKEN_MISSING', 'TOKEN_MALFORMED'].includes(err.code)) {
          throw new Error(`${JSON.stringify(junk)} must be refused, got ${err?.code ?? 'accepted'}`);
        }
      }
    },
  },
  {
    name: 'an expired token, or one with no expiry, is refused; so is everything without JWT_SECRET',
    async fn() {
      // issued 13 hours ago with the default 12-hour TTL: exp is in the past
      const old = token({ sub: SUB }, { secret: SECRET, now: Math.floor(Date.now() / 1000) - 13 * 3600 });
      let caught = null;
      try {
        verifyToken(old, { secret: SECRET });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.code !== 'TOKEN_EXPIRED') throw new Error(`expired token: ${caught?.code ?? 'accepted'}`);

      // a token signed by this server but with no exp cannot be honoured either
      const unsigned = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: SUB, iat: Math.floor(Date.now() / 1000) })).toString('base64url'),
      ].join('.');
      const noExpiry = `${unsigned}.${Buffer.from(createHmac('sha256', SECRET).update(unsigned).digest()).toString('base64url')}`;
      caught = null;
      try {
        verifyToken(noExpiry, { secret: SECRET });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.code !== 'TOKEN_MALFORMED') throw new Error(`exp-less token: ${caught?.code ?? 'accepted'}`);

      // `secret: undefined` falls back to process.env.JWT_SECRET, which a .env
      // file (loaded by other suites) may have set: clear it for this check.
      const savedSecret = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      try {
      for (const secret of [undefined, '']) {
        let err = null;
        try {
          verifyToken(token(), { secret });
        } catch (e) {
          err = e;
        }
        if (!err || err.code !== 'MISSING_ENV') throw new Error(`JWT_SECRET=${JSON.stringify(secret)} must fail closed, got ${err?.code ?? 'accepted'}`);
        err = null;
        try {
          signToken({ sub: SUB }, { secret });
        } catch (e) {
          err = e;
        }
        if (!err || err.code !== 'MISSING_ENV') throw new Error('signing without JWT_SECRET must fail closed too');
      }
      } finally {
        if (savedSecret !== undefined) process.env.JWT_SECRET = savedSecret;
      }
    },
  },
  {
    name: 'readSessionToken: the bearer header wins, the hh_token cookie is the fallback',
    async fn() {
      const t = token();
      const other = token({ sub: '22222222-0000-0000-0000-000000000000' });
      const cases = [
        [{ headers: { authorization: `Bearer ${t}` } }, t, 'bearer header'],
        [{ headers: { authorization: `bearer ${t}` } }, t, 'lower-case scheme'],
        [{ headers: { authorization: `  Bearer  ${t}  ` } }, t, 'surrounding whitespace'],
        [{ headers: { cookie: `hh_token=${t}` } }, t, 'the session cookie'],
        [{ headers: { cookie: `other=1; hh_token="${t}"` } }, t, 'a quoted cookie value among others'],
        [{ headers: { authorization: `Bearer ${t}`, cookie: `hh_token=${other}` } }, t, 'the bearer header beats the cookie'],
        [{ headers: { authorization: 'Basic Zm9vOmJhcg==' } }, null, 'a Basic header is not a session'],
        [{ headers: { authorization: 'Bearer' } }, null, 'Bearer with no value'],
        [{ headers: {} }, null, 'no credentials'],
        [{}, null, 'no headers at all'],
        [{ headers: { cookie: 'other=1' } }, null, 'an unrelated cookie'],
      ];
      for (const [req, want, what] of cases) {
        const got = readSessionToken(req);
        if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${want === null ? 'null' : 'the token'}`);
      }
    },
  },
  {
    name: 'parseCookies: first occurrence wins, malformed input is simply no cookies',
    async fn() {
      const a = parseCookies('hh_token=one; other=x; hh_token=two');
      if (a.hh_token !== 'one' || a.other !== 'x') throw new Error(JSON.stringify(a));
      if (Object.keys(parseCookies(undefined)).length !== 0) throw new Error('an undefined header must read as no cookies');
      if (Object.keys(parseCookies('')).length !== 0) throw new Error('an empty header must read as no cookies');
      if (Object.keys(parseCookies('=nope; nope;')).length !== 0) throw new Error('malformed pairs must be ignored');
      // a cookie named after an Object.prototype member must still read as data
      if (parseCookies('constructor=1').constructor !== '1') throw new Error('cookie names must be plain data');
    },
  },
  {
    name: 'requireAuth refuses an absent or unverifiable session with 401 and never sets req.user',
    async fn() {
      const forged = token({ sub: SUB }, { secret: 'wrong-secret-entirely-0000000000' });
      const expired = token({ sub: SUB }, { secret: SECRET, now: Math.floor(Date.now() / 1000) - 24 * 3600 });
      const attempts = [
        ['no credentials', {}],
        ['junk bearer', { authorization: 'Bearer nonsense' }],
        ['foreign signature', { authorization: `Bearer ${forged}` }],
        ['expired token', { authorization: `Bearer ${expired}` }],
        ['cookie instead', { cookie: 'hh_token=nonsense' }],
      ];
      for (const [what, headers] of attempts) {
        const { err, nextCalled, req } = await run(requireAuth, { headers });
        if (!nextCalled) throw new Error(`${what}: the chain must stop by calling next(err)`);
        if (!isApiError(err, 401, 'UNAUTHORIZED')) throw new Error(`${what} -> ${err?.status} ${err?.code}`);
        if (!err.message || typeof err.message !== 'string') throw new Error(`${what}: the 401 has no message`);
        if (req.user !== undefined) throw new Error(`${what}: a refused request must not be given req.user`);
      }
    },
  },
  {
    name: 'requireOptionalAuth never refuses: a bad session leaves req.user null',
    async fn() {
      for (const headers of [{ authorization: 'Bearer nonsense' }, {}, { cookie: 'hh_token=' }]) {
        const { req, err } = await run(requireOptionalAuth, { headers });
        if (err !== undefined) throw new Error(`requireOptionalAuth must not pass an error: ${err?.message}`);
        if (req.user !== null) throw new Error(`req.user must be null, got ${JSON.stringify(req.user)}`);
      }
    },
  },
  {
    name: 'requireRole allows a listed role, answers 403 without one, and needs a session first',
    async fn() {
      const staff = { id: SUB, email: 's@b.test', roles: ['user'] };
      const admin = { id: SUB, email: 'a@b.test', roles: ['admin', 'user'] };

      let r = await run(requireRole('admin'), { user: staff });
      if (!isApiError(r.err, 403, 'FORBIDDEN')) throw new Error(`staff asked for admin -> ${r.err?.status} ${r.err?.code}`);
      if (!r.err.message.includes('admin')) throw new Error(`the message should name the role it needs: ${r.err.message}`);

      r = await run(requireRole('admin'), { user: admin });
      if (!r.nextCalled || r.err !== undefined) throw new Error(`admin asked for admin must pass: ${r.err?.status}`);

      r = await run(requireRole('admin', 'user'), { user: staff });
      if (!r.nextCalled || r.err !== undefined) throw new Error('an alternative role in the list must pass');

      r = await run(requireRole('moderator'), { user: admin });
      if (!isApiError(r.err, 403, 'FORBIDDEN')) throw new Error(`an admin asked for moderator only -> ${r.err?.status} ${r.err?.code}`);

      r = await run(requireRole(), { user: staff });
      if (!r.nextCalled || r.err !== undefined) throw new Error('asking for no role must pass');

      // no session at all is a 401, not a 403 that hints at a missing role
      r = await run(requireRole('admin'), {});
      if (!isApiError(r.err, 401, 'UNAUTHORIZED')) throw new Error(`no session -> ${r.err?.status} ${r.err?.code}`);
    },
  },
];
