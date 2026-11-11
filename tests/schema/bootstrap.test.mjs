// tests/schema/bootstrap.test.mjs — the database bootstrap and migration
// runner added in task t3: scripts/db-init.mjs, scripts/migrate.mjs and
// api/db.mjs (query/tx/withUser/close).
//
// Everything here works on a dedicated scratch database (<test db>_t3) next
// to the one run.mjs resets, so the shared test database and the other suites
// are never touched. The scratch database is dropped and recreated at the
// start, which is what makes a second identical run pass identically.

import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

import { runInit, assertServerVersion, VERSION_MESSAGE } from '../../scripts/db-init.mjs';
import { runMigrations, listMigrations } from '../../scripts/migrate.mjs';
import { parseDbConfig } from '../../api/db.mjs';
import * as db from '../../api/db.mjs';

const IDENT = /^[a-z_][a-z0-9_$]*$/i;

// URL of the same cluster with a different database.
function swapDb(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

function adminUrl(testUrl) {
  return swapDb(testUrl, 'postgres');
}

function adminClient(testUrl) {
  const client = new pg.Client(parseDbConfig({ DATABASE_URL: adminUrl(testUrl) }));
  return client.connect().then(() => client);
}

// Runs scripts/<name> with DATABASE_URL pointed at `dsn` (like npm run does).
function runScript(root, name, dsn) {
  const r = spawnSync(process.execPath, [join(root, 'scripts', name)], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: dsn },
    timeout: 120_000,
  });
  return r;
}

function mustSucceed(r, what) {
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) throw new Error(`${what} did not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${what} exited ${r.status}:\n${out}`);
  return out;
}

async function scratchNames(client, db) {
  const t = await client.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_name = any($1)`,
    [db]
  );
  const got = t.rows.map((x) => x.table_name);
  const missing = db.filter((x) => !got.includes(x));
  if (missing.length) throw new Error(`missing tables in the scratch database: ${missing.join(', ')}`);
}

export default [
  {
    name: 'db-init refuses a server below PostgreSQL 13 and creates nothing',
    async fn() {
      // The <13 gate is exercised with an injected maintenance connection:
      // it records every statement, so "creates nothing" is proven, not assumed.
      const calls = [];
      const fake = {
        async query(sql) {
          calls.push(sql);
          if (/server_version_num/.test(sql)) {
            return { rows: [{ version: '11.22', num: 110022 }], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        },
        async end() {
          calls.push('--end--');
        },
      };
      let caught = null;
      try {
        await runInit({ config: {}, database: 'hearth', openAdmin: async () => fake });
      } catch (e) {
        caught = e;
      }
      if (!caught || caught.message !== VERSION_MESSAGE) {
        throw new Error(`expected ${JSON.stringify(VERSION_MESSAGE)}, got ${caught?.message ?? 'no throw'}`);
      }
      if (caught.code !== 'PG_TOO_OLD') throw new Error(`expected code PG_TOO_OLD, got ${caught.code}`);
      if (calls.some((c) => /pg_database|create database/i.test(c)))
        throw new Error(`old-server run touched databases: ${calls.join(' | ')}`);
      if (!calls.some((c) => c === '--end--')) throw new Error('the maintenance connection was not closed');
      assertServerVersion(130000); // the first supported version passes
      assertServerVersion(160003);
      let threw = false;
      try {
        assertServerVersion(129999);
      } catch (e) {
        threw = e.message === VERSION_MESSAGE;
      }
      if (!threw) throw new Error('129999 must be refused');
    },
  },
  {
    name: 'parseDbConfig prefers DATABASE_URL, falls back to PG*, then to the documented defaults',
    async fn() {
      const a = parseDbConfig({ DATABASE_URL: 'postgresql://alice:s3cret@db.example:6543/clinic' });
      if (a.host !== 'db.example' || a.port !== 6543 || a.user !== 'alice' || a.password !== 's3cret' || a.database !== 'clinic')
        throw new Error(`DATABASE_URL parsed wrong: ${JSON.stringify(a)}`);
      // DATABASE_URL wins over conflicting PG* values
      const b = parseDbConfig({
        DATABASE_URL: 'postgresql://bob@h2:1/db2',
        PGHOST: 'ignored',
        PGPORT: '2',
        PGDATABASE: 'ignored',
        PGUSER: 'ignored',
      });
      if (b.host !== 'h2' || b.port !== 1 || b.user !== 'bob' || b.database !== 'db2')
        throw new Error(`DATABASE_URL did not win: ${JSON.stringify(b)}`);
      const c = parseDbConfig({ PGHOST: 'pg', PGPORT: '5433', PGDATABASE: 'ph', PGUSER: 'u', PGPASSWORD: 'p' });
      if (c.host !== 'pg' || c.port !== 5433 || c.database !== 'ph' || c.user !== 'u' || c.password !== 'p')
        throw new Error(`PG* fallback parsed wrong: ${JSON.stringify(c)}`);
      const d = parseDbConfig({});
      if (d.host !== '127.0.0.1' || d.port !== 5432 || d.database !== 'hearth' || d.user !== 'postgres')
        throw new Error(`defaults wrong: ${JSON.stringify(d)}`);
      if (parseDbConfig({ DATABASE_URL: 'postgres://h/d' }).ssl !== undefined) throw new Error('ssl must stay unset');
      if (parseDbConfig({ DATABASE_URL: 'postgresql://h/d?sslmode=require' }).ssl !== true) throw new Error('sslmode=require');
      if (parseDbConfig({ DATABASE_URL: 'postgresql://h/d?sslmode=disable' }).ssl !== false) throw new Error('sslmode=disable');
      let threw = false;
      try {
        parseDbConfig({ DATABASE_URL: 'not a dsn' });
      } catch (e) {
        threw = e.code === 'BAD_DSN';
      }
      if (!threw) throw new Error('an unparseable DATABASE_URL must fail with BAD_DSN');
    },
  },
  {
    name: 'db:init creates a missing database, and a second run says it already exists',
    async fn({ root, testUrl }) {
      const dbName = `${decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''))}_t3`;
      if (!IDENT.test(dbName)) throw new Error(`unexpected scratch name ${dbName}`);
      const dsn = swapDb(testUrl, dbName);

      const admin = await adminClient(testUrl);
      try {
        await admin.query(`drop database if exists "${dbName}" with (force)`);
        let r = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
        if (r.rowCount) throw new Error(`scratch database ${dbName} could not be dropped`);

        // first run: creates it
        r = runScript(root, 'db-init.mjs', dsn);
        const out1 = mustSucceed(r, 'db:init (first run)');
        if (!out1.includes(`created database "${dbName}"`))
          throw new Error(`first run did not create the database:\n${out1}`);
        r = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
        if (!r.rowCount) throw new Error('db:init reported creating but pg_database has no such row');

        // second run: no-op, still exit 0
        r = runScript(root, 'db-init.mjs', dsn);
        const out2 = mustSucceed(r, 'db:init (second run)');
        if (!out2.includes('already exists'))
          throw new Error(`second run should report the database exists:\n${out2}`);
      } finally {
        await admin.end();
      }
    },
  },
  {
    name: 'db:init exits non-zero naming DATABASE_URL when the server is unreachable',
    async fn({ root }) {
      const r = runScript(root, 'db-init.mjs', 'postgresql://nobody@127.0.0.1:9/nothing_t3');
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.error) throw new Error(`db:init did not run: ${r.error.message}`);
      if (r.status === 0) throw new Error(`db:init should fail against an unreachable server:\n${out}`);
      if (!out.includes('DATABASE_URL'))
        throw new Error(`the failure message must name DATABASE_URL:\n${out}`);
    },
  },
  {
    name: 'db:migrate applies every migration in filename order, records them, and reports all seven applied',
    async fn({ root, testUrl }) {
      const dbName = `${decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''))}_t3`;
      const dsn = swapDb(testUrl, dbName);

      const r = runScript(root, 'migrate.mjs', dsn);
      const out = mustSucceed(r, 'db:migrate (first run)');
      const n = (out.match(/db:migrate: applied \S+\.sql/g) ?? []).length;
      const expected = listMigrations(join(root, 'db', 'migrations'));
      if (expected.length !== 7)
        throw new Error(`milestone 1 expects exactly 7 migrations, found ${expected.join(', ')}`);
      if (n !== expected.length || !new RegExp(`applied ${expected.length} new migration`).test(out))
        throw new Error(`expected ${expected.length} applied, summary was:\n${out}`);

      const client = new pg.Client(parseDbConfig({ DATABASE_URL: dsn }));
      try {
        await client.connect();
        const led = await client.query('select name from public.schema_migrations order by name');
        const names = led.rows.map((x) => x.name);
        if (names.join(',') !== expected.join(','))
          throw new Error(`schema_migrations holds ${names.join(', ')}`);
        // W2: after migration the runner's ledger sits beside the schema tables
        await scratchNames(client, [
          'clinic_settings', 'patients', 'appointments', 'visit_notes', 'services',
          'invoices', 'invoice_items', 'payments', 'app_users', 'user_roles',
          'storage_buckets', 'storage_objects', 'hh_outbox', 'schema_migrations',
        ]);
        const seeds = await client.query('select (select count(*) from clinic_settings)::int c, (select count(*) from services)::int s');
        if (seeds.rows[0].c !== 1 || seeds.rows[0].s !== 5)
          throw new Error(`seeds missing: ${JSON.stringify(seeds.rows[0])}`);
      } finally {
        await client.end();
      }
    },
  },
  {
    name: 'db:migrate a second time reports zero new migrations and changes nothing',
    async fn({ root, testUrl }) {
      const dbName = `${decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''))}_t3`;
      const dsn = swapDb(testUrl, dbName);

      const client = new pg.Client(parseDbConfig({ DATABASE_URL: dsn }));
      await client.connect();
      const before = await client.query(
        `select (select count(*) from schema_migrations)::int l,
                (select count(*) from services)::int s,
                (select count(*) from clinic_settings)::int c`
      );

      const r = runScript(root, 'migrate.mjs', dsn);
      const out = mustSucceed(r, 'db:migrate (second run)');
      if (!new RegExp('applied 0 new migration').test(out))
        throw new Error(`second run must report zero new migrations:\n${out}`);
      if (!new RegExp(`; ${before.rows[0].l} skipped`).test(out))
        throw new Error(`second run should skip every recorded file:\n${out}`);
      if (/db:migrate: applied \S+\.sql/.test(out))
        throw new Error(`second run applied a file:\n${out}`);

      const after = await client.query(
        `select (select count(*) from schema_migrations)::int l,
                (select count(*) from services)::int s,
                (select count(*) from clinic_settings)::int c`
      );
      await client.end();
      const [b, a] = before.rows.concat(after.rows);
      if (JSON.stringify(before.rows[0]) !== JSON.stringify(after.rows[0]))
        throw new Error(`state changed on the second run: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
    },
  },
  {
    name: 'a failing migration rolls back its own transaction and the ledger lets the repaired file continue',
    async fn({ root, testUrl }) {
      // Uses its own scratch database plus throwaway migration files in a temp
      // directory, so a deliberately failing SQL file never enters db/migrations.
      const dbName = `${decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''))}_t3x`;
      const config = parseDbConfig({ DATABASE_URL: swapDb(testUrl, dbName) });
      const admin = await adminClient(testUrl);
      const dir = join(tmpdir(), `hh-migtest-${process.pid}-${Date.now()}`);
      try {
        await admin.query(`create database "${dbName}"`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, '0001_ok.sql'), 'create table public.mig_probe (n int); insert into public.mig_probe values (1);');
        writeFileSync(join(dir, '0002_bad.sql'), "insert into public.mig_probe values (2); do $$ begin raise exception 'boom'; end $$;");
        writeFileSync(join(dir, '0003_next.sql'), 'insert into public.mig_probe values (3);');

        let caught = null;
        try {
          await runMigrations({ config, migrationsDir: dir, log: () => {} });
        } catch (e) {
          caught = e;
        }
        if (!caught || !/0002_bad\.sql failed/.test(caught.message))
          throw new Error(`expected 0002_bad.sql to fail the run, got ${caught?.message ?? 'no throw'}`);

        const probe = new pg.Client(config);
        await probe.connect();
        try {
          const rows = await probe.query('select n from public.mig_probe order by n');
          // 0001 kept (its own tx committed), 0002 rolled back (no row 2),
          // 0003 never ran.
          if (rows.rows.map((x) => x.n).join(',') !== '1')
            throw new Error(`after the failed run the probe table holds ${JSON.stringify(rows.rows)}`);
          const led = await probe.query('select name from public.schema_migrations order by name');
          if (led.rows.map((x) => x.name).join(',') !== '0001_ok.sql')
            throw new Error(`ledger should hold only 0001_ok.sql, got ${led.rows.map((x) => x.name).join(', ')}`);
        } finally {
          await probe.end();
        }

        // repair the file: the next run continues exactly where it stopped
        writeFileSync(join(dir, '0002_bad.sql'), 'insert into public.mig_probe values (2);');
        const again = await runMigrations({ config, migrationsDir: dir, log: () => {} });
        if (again.applied.join(',') !== '0002_bad.sql,0003_next.sql')
          throw new Error(`repaired run applied ${again.applied.join(', ')}`);
        if (again.skipped.join(',') !== '0001_ok.sql')
          throw new Error(`repaired run skipped ${again.skipped.join(', ')}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await admin.query(`drop database if exists "${dbName}" with (force)`);
        await admin.end();
      }
    },
  },
  {
    name: 'api/db.mjs query/tx/withUser/close work against the migrated database',
    async fn({ testUrl }) {
      const dbName = `${decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''))}_t3`;
      const dsn = swapDb(testUrl, dbName);
      // The pool is lazy and resolves the environment when first used, so
      // pointing it at the scratch database here is enough.
      const savedUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = dsn;
      try {
        const r = await db.query('select $1::int as n, current_uid() as uid', [7]);
        if (r.rows.length !== 1 || r.rows[0].n !== 7 || r.rowCount !== 1)
          throw new Error(`query() returned ${JSON.stringify(r.rows)}`);
        if (r.rows[0].uid !== null)
          throw new Error(`current_uid() on a fresh pool connection must be NULL, got ${r.rows[0].uid}`);

        const uidA = (await db.query('select gen_random_uuid() as id')).rows[0].id;
        const uidB = (await db.query('select gen_random_uuid() as id')).rows[0].id;

        await db.tx((c) =>
          c.query("insert into public.app_users (id, email, password_hash) values ($1, $2, 'x')", [
            uidA,
            'dbtx-commit@example.invalid',
          ])
        );

        let boom = null;
        try {
          await db.tx(async (c) => {
            await c.query("insert into public.app_users (id, email, password_hash) values ($1, $2, 'x')", [
              uidB,
              'dbtx-rollback@example.invalid',
            ]);
            throw new Error('boom');
          });
        } catch (e) {
          boom = e;
        }
        if (!boom || boom.message !== 'boom') throw new Error(`tx must rethrow, got ${boom}`);

        const kept = await db.query(
          'select id from public.app_users where id = any($1::uuid[])',
          [[uidA, uidB]]
        );
        if (kept.rows.length !== 1 || kept.rows[0].id !== uidA)
          throw new Error(`tx commit/rollback wrong: ${JSON.stringify(kept.rows)}`);

        // withUser: the app.uid GUC is visible inside the transaction...
        const inside = await db.withUser(uidA, (c) =>
          c.query('select current_uid() as uid, current_setting(\'app.uid\', true) as guc')
        );
        if (inside.rows[0].uid !== uidA || inside.rows[0].guc !== uidA)
          throw new Error(`withUser did not set app.uid: ${JSON.stringify(inside.rows[0])}`);
        // ...and is transaction-local again afterwards.
        const outside = await db.query('select current_uid() as uid');
        if (outside.rows[0].uid !== null)
          throw new Error(`app.uid leaked past the transaction: ${outside.rows[0].uid}`);

        // a non-uuid is refused before any SQL is built, so it cannot escape
        let refused = null;
        try {
          await db.withUser("1'; drop table public.app_users;--", () => {});
        } catch (e) {
          refused = e;
        }
        if (!refused || refused.code !== 'INVALID_UID')
          throw new Error(`withUser must refuse a non-uuid, got ${refused?.message ?? 'no throw'}`);
        const intact = await db.query('select count(*)::int as n from public.app_users');
        if (intact.rows[0].n < 1) throw new Error('app_users vanished — the injection reached the database');

        // get_users_with_roles through withUser (the API path the plan pins)
        await db.tx((c) =>
          c.query("insert into public.user_roles (user_id, role) values ($1, 'admin'::public.app_role)", [uidA])
        );
        const rpc = await db.withUser(uidA, (c) => c.query('select * from public.get_users_with_roles()'));
        if (!rpc.rows.some((row) => row.user_id === uidA && row.role === 'admin'))
          throw new Error(`get_users_with_roles via withUser did not show the admin: ${JSON.stringify(rpc.rows)}`);

        await db.tx((c) =>
          c.query('delete from public.app_users where id = any($1::uuid[])', [[uidA, uidB]])
        );

        await db.close();
        await db.close(); // idempotent
      } finally {
        await db.close().catch(() => {});
        if (savedUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = savedUrl;
      }
    },
  },
];
