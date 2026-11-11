// tests/api/seed.test.mjs — api/lib/seed.mjs (task t5, criterion W20's
// "seeded accounts are recreated without duplication when the server starts
// twice", plus the account/role contract W14/W17 depend on).
//
// The runner executes every case inside a transaction it rolls back, so the
// shared test database stays clean; seedAccounts is handed exactly the
// query(sql, params) function api/server.mjs hands it, bound to that client.
// The end-to-end variant — the real start-up seeding inside a spawned server
// process — is proven in tests/api/auth.test.mjs.

import { verifyPassword } from '../../api/lib/passwords.mjs';
import { DEFAULT_SEED_ACCOUNTS, seedAccounts, seedAccountsEnabled } from '../../api/lib/seed.mjs';

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'Admin#2025test';
const STAFF_EMAIL = 'staff@example.test';

function boundQuery(client) {
  return (sql, params) => client.query(sql, params);
}

async function roleOf(client, email) {
  const { rows } = await client.query(
    `select r.role::text as role
       from public.app_users u
       join public.user_roles r on r.user_id = u.id
      where u.email = $1`,
    [email]
  );
  return rows.map((row) => row.role).sort();
}

async function accountCount(client, email) {
  const { rows } = await client.query('select count(*)::int as n from public.app_users where email = $1', [email]);
  return rows[0].n;
}

export default [
  {
    name: 'a first run seeds the admin and staff accounts with their roles and scrypt hashes',
    async fn({ client }) {
      const summary = await seedAccounts({ env: {}, log: () => {}, query: boundQuery(client) });
      if (typeof summary !== 'string' || !/2 created/.test(summary)) throw new Error(`summary: ${summary}`);

      for (const spec of DEFAULT_SEED_ACCOUNTS) {
        const { rows } = await client.query('select id, email, password_hash from public.app_users where email = $1', [spec.email]);
        if (rows.length !== 1) throw new Error(`${spec.email}: ${rows.length} rows, expected 1`);
        const hash = rows[0].password_hash;
        if (!/^scrypt\$/.test(hash)) throw new Error(`${spec.email}: password_hash is not a scrypt record: ${hash}`);
        if (hash === spec.password || hash.includes(spec.password)) {
          throw new Error(`${spec.email}: the password itself landed in password_hash`);
        }
        if (!(await verifyPassword(spec.password, hash))) throw new Error(`${spec.email}: the seeded password does not verify against the stored hash`);
      }
      if ((await roleOf(client, ADMIN_EMAIL)).join(',') !== 'admin') throw new Error('the admin account must hold exactly role admin');
      if ((await roleOf(client, STAFF_EMAIL)).join(',') !== 'user') throw new Error('the staff account must hold exactly role user');

      // and the settings singleton is present whatever route the migration took
      const settings = await client.query('select count(*)::int as n from public.clinic_settings where singleton = true');
      if (settings.rows[0].n !== 1) throw new Error(`clinic_settings singleton count: ${settings.rows[0].n}`);
    },
  },
  {
    name: 'a second run changes nothing: no duplicate rows, and no rotation of an existing hash',
    async fn({ client }) {
      const query = boundQuery(client);
      await seedAccounts({ env: {}, log: () => {}, query });
      const { rows } = await client.query('select email, password_hash from public.app_users order by email');
      const second = await seedAccounts({ env: {}, log: () => {}, query });
      if (!/already present/.test(String(second))) throw new Error(`second-run summary: ${second}`);

      const after = await client.query('select email, password_hash from public.app_users order by email');
      if (JSON.stringify(after.rows) !== JSON.stringify(rows)) {
        throw new Error('the second run rewrote or duplicated account rows — W20 says it must be a no-op');
      }
      for (const email of [ADMIN_EMAIL, STAFF_EMAIL]) {
        if (await accountCount(client, email) !== 1) throw new Error(`${email}: ${await accountCount(client, email)} rows after two runs`);
        if ((await roleOf(client, email)).length !== 1) throw new Error(`${email}: duplicate role grants after two runs`);
      }
    },
  },
  {
    name: 'an account the operator already created keeps its own hash; the seed only adds the missing role',
    async fn({ client }) {
      const query = boundQuery(client);
      const mine = await client.query(
        'insert into public.app_users (email, password_hash) values ($1, $2) returning id',
        [ADMIN_EMAIL, 'scrypt$16384$8$1$b3BlcmF0b3Itc2FsdA==$b3BlcmF0b3ItaGFzaA==']
      );
      await seedAccounts({ env: {}, log: () => {}, query });
      const { rows } = await client.query('select password_hash from public.app_users where id = $1', [mine.rows[0].id]);
      if (rows[0].password_hash !== 'scrypt$16384$8$1$b3BlcmF0b3Itc2FsdA==$b3BlcmF0b3ItaGFzaA==') {
        throw new Error('the seed overwrote a password the operator had set');
      }
      if ((await roleOf(client, ADMIN_EMAIL)).join(',') !== 'admin') throw new Error('the missing admin role grant was not added');
    },
  },
  {
    name: 'SEED_ADMIN_* / SEED_STAFF_* change which accounts are created',
    async fn({ client }) {
      const env = {
        SEED_ADMIN_EMAIL: 'Owner@Clinic.Example',
        SEED_ADMIN_PASSWORD: 'Own3r-Str0ng!pw',
        SEED_STAFF_EMAIL: 'front.desk@clinic.example',
        SEED_STAFF_PASSWORD: 'Fr0nt-Desk-2025!',
      };
      await seedAccounts({ env, log: () => {}, query: boundQuery(client) });
      // e-mails are normalised to lower case so login cannot miss them
      if ((await accountCount(client, 'owner@clinic.example')) !== 1) throw new Error('the custom admin was not seeded (lower-cased)');
      if ((await roleOf(client, 'owner@clinic.example')).join(',') !== 'admin') throw new Error('the custom admin lacks role admin');
      if ((await roleOf(client, 'front.desk@clinic.example')).join(',') !== 'user') throw new Error('the custom staff lacks role user');
      if (await accountCount(client, ADMIN_EMAIL)) throw new Error('the default admin was seeded despite SEED_ADMIN_EMAIL');
    },
  },
  {
    name: 'SEED_ACCOUNTS=0 switches the whole step off',
    async fn({ client }) {
      if (!seedAccountsEnabled({}) || !seedAccountsEnabled({ SEED_ACCOUNTS: '1' })) throw new Error('seeding must be on by default');
      for (const off of ['0', 'false', 'FALSE', ' off ', 'no']) {
        if (seedAccountsEnabled({ SEED_ACCOUNTS: off })) throw new Error(`SEED_ACCOUNTS=${JSON.stringify(off)} must disable seeding`);
      }
      const summary = await seedAccounts({ env: { SEED_ACCOUNTS: '0' }, log: () => {}, query: boundQuery(client) });
      if (!/disabled/.test(String(summary))) throw new Error(`summary: ${summary}`);
      const { rows } = await client.query('select count(*)::int as n from public.app_users');
      if (rows[0].n !== 0) throw new Error(`a disabled seed still created ${rows[0].n} accounts`);
    },
  },
  {
    name: 'seedAccounts is what api/server.mjs\'s start-up hook finds and calls',
    async fn() {
      // The hook (api/server.mjs seedAccounts()) resolves the module as
      // mod.seedAccounts ?? mod.seed ?? mod.default and calls it with
      // {env, log, query}. Both names must be that same function, and calling
      // it without a query must fail loudly instead of silently no-op'ing.
      const mod = await import('../../api/lib/seed.mjs');
      const resolved = mod.seedAccounts ?? mod.seed ?? (typeof mod.default === 'function' ? mod.default : null);
      if (typeof resolved !== 'function') throw new Error('the start-up hook cannot resolve a seed function');
      if (resolved !== mod.seedAccounts || resolved !== mod.default) throw new Error('the hook would call a different function than the named export');
      let thrown = null;
      try {
        await resolved({ env: {}, log: () => {} });
      } catch (e) {
        thrown = e;
      }
      if (!thrown) throw new Error('a missing query must throw, not seed nothing in silence');
    },
  },
];
