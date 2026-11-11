// tests/api/auth.test.mjs — POST /api/auth/login|signup|logout,
// GET /api/auth/session, POST /api/auth/admin/users (task t5; criteria
// W14, W15, W16, W18, W20).
//
// Like the RPC suite, every case drives a real `node api/server.mjs --port <n>`
// over real HTTP against a scratch PostgreSQL database — but unlike the RPC
// suite these cases turn the start-up seed ON (SEED_ACCOUNTS: '1', which the
// tests/helpers/server.mjs default switches off), so the accounts the criteria
// sign in with are the ones the server itself created on first boot. That is
// the path the operator and the controller take:
//
//   node api/server.mjs --port <n>
//   POST /api/auth/login {"email":"admin@example.test","password":"Admin#2025test"}
//
// and it has to work end to end, migrations and seeding included.

import pg from 'pg';

import { signToken } from '../../api/lib/tokens.mjs';
import { request, startServer } from '../helpers/server.mjs';

const SCRATCH = '_t5';
const JWT_SECRET = 't5-auth-suite-secret-0123456789abcdef';
const FOREIGN_SECRET = 't5-auth-suite-OTHER-secret-0123456789';
const ALLOWED_ORIGIN = 'http://localhost:8080';

const ADMIN = { email: 'admin@example.test', password: 'Admin#2025test' };
const STAFF = { email: 'staff@example.test', password: 'Staff#2025test' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function swapDb(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

function scratchDsn(testUrl) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  return swapDb(testUrl, `${base}${SCRATCH}`);
}

function clientParams(url, database) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password ? decodeURIComponent(u.password) : '',
    database,
    connectionTimeoutMillis: 5000,
  };
}

async function withAdminDb(testUrl, fn) {
  const admin = new pg.Client(clientParams(testUrl, 'postgres'));
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

// The environment the milestone criteria describe: seeding ON with the
// documented defaults, a known JWT secret, and one allow-listed origin.
function seedEnv(extra = {}) {
  return {
    SEED_ACCOUNTS: '1',
    JWT_SECRET,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    ...extra,
  };
}

// withApi({root, testUrl, env}, fn): a scratch database, one API against it
// (started exactly like the operator starts it), and a db handle for peeking
// behind the wire — password_hash is a column the wire must never show.
async function withApi({ root, testUrl, env = {}, keepDb = false }, fn) {
  const dsn = scratchDsn(testUrl);
  const scratch = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  await withAdminDb(testUrl, async (admin) => {
    await admin.query(`drop database if exists "${scratch}" with (force)`);
    await admin.query(`create database "${scratch}"`);
  });

  const handle = startServer({ root, databaseUrl: dsn, env: seedEnv(env) });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();

    const api = {
      db,
      port: handle.port,
      log: handle.log,
      dsn,
      scratch,
      call: (path, opts) => request(handle.port, path, opts),
      postJson: (path, body, extra = {}) =>
        request(handle.port, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) },
          body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
        }),
      login: (email = ADMIN.email, password = ADMIN.password, headers = {}) =>
        request(handle.port, '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ email, password }),
        }),
      adminToken: async () => {
        const r = await api.login();
        if (r.status !== 200) throw new Error(`the seeded admin could not log in: ${r.status} ${r.text}`);
        return r.json.access_token;
      },
    };
    await fn(api);
  } finally {
    try {
      await db.end();
    } catch {
      /* the connection may already have gone with the server */
    }
    await handle.stop();
    if (!keepDb) {
      try {
        await withAdminDb(testUrl, (admin) => admin.query(`drop database if exists "${scratch}" with (force)`));
      } catch {
        /* leaving a scratch database behind is not a test failure */
      }
    }
  }
}

// --- shared assertions --------------------------------------------------------

function expectError(r, status, { label = `${status}`, code } = {}) {
  if (r.status !== status) throw new Error(`${label}: expected ${status}, got ${r.status}: ${r.text}`);
  if (!/^application\/json/.test(r.headers['content-type'] ?? '')) {
    throw new Error(`${label}: content-type is ${r.headers['content-type']}: ${r.text}`);
  }
  if (typeof r.json?.error?.message !== 'string' || r.json.error.message === '') {
    throw new Error(`${label}: no message in the error envelope: ${r.text}`);
  }
  if (code && r.json.error.code !== code) throw new Error(`${label}: expected code ${code}, got ${JSON.stringify(r.json.error)}`);
}

// sessionBody: what W14/W18 say a successful login/signup response must carry.
function expectSessionBody(json, { label, email, role }) {
  if (!json || typeof json !== 'object') throw new Error(`${label}: body is not a JSON object`);
  if (typeof json.access_token !== 'string' || !JWT_RE.test(json.access_token)) {
    throw new Error(`${label}: no access_token (three base64url parts) in ${JSON.stringify(json).slice(0, 200)}`);
  }
  if (!json.user || typeof json.user !== 'object') throw new Error(`${label}: no user object`);
  if (typeof json.user.id !== 'string' || !UUID_RE.test(json.user.id)) throw new Error(`${label}: user.id is not a uuid: ${json.user.id}`);
  if (json.user.email !== email) throw new Error(`${label}: user.email is ${json.user.email}, expected ${email}`);
  if (!Array.isArray(json.user.roles) || json.user.roles.join(',') !== role) {
    throw new Error(`${label}: user.roles must be [${JSON.stringify(role)}], got ${JSON.stringify(json.user.roles)}`);
  }
  if (!Array.isArray(json.roles) || json.roles.join(',') !== role) {
    throw new Error(`${label}: the top-level roles must mirror the account's, got ${JSON.stringify(json.roles)}`);
  }
}

function cookieValue(r, name) {
  const cookies = r.headers['set-cookie'] ?? [];
  const found = cookies.map(String).find((c) => c.startsWith(`${name}=`));
  return found ? { header: found, value: found.split(';')[0].split('=')[1] } : null;
}

export default [
  {
    name: 'W14: POST /api/auth/login (JSON) with the seeded admin returns a session with roles [admin]',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const r = await api.login();
        if (r.status !== 200) throw new Error(`seeded admin login -> ${r.status}: ${r.text}`);
        expectSessionBody(r.json, { label: 'admin login', email: ADMIN.email, role: 'admin' });

        // the token is the server's HS256 session token: the header must say HS256
        const [header] = r.json.access_token.split('.');
        const headerJson = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
        if (headerJson.alg !== 'HS256' || headerJson.typ !== 'JWT') throw new Error(`token header: ${JSON.stringify(headerJson)}`);

        // no credential material on the wire — not even hashed
        const lower = r.text.toLowerCase();
        for (const leak of ['password', 'hash', 'scrypt']) {
          if (lower.includes(leak)) throw new Error(`the login body mentions "${leak}": ${r.text.slice(0, 200)}`);
        }

        // the response also sets the mirror cookie (SameSite=Lax per the plan)
        const cookie = cookieValue(r, 'hh_token');
        if (!cookie) throw new Error(`no hh_token cookie in ${JSON.stringify(r.headers['set-cookie'])}`);
        if (!/samesite=lax/i.test(cookie.header)) throw new Error(`the session cookie is not SameSite=Lax: ${cookie.header}`);
      });
    },
  },
  {
    name: 'W14: a wrong password is 401 with the error envelope and creates no session',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const r = await api.login(ADMIN.email, 'Admin#2025WRONG');
        expectError(r, 401, { label: 'wrong password' });
        if (/access|session/i.test(r.json.error.message) && !/invalid/i.test(r.json.error.message)) {
          throw new Error(`the 401 must report bad credentials, not sessions: ${r.text}`);
        }
        // no session was created: no cookie, and no token to try
        if (cookieValue(r, 'hh_token')) throw new Error(`a refused login set a session cookie: ${JSON.stringify(r.headers['set-cookie'])}`);
        if (typeof r.json?.access_token === 'string') throw new Error(`a refused login returned an access_token: ${r.text.slice(0, 160)}`);

        // an unknown account answers identically — the API never says which half failed
        const unknown = await api.login('nobody@example.test', ADMIN.password);
        expectError(unknown, 401, { label: 'unknown account' });
        if (unknown.json.error.message !== r.json.error.message) {
          throw new Error(`unknown account and wrong password answer differently, enabling account enumeration:\n${r.json.error.message}\n${unknown.json.error.message}`);
        }

        // and a body that is not even credentials is a 400, not a 500
        expectError(await api.postJson('/api/auth/login', { email: ADMIN.email }), 400, { label: 'missing password' });
        expectError(await api.postJson('/api/auth/login', {}), 400, { label: 'empty body' });

        // the account itself is intact: the correct password still logs in
        const stillWorks = await api.login();
        if (stillWorks.status !== 200) throw new Error(`the account broke after failed attempts: ${stillWorks.status} ${stillWorks.text}`);
      });
    },
  },
  {
    name: 'W15: GET /api/auth/session answers 200 for a valid token and 401 for none, forged, or expired',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const login = await api.login();
        const token = login.json.access_token;

        const good = await request(api.port, '/api/auth/session', { headers: { authorization: `Bearer ${token}` } });
        if (good.status !== 200) throw new Error(`valid token -> ${good.status}: ${good.text}`);
        if (good.json?.user?.email !== ADMIN.email || good.json?.user?.roles?.join(',') !== 'admin' || good.json?.roles?.join(',') !== 'admin') {
          throw new Error(`session body must carry the user and its roles: ${good.text}`);
        }

        // the staff account reads its own roles through the same endpoint
        const staffLogin = await api.login(STAFF.email, STAFF.password);
        if (staffLogin.status !== 200) throw new Error(`staff login -> ${staffLogin.status}: ${staffLogin.text}`);
        const staffSession = await request(api.port, '/api/auth/session', { headers: { authorization: `Bearer ${staffLogin.json.access_token}` } });
        if (staffSession.status !== 200 || staffSession.json.roles.join(',') !== 'user') {
          throw new Error(`staff session: ${staffSession.status} ${staffSession.text}`);
        }

        // no Authorization header at all
        const anonymous = await request(api.port, '/api/auth/session');
        expectError(anonymous, 401, { label: 'no header' });

        // a token whose signature is wrong (another issuer signed it)
        const forged = signToken({ sub: login.json.user.id, email: ADMIN.email }, { secret: FOREIGN_SECRET });
        expectError(await request(api.port, '/api/auth/session', { headers: { authorization: `Bearer ${forged}` } }), 401, { label: 'forged signature' });

        // a token that has expired (issued 24h ago on the suite's 12h TTL)
        const expired = signToken({ sub: login.json.user.id, email: ADMIN.email }, { secret: JWT_SECRET, now: Math.floor(Date.now() / 1000) - 24 * 3600 });
        expectError(await request(api.port, '/api/auth/session', { headers: { authorization: `Bearer ${expired}` } }), 401, { label: 'expired token' });

        // and the session cookie the JSON login set works as well
        const cookie = cookieValue(login, 'hh_token');
        const viaCookie = await request(api.port, '/api/auth/session', { headers: { cookie: `hh_token=${cookie.value}` } });
        if (viaCookie.status !== 200 || viaCookie.json.user.id !== login.json.user.id) {
          throw new Error(`session via the mirror cookie: ${viaCookie.status} ${viaCookie.text}`);
        }
      });
    },
  },
  {
    name: 'W16: form login (urlencoded user/pass) answers 302 to / with a session cookie that carries a session',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const body = `user=${encodeURIComponent(ADMIN.email)}&pass=${encodeURIComponent(ADMIN.password)}`;
        const r = await request(api.port, '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });
        if (r.status !== 302) throw new Error(`form login -> ${r.status}: ${r.text}`);
        if (r.headers.location !== '/') throw new Error(`form login redirects to ${JSON.stringify(r.headers.location)}, expected "/"`);
        const cookie = cookieValue(r, 'hh_token');
        if (!cookie || !JWT_RE.test(cookie.value)) throw new Error(`no session cookie on the 302: ${JSON.stringify(r.headers['set-cookie'])}`);
        if (!/samesite=lax/i.test(cookie.header)) throw new Error(`cookie is not SameSite=Lax: ${cookie.header}`);

        // the cookie really is the session
        const session = await request(api.port, '/api/auth/session', { headers: { cookie: `hh_token=${cookie.value}` } });
        if (session.status !== 200) throw new Error(`GET /api/auth/session with the cookie -> ${session.status}: ${session.text}`);
        if (session.json.user.email !== ADMIN.email || session.json.roles.join(',') !== 'admin') {
          throw new Error(`session body: ${session.text}`);
        }

        // GET on the login path serves the sign-in page the scripted
        // sign-ins fill and submit — HTML, with both field spellings named.
        const page = await request(api.port, '/api/auth/login');
        if (page.status !== 200 || !/^text\/html/.test(page.headers['content-type'] ?? '')) {
          throw new Error(`GET /api/auth/login -> ${page.status} ${page.headers['content-type']}`);
        }
        for (const field of ['name="email"', 'name="password"', 'name="user"', 'name="pass"', 'method="POST"']) {
          if (!page.text.includes(field)) throw new Error(`the login page is missing ${field}`);
        }

        // email/password field spellings work on the form too
        const alt = await request(api.port, '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `email=${encodeURIComponent(STAFF.email)}&password=${encodeURIComponent(STAFF.password)}`,
        });
        if (alt.status !== 302 || !cookieValue(alt, 'hh_token')) throw new Error(`email/password form login -> ${alt.status}: ${alt.text}`);

        // wrong form credentials get the JSON 401, no cookie, no redirect
        const bad = await request(api.port, '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: `user=${encodeURIComponent(ADMIN.email)}&pass=not-the-password`,
        });
        expectError(bad, 401, { label: 'form login, wrong password' });
        if (cookieValue(bad, 'hh_token')) throw new Error('a refused form login set a cookie');
      });
    },
  },
  {
    name: 'W18: POST /api/auth/signup creates a role-user account with a session; a repeat is 409 with no second row',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const email = `t5-signup-${Date.now()}-${Math.floor(Math.random() * 1e6)}@signup.test`;
        const password = 'S1gnup-Str0ng!pw';

        const r = await api.postJson('/api/auth/signup', { email, password });
        if (r.status !== 200) throw new Error(`signup -> ${r.status}: ${r.text}`);
        expectSessionBody(r.json, { label: 'signup', email, role: 'user' });

        // the account really holds role 'user' (not admin — the API decides)
        const roles = await api.db.query(
          `select r.role::text as role from public.user_roles r join public.app_users u on u.id = r.user_id where u.email = $1`,
          [email]
        );
        if (roles.rows.map((row) => row.role).join(',') !== 'user') throw new Error(`roles for ${email}: ${JSON.stringify(roles.rows)}`);

        // and the returned session is a real session
        const session = await request(api.port, '/api/auth/session', { headers: { authorization: `Bearer ${r.json.access_token}` } });
        if (session.status !== 200 || session.json.roles.join(',') !== 'user') throw new Error(`new account session: ${session.status} ${session.text}`);

        // signing the same e-mail up again: 409, error envelope, one row
        const again = await api.postJson('/api/auth/signup', { email, password });
        expectError(again, 409, { label: 'duplicate signup', code: 'EMAIL_TAKEN' });
        const count = await api.db.query('select count(*)::int as n from public.app_users where email = $1', [email]);
        if (count.rows[0].n !== 1) throw new Error(`${count.rows[0].n} app_users rows after a duplicate signup`);
        const roleCount = await api.db.query(
          'select count(*)::int as n from public.user_roles r join public.app_users u on u.id = r.user_id where u.email = $1',
          [email]
        );
        if (roleCount.rows[0].n !== 1) throw new Error(`${roleCount.rows[0].n} role rows after a duplicate signup`);

        // the new account can log in normally
        const login = await api.login(email, password);
        if (login.status !== 200 || login.json.user.roles.join(',') !== 'user') throw new Error(`login for the signed-up account: ${login.status} ${login.text}`);

        // input validation happens server-side
        expectError(await api.postJson('/api/auth/signup', { email: 'not-an-email', password }), 400, { label: 'bad e-mail' });
        expectError(await api.postJson('/api/auth/signup', { email: `short.${Date.now()}@signup.test`, password: 'short' }), 400, { label: 'short password' });
        expectError(await api.postJson('/api/auth/signup', { email: `dup.${Date.now()}@signup.test` }), 400, { label: 'no password' });
      });
    },
  },
  {
    name: 'W20: password_hash holds salted scrypt records only, and a second start-up duplicates nothing',
    async fn({ root, testUrl }) {
      const dsn = scratchDsn(testUrl);
      const scratch = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
      await withAdminDb(testUrl, async (admin) => {
        await admin.query(`drop database if exists "${scratch}" with (force)`);
        await admin.query(`create database "${scratch}"`);
      });
      const handle = startServer({ root, databaseUrl: dsn, env: seedEnv() });
      try {
        await handle.waitForPort();
        const db = new pg.Client(clientParams(dsn, scratch));
        await db.connect();
        try {
          const { createHash } = await import('node:crypto');
          const { rows } = await db.query('select email, password_hash from public.app_users where email = any($1::text[])', [[ADMIN.email, STAFF.email]]);
          if (rows.length !== 2) throw new Error(`expected both seeded accounts, got ${JSON.stringify(rows.map((r) => r.email))}`);
          const hashes = new Set();
          const salts = new Set();
          for (const row of rows) {
            const stored = row.password_hash;
            if (!/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/.test(stored)) {
              throw new Error(`${row.email}: password_hash is not the scrypt record: ${stored}`);
            }
            const password = row.email === ADMIN.email ? ADMIN.password : STAFF.password;
            if (stored === password || stored.includes(password)) throw new Error(`${row.email}: the plaintext landed in password_hash`);
            for (const algo of ['md5', 'sha1', 'sha256', 'sha512']) {
              const digest = createHash(algo).update(password, 'utf8');
              for (const encoding of ['hex', 'base64']) {
                const form = digest.copy().digest(encoding);
                if (stored.includes(form)) throw new Error(`${row.email}: a bare ${algo}/${encoding} digest is embedded in password_hash`);
              }
            }
            salts.add(stored.split('$')[4]);
            hashes.add(stored);
          }
          if (hashes.size !== 2) throw new Error('both seeded accounts share a password_hash');
          if (salts.size !== 2) throw new Error('both seeded accounts share a salt');
        } finally {
          await db.end();
        }
      } finally {
        await handle.stop();
      }

      // start the server AGAIN against the same database (W20's literal check):
      // the seed re-runs, duplicates nothing, and the accounts still sign in.
      const second = startServer({ root, databaseUrl: dsn, env: seedEnv() });
      try {
        await second.waitForPort();
        const r = await request(second.port, '/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(ADMIN),
        });
        if (r.status !== 200) throw new Error(`login after the second start-up -> ${r.status}: ${r.text}`);
        const db = new pg.Client(clientParams(dsn, scratch));
        await db.connect();
        try {
          const counts = await db.query(
            `select (select count(*) from public.app_users)::int as users,
                    (select count(*) from public.user_roles)::int as roles,
                    (select count(*) from public.app_users where email = any($1::text[]))::int as seeds`,
            [[ADMIN.email, STAFF.email]]
          );
          const { users, roles, seeds } = counts.rows[0];
          if (seeds !== 2 || users !== 2 || roles !== 2) {
            throw new Error(`two start-ups produced ${users} users / ${roles} role rows (want 2/2, no duplicates)`);
          }
        } finally {
          await db.end();
        }
        if (!/already present/.test(second.log())) {
          throw new Error(`the second start-up's seed line is not idempotent chatter:\n${second.log()}`);
        }
      } finally {
        await second.stop();
        try {
          await withAdminDb(testUrl, (admin) => admin.query(`drop database if exists "${scratch}" with (force)`));
        } catch {
          /* best effort */
        }
      }
    },
  },
  {
    name: 'S32: POST /api/auth/admin/users is admin-only, and the account it creates works',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const adminToken = await api.adminToken();
        const asAdmin = (body) => api.postJson('/api/auth/admin/users', body, { headers: { authorization: `Bearer ${adminToken}` } });
        const email = `t5-admin-created-${Date.now()}@admin-users.test`;
        const password = 'Adm1n-Created!pw';

        const r = await asAdmin({ email, password });
        if (r.status !== 200) throw new Error(`admin create -> ${r.status}: ${r.text}`);
        if (r.json?.roles?.join(',') !== 'user' || r.json?.user?.email !== email) throw new Error(`create body: ${r.text}`);

        // the created account can sign in with role 'user'
        const login = await api.login(email, password);
        if (login.status !== 200 || login.json.user.roles.join(',') !== 'user') throw new Error(`login for the created account: ${login.status} ${login.text}`);

        // an admin can also grant admin (and only the enum values)
        const admin2 = await asAdmin({ email: `t5-boss-${Date.now()}@admin-users.test`, password, role: 'admin' });
        if (admin2.status !== 200 || admin2.json.roles.join(',') !== 'admin') throw new Error(`grant admin: ${admin2.status} ${admin2.text}`);
        const bogus = await asAdmin({ email: `t5-wizard-${Date.now()}@admin-users.test`, password, role: 'wizard' });
        expectError(bogus, 400, { label: 'role outside the enum' });
        const dupe = await asAdmin({ email, password });
        expectError(dupe, 409, { label: 'admin create with a taken e-mail' });

        // a staff (user-role) caller is 403 FORBIDDEN: the UI guard exists
        // server-side now, so calling the endpoint directly changes nothing (S32)
        const staffLogin = await api.login(STAFF.email, STAFF.password);
        const staffToken = staffLogin.json.access_token;
        const forbidden = await request(api.port, '/api/auth/admin/users', {
          method: 'POST',
          headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email: `t5-sneaky-${Date.now()}@admin-users.test`, password }),
        });
        expectError(forbidden, 403, { label: 'staff calling admin create', code: 'FORBIDDEN' });

        // no session at all is 401 before anything else
        const anon = await api.postJson('/api/auth/admin/users', { email: `t5-anon-${Date.now()}@admin-users.test`, password });
        expectError(anon, 401, { label: 'anonymous admin create' });
      });
    },
  },
  {
    name: 'logout clears the cookie, and cookie-only mutations must send JSON (the CSRF rule)',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const login = await api.login();
        const cookie = cookieValue(login, 'hh_token');

        const logout = await request(api.port, '/api/auth/logout', {
          method: 'POST',
          headers: { cookie: `hh_token=${cookie.value}`, 'content-type': 'application/json' },
          body: '{}',
        });
        if (logout.status !== 200) throw new Error(`logout -> ${logout.status}: ${logout.text}`);
        const cleared = cookieValue(logout, 'hh_token');
        if (!cleared || cleared.value !== '' || !/max-age=0/i.test(cleared.header)) {
          throw new Error(`logout must expire the cookie, set: ${cleared?.header}`);
        }

        // a cookie-authenticated POST without application/json is refused:
        // that is exactly what a cross-site <form> would look like
        const forged = await request(api.port, '/api/auth/logout', {
          method: 'POST',
          headers: { cookie: `hh_token=${cookie.value}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'x=1',
        });
        expectError(forged, 403, { label: 'cookie POST without JSON', code: 'CSRF' });

        // with no session the guard has nothing to protect, and logout is harmless
        const anon = await request(api.port, '/api/auth/logout', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'x=1',
        });
        if (anon.status !== 200) throw new Error(`anonymous logout -> ${anon.status}: ${anon.text}`);
      });
    },
  },
  {
    name: 'CORS on the auth routes: a preflight echoes the allow-listed origin, never "*"',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl }, async (api) => {
        const pre = await request(api.port, '/api/auth/login', { method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN } });
        if (pre.status !== 204) throw new Error(`preflight -> ${pre.status}`);
        if (pre.headers['access-control-allow-origin'] !== ALLOWED_ORIGIN) {
          throw new Error(`preflight echoed ${pre.headers['access-control-allow-origin']}, want ${ALLOWED_ORIGIN}`);
        }
        const headers = String(pre.headers['access-control-allow-headers'] ?? '').toLowerCase();
        for (const needed of ['authorization', 'content-type']) {
          if (!headers.includes(needed)) throw new Error(`Allow-Headers missing ${needed}: ${headers}`);
        }
        const denied = await request(api.port, '/api/auth/login', { method: 'OPTIONS', headers: { origin: 'http://t5-foreign.invalid' } });
        if (denied.headers['access-control-allow-origin'] != null) throw new Error(`a foreign origin got Allow-Origin: ${denied.headers['access-control-allow-origin']}`);
        for (const r of [pre, denied]) {
          if ((r.headers['access-control-allow-origin'] ?? null) === '*') throw new Error('CORS says "*"');
        }
      });
    },
  },
];
