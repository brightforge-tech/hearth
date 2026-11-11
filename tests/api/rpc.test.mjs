// tests/api/rpc.test.mjs — POST /api/rpc/<name>: the RPC route for
// get_users_with_roles (task t6, milestone-2 criterion W17).
//
// The route's whole point is who may reach the admin user list once this is
// self-hosted, so every case is run the way the operator runs it: a real
// `node api/server.mjs --port <n>` against a real PostgreSQL, called over real
// HTTP, with the accounts that list is supposed to describe created in that
// database. Each case gets a scratch database of its own, migrated by the
// server's own start-up, and drops it again afterwards.
//
// What is pinned:
//   * a request without a session is 401 and the SQL never runs (S27/S32);
//   * an admin session gets one row per app_users row, with the ported columns
//     and the function's own ordering and 'No role assigned' text;
//   * a staff session gets 403 + error JSON and no rows — the raise inside
//     get_users_with_roles, driven by `set local app.uid` in withUser();
//   * a roleless account is refused by the session layer (403 NO_ROLE) before
//     the function is called;
//   * an unknown name is a 404 with the error envelope and runs nothing,
//     including the names that would be found on Object.prototype;
//   * roles are read per request, so a demotion bites on the next call;
//   * CORS never says '*' on this route.

import pg from 'pg';

import { signToken } from '../../api/lib/tokens.mjs';
import { request, startServer } from '../helpers/server.mjs';

const SCRATCH = '_t6';
const JWT_SECRET = 't6-rpc-suite-secret-0123456789abcdef';
const ALLOWED_ORIGIN = 'http://localhost:8080';
const FOREIGN_ORIGIN = 'http://t6-rpc-foreign.invalid';
const NAME = 'get_users_with_roles';
const PATH = `/api/rpc/${NAME}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// withApi({root, testUrl, seed}, fn): a scratch database, a running API against
// it, and a committed fixture account set. `seed` maps an alias to a role
// ('admin' | 'user' | null) and an optional created_at, so a case can describe
// exactly the accounts the users panel would show. The database is dropped and
// recreated first (so the server's own start-up migrates it from scratch) and
// dropped again at the end.
async function withApi({ root, testUrl, seed = {} }, fn) {
  const dsn = scratchDsn(testUrl);
  const scratch = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  await withAdminDb(testUrl, async (admin) => {
    await admin.query(`drop database if exists "${scratch}" with (force)`);
    await admin.query(`create database "${scratch}"`);
  });

  const handle = startServer({ root, databaseUrl: dsn, env: { JWT_SECRET, ALLOWED_ORIGINS: ALLOWED_ORIGIN } });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();

    const users = {};
    for (const [alias, spec] of Object.entries(seed)) {
      const { role = null, created_at = null } = typeof spec === 'string' ? { role: spec } : (spec ?? {});
      const cols = ['email', 'password_hash'];
      const vals = [`${alias}@t6.test`, 'scrypt$t6$fixture$not-a-real-hash'];
      if (created_at) {
        cols.push('created_at');
        vals.push(created_at);
      }
      const inserted = await db.query(
        `insert into public.app_users (${cols.join(', ')}) values (${vals.map((_, i) => `$${i + 1}`).join(', ')}) returning id, email`,
        vals
      );
      const user = inserted.rows[0];
      if (role) await db.query('insert into public.user_roles (user_id, role) values ($1, $2)', [user.id, role]);
      users[alias] = { ...user, role };
    }

    const api = {
      db,
      users,
      port: handle.port,
      log: handle.log,
      call: (path, opts) => request(handle.port, path, opts),
      tokenFor: (user, opts = {}) => signToken({ sub: user.id, email: user.email }, { secret: JWT_SECRET, ...opts }),
      post: (path = PATH, token = null, extra = {}) =>
        request(handle.port, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
          body: '{}',
        }),
    };
    await fn(api);
  } finally {
    try {
      await db.end();
    } catch {
      /* the connection may already have gone with the server */
    }
    await handle.stop();
    try {
      await withAdminDb(testUrl, (admin) => admin.query(`drop database if exists "${scratch}" with (force)`));
    } catch {
      /* leaving a scratch database behind is not a test failure */
    }
  }
}

// The assertions every error answer on this route shares.
function expectError(r, status, code, { label = `${status}` } = {}) {
  if (r.status !== status) throw new Error(`${label}: expected ${status}, got ${r.status}: ${r.text}`);
  if (!/^application\/json/.test(r.headers['content-type'] ?? '')) {
    throw new Error(`${label}: content-type is ${r.headers['content-type']}: ${r.text}`);
  }
  if (typeof r.json?.error?.message !== 'string' || r.json.error.message === '') {
    throw new Error(`${label}: no message in the error envelope: ${r.text}`);
  }
  if (r.json.error.code !== code) throw new Error(`${label}: expected code ${code}, got ${JSON.stringify(r.json.error)}: ${r.text}`);
  // an error answer carries the envelope and nothing else — no rows, no data
  if (Array.isArray(r.json)) throw new Error(`${label}: an error answer must not be an array of rows: ${r.text}`);
  if (r.json.data !== undefined || r.json.rows !== undefined) throw new Error(`${label}: an error answer leaked rows: ${r.text}`);
}

const noWildcard = (r, label) => {
  if ((r.headers['access-control-allow-origin'] ?? null) === '*') throw new Error(`${label}: CORS says '*'`);
};

export default [
  {
    name: 'POST /api/rpc/get_users_with_roles with no session is 401, and the SQL never runs',
    async fn({ root, testUrl }) {
      // an empty database: if the function ran, its own admin check would raise
      // 'Access denied' and the caller would see 403. 401 proves requireAuth
      // answered first, which is the point (S27: nothing reachable by anyone).
      await withApi({ root, testUrl }, async (api) => {
        const r = await api.post();
        expectError(r, 401, 'UNAUTHORIZED', { label: 'no session' });
        if (/access denied/i.test(r.json.error.message)) {
          throw new Error(`the 401 carries the SQL function's message, so the SQL ran first: ${r.text}`);
        }
        // the same for a name that is not even on the allow-list: no session,
        // no information about which names exist
        const unknown = await api.post('/api/rpc/whatever');
        expectError(unknown, 401, 'UNAUTHORIZED', { label: 'no session, unknown name' });
        // ...and for the verbs that are not POST: the group asks for a session
        const get = await request(api.port, PATH);
        expectError(get, 401, 'UNAUTHORIZED', { label: 'GET with no session' });
        noWildcard(r, 'no session');
      });
    },
  },
  {
    name: 'with an admin token it returns one row per app_users row with the ported columns',
    async fn({ root, testUrl }) {
      await withApi(
        {
          root,
          testUrl,
          seed: {
            // three accounts, deliberately in a fixed created_at order so the
            // function's `order by created_at desc` is observable
            boss: { role: 'admin', created_at: '2026-01-01T00:00:00Z' },
            nurse: { role: 'user', created_at: '2026-01-02T00:00:00Z' },
            ghost: { role: null, created_at: '2026-01-03T00:00:00Z' },
          },
        },
        async (api) => {
          const token = api.tokenFor(api.users.boss);
          const r = await api.post(PATH, token);
          if (r.status !== 200) throw new Error(`admin token -> ${r.status}: ${r.text}`);
          if (!/^application\/json/.test(r.headers['content-type'] ?? '')) throw new Error(`content-type ${r.headers['content-type']}`);
          if (!Array.isArray(r.json)) throw new Error(`the body must be the rows as a JSON array: ${r.text}`);
          if (r.json.length !== 3) throw new Error(`expected one row per app_users row (3), got ${r.json.length}: ${r.text}`);

          const byEmail = Object.fromEntries(r.json.map((row) => [row.email, row]));
          for (const alias of ['boss', 'nurse', 'ghost']) {
            const row = byEmail[`${alias}@t6.test`];
            if (!row) throw new Error(`${alias}@t6.test is missing from ${JSON.stringify(r.json)}`);
            const keys = Object.keys(row).sort();
            if (keys.join(',') !== 'created_at,email,role,user_id') throw new Error(`${alias} has keys ${keys.join(',')}`);
            if (row.user_id !== api.users[alias].id) throw new Error(`${alias}: user_id ${row.user_id} is not the account's id`);
            if (!UUID_RE.test(row.user_id)) throw new Error(`${alias}: user_id ${row.user_id} is not a uuid`);
            if (typeof row.created_at !== 'string' || Number.isNaN(Date.parse(row.created_at))) {
              throw new Error(`${alias}: created_at must be the function's text column, got ${JSON.stringify(row.created_at)}`);
            }
          }
          // the roles, and the 'No role assigned' text the page renders
          if (byEmail['boss@t6.test'].role !== 'admin') throw new Error(`admin row role: ${byEmail['boss@t6.test'].role}`);
          if (byEmail['nurse@t6.test'].role !== 'user') throw new Error(`staff row role: ${byEmail['nurse@t6.test'].role}`);
          if (byEmail['ghost@t6.test'].role !== 'No role assigned') throw new Error(`roleless row: ${byEmail['ghost@t6.test'].role}`);
          // and the function's own ordering: newest account first
          if (r.json.map((row) => row.email).join(',') !== 'ghost@t6.test,nurse@t6.test,boss@t6.test') {
            throw new Error(`created_at desc ordering is not preserved: ${r.json.map((row) => row.created_at).join(' | ')}`);
          }

          // the cookie the scripted login sets is accepted where the header is
          const viaCookie = await api.post(PATH, null, { cookie: `hh_token=${token}` });
          if (viaCookie.status !== 200 || JSON.stringify(viaCookie.json) !== JSON.stringify(r.json)) {
            throw new Error(`the session cookie is not accepted: ${viaCookie.status} ${viaCookie.text}`);
          }
          // a token whose user is the caller: the list is the caller's, so a
          // second admin sees the same rows
          const again = await api.post(PATH, token);
          if (JSON.stringify(again.json) !== JSON.stringify(r.json)) throw new Error('the same call answered differently');
        }
      );
    },
  },
  {
    name: 'a staff session is 403 with the error JSON and no rows, a roleless account is 403 NO_ROLE',
    async fn({ root, testUrl }) {
      await withApi(
        {
          root,
          testUrl,
          seed: { boss: 'admin', nurse: 'user', ghost: null },
        },
        async (api) => {
          // the 'user' role is a real session: the request reaches the function,
          // which raises for a non-admin through public.current_uid()
          const staff = await api.post(PATH, api.tokenFor(api.users.nurse));
          expectError(staff, 403, 'FORBIDDEN', { label: 'staff token' });
          if (!/access denied/i.test(staff.json.error.message)) {
            throw new Error(`the 403 should carry the function's own message, got ${JSON.stringify(staff.json.error)}`);
          }
          noWildcard(staff, 'staff token');

          // an account with no role at all never reaches the function: the
          // session layer answers, which is a different code and message
          const roleless = await api.post(PATH, api.tokenFor(api.users.ghost));
          expectError(roleless, 403, 'NO_ROLE', { label: 'roleless account' });
          if (/access denied/i.test(roleless.json.error.message)) {
            throw new Error(`a roleless account should be refused before the RPC, got ${roleless.text}`);
          }

          // and the admin's own rows are not disclosed to either of them
          const list = await api.db.query('select email from public.app_users order by email');
          const leaked = list.rows.map((row) => row.email).filter((email) => staff.text.includes(email) || roleless.text.includes(email));
          if (leaked.length) throw new Error(`a refused answer leaked account e-mails: ${leaked.join(', ')}`);
        }
      );
    },
  },
  {
    name: 'an unknown RPC name is a 404 with the error envelope, and nothing runs',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin' } }, async (api) => {
        const token = api.tokenFor(api.users.boss);
        // names that differ by one letter, by case, by SQL punctuation, and the
        // members of Object.prototype that a plain object allow-list would hand
        // to a caller; plus a name that is SQL text, which must never reach SQL.
        const names = [
          'get_users_with_role', // the typo the page would make
          'GET_USERS_WITH_ROLES',
          'get_users_with_roles()',
          'get_users_with_roles;drop table app_users',
          'select 1',
          'constructor',
          '__proto__',
          'toString',
          'hasOwnProperty',
        ];
        for (const name of names) {
          const r = await api.post(`/api/rpc/${encodeURIComponent(name)}`, token);
          expectError(r, 404, 'NOT_FOUND', { label: `POST /api/rpc/${name}` });
        }
        // the deny must not have run anything either: the accounts are intact
        const count = await api.db.query('select count(*)::int n from public.app_users');
        if (count.rows[0].n !== 1) throw new Error(`the schema changed under the 404s: ${count.rows[0].n} app_users rows`);
        const stillWorks = await api.post(PATH, token);
        if (stillWorks.status !== 200 || stillWorks.json.length !== 1) throw new Error(`the real RPC is broken after the 404s: ${stillWorks.status} ${stillWorks.text}`);

        // a missing name entirely (POST /api/rpc/) is not the RPC route either
        const empty = await api.post('/api/rpc/', token);
        expectError(empty, 404, 'NOT_FOUND', { label: 'POST /api/rpc/' });
      });
    },
  },
  {
    name: 'a forged signature, an expired token, a bad subject or a deleted account is 401, never 403',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin' } }, async (api) => {
        const forged = api.tokenFor(api.users.boss, { secret: 'some-other-issuer-secret-000000' });
        const expired = api.tokenFor(api.users.boss, { now: Math.floor(Date.now() / 1000) - 24 * 3600 });
        const notAUser = api.tokenFor({ id: '22222222-2222-2222-2222-222222222222', email: 'nobody@t6.test' });
        const badSubject = signToken({ sub: 'not-a-uuid', email: 'x@t6.test' }, { secret: JWT_SECRET });

        const attempts = [
          ['foreign signature', forged],
          ['expired token', expired],
          ['an account that does not exist', notAUser],
          ['a subject that is not a uuid', badSubject],
        ];
        for (const [what, token] of attempts) {
          const r = await api.post(PATH, token);
          expectError(r, 401, 'UNAUTHORIZED', { label: what });
          noWildcard(r, what);
        }

        // an account deleted mid-flight stops working immediately, even though
        // its token has not expired
        const gone = await api.db.query('delete from public.app_users where id = $1 returning id', [api.users.boss.id]);
        if (gone.rowCount !== 1) throw new Error('the fixture account was not deleted');
        const deleted = await api.post(PATH, api.tokenFor(api.users.boss));
        expectError(deleted, 401, 'UNAUTHORIZED', { label: 'deleted account' });
        if (!/longer exists|no longer/i.test(deleted.json.error.message)) {
          throw new Error(`the 401 should say the account is gone: ${deleted.text}`);
        }
      });
    },
  },
  {
    name: 'roles are read from the database on every request: a demoted admin is refused at once',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin' } }, async (api) => {
        const token = api.tokenFor(api.users.boss); // one token for the whole case
        const first = await api.post(PATH, token);
        if (first.status !== 200) throw new Error(`an admin session -> ${first.status}: ${first.text}`);

        await api.db.query('update public.user_roles set role = $2 where user_id = $1', [api.users.boss.id, 'user']);
        const demoted = await api.post(PATH, token);
        expectError(demoted, 403, 'FORBIDDEN', { label: 'the same token after being demoted' });

        // ...and the other way round: a promotion works without a new token,
        // because the roles are the database's, not the token's
        await api.db.query('update public.user_roles set role = $2 where user_id = $1', [api.users.boss.id, 'admin']);
        const restored = await api.post(PATH, token);
        if (restored.status !== 200) throw new Error(`the same token after being restored -> ${restored.status}: ${restored.text}`);

        // with no role left at all the session layer stops it (403 NO_ROLE)
        await api.db.query('delete from public.user_roles where user_id = $1', [api.users.boss.id]);
        const stripped = await api.post(PATH, token);
        expectError(stripped, 403, 'NO_ROLE', { label: 'the same token with no role' });
      });
    },
  },
  {
    name: 'CORS on the RPC route: never "*", the allow-listed origin comes back verbatim, others get nothing',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin' } }, async (api) => {
        const token = api.tokenFor(api.users.boss);

        const pre = await request(api.port, PATH, { method: 'OPTIONS', headers: { origin: ALLOWED_ORIGIN } });
        if (pre.status !== 204) throw new Error(`preflight -> ${pre.status}: ${pre.text}`);
        if (pre.headers['access-control-allow-origin'] !== ALLOWED_ORIGIN) {
          throw new Error(`preflight echoed ${pre.headers['access-control-allow-origin']}, want ${ALLOWED_ORIGIN}`);
        }
        const headers = (pre.headers['access-control-allow-headers'] ?? '').toLowerCase();
        for (const needed of ['authorization', 'content-type']) {
          if (!headers.includes(needed)) throw new Error(`Allow-Headers is missing ${needed}: ${headers}`);
        }
        noWildcard(pre, 'preflight');

        const foreignPre = await request(api.port, PATH, { method: 'OPTIONS', headers: { origin: FOREIGN_ORIGIN } });
        if (foreignPre.headers['access-control-allow-origin'] !== undefined && foreignPre.headers['access-control-allow-origin'] !== null) {
          throw new Error(`a foreign origin got Allow-Origin: ${foreignPre.headers['access-control-allow-origin']}`);
        }

        // the answer a caller actually gets: 401 and 200 both carry the caller's
        // origin verbatim, and never a wildcard
        const unauthenticated = await api.post(PATH, null, { origin: ALLOWED_ORIGIN });
        if (unauthenticated.status !== 401) throw new Error(`no session -> ${unauthenticated.status}`);
        if (unauthenticated.headers['access-control-allow-origin'] !== ALLOWED_ORIGIN) {
          throw new Error(`401 echoed ${unauthenticated.headers['access-control-allow-origin']}`);
        }
        const ok = await api.post(PATH, token, { origin: ALLOWED_ORIGIN });
        if (ok.status !== 200) throw new Error(`admin token -> ${ok.status}: ${ok.text}`);
        if (ok.headers['access-control-allow-origin'] !== ALLOWED_ORIGIN) {
          throw new Error(`200 echoed ${ok.headers['access-control-allow-origin']}`);
        }
        if (ok.headers['access-control-allow-credentials'] !== 'true') throw new Error('the session cookie needs Allow-Credentials');

        // and an origin outside ALLOWED_ORIGINS is simply not answered
        const denied = await api.post(PATH, token, { origin: FOREIGN_ORIGIN });
        if (denied.status !== 200) throw new Error(`a same-server call from a foreign origin -> ${denied.status}`);
        if (denied.headers['access-control-allow-origin'] !== undefined && denied.headers['access-control-allow-origin'] !== null) {
          throw new Error(`a foreign origin got Allow-Origin on the rows: ${denied.headers['access-control-allow-origin']}`);
        }
        for (const r of [pre, foreignPre, unauthenticated, ok, denied]) noWildcard(r, 'a CORS answer');
      });
    },
  },
];
