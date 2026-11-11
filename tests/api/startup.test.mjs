// tests/api/startup.test.mjs — api/server.mjs: startup sequence, health,
// --port/PORT handling, and the failure contract when the database is missing
// or unreachable (task t4, acceptance W13).
//
// Every case starts the server exactly the way the operator does —
// `node api/server.mjs --port <n>` — and checks what the process prints and
// which port it ends up serving, so the wiring of the startup sequence
// (env -> db ping -> migrate-if-needed -> seed accounts -> listen) is proven
// end to end rather than assumed.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

import { parseArgs, DB_UNREACHABLE_MESSAGE, STARTUP_TIMEOUT_MS } from '../../api/server.mjs';
import { request, startServer } from '../helpers/server.mjs';

const SCRATCH = '_t4';

function swapDb(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

function scratchUrl(testUrl) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  return swapDb(testUrl, `${base}${SCRATCH}`);
}

// A scratch database of its own, dropped first so "migrate-if-needed on a fresh
// machine" really runs the migrations.
async function freshScratch(testUrl) {
  const url = scratchUrl(testUrl);
  const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
  const admin = new pg.Client({
    host: new URL(url).hostname,
    port: Number(new URL(url).port || 5432),
    user: decodeURIComponent(new URL(url).username || 'postgres'),
    password: new URL(url).password ? decodeURIComponent(new URL(url).password) : '',
    database: 'postgres',
    connectionTimeoutMillis: 5000,
  });
  await admin.connect();
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
  await admin.end();
  return url;
}

export default [
  {
    name: 'parseArgs: --port beats PORT beats the default, and a bad port is refused',
    async fn() {
      if (parseArgs(['--port', '8123'], {}).port !== 8123) throw new Error('--port <n>');
      if (parseArgs(['--port=8124'], {}).port !== 8124) throw new Error('--port=<n>');
      if (parseArgs(['-p', '8125'], {}).port !== 8125) throw new Error('-p <n>');
      if (parseArgs([], { PORT: '9999' }).port !== 9999) throw new Error('PORT');
      if (parseArgs(['--port', '7777'], { PORT: '9999' }).port !== 7777) throw new Error('--port must win over PORT');
      if (parseArgs([], {}).port !== 8787) throw new Error('the documented default must be 8787');
      if (parseArgs([], { PORT: '' }).port !== 8787) throw new Error('an empty PORT must fall back to the default');
      if (parseArgs(['--port', '0'], {}).port !== 0) throw new Error('port 0 (ephemeral) must be accepted');
      if (parseArgs(['--host', '127.0.0.1'], {}).host !== '127.0.0.1') throw new Error('--host');
      for (const bad of [['--port', 'abc'], ['--port', '-1'], ['--port', '70000'], ['--port', '80.5']]) {
        let caught = null;
        try {
          parseArgs(bad, {});
        } catch (e) {
          caught = e;
        }
        if (!caught || caught.code !== 'BAD_PORT') throw new Error(`${bad.join(' ')} must be refused with BAD_PORT`);
      }
      let envBad = null;
      try {
        parseArgs([], { PORT: 'not-a-port' });
      } catch (e) {
        envBad = e;
      }
      if (!envBad || envBad.code !== 'BAD_PORT') throw new Error('PORT=not-a-port must be refused');
    },
  },
  {
    name: 'the startup watchdog is below the 10-second bound the plan puts on a failed start',
    async fn() {
      if (!(STARTUP_TIMEOUT_MS > 0 && STARTUP_TIMEOUT_MS < 10_000)) {
        throw new Error(`STARTUP_TIMEOUT_MS must be > 0 and < 10000, got ${STARTUP_TIMEOUT_MS}`);
      }
      if (DB_UNREACHABLE_MESSAGE !== 'DATABASE_URL is not reachable') {
        throw new Error(`the failure line must be exact, got ${JSON.stringify(DB_UNREACHABLE_MESSAGE)}`);
      }
    },
  },
  {
    name: 'node api/server.mjs --port <n> serves GET /healthz with 200 JSON against DATABASE_URL',
    async fn({ root, testUrl }) {
      const h = startServer({ root, databaseUrl: testUrl, env: { ALLOWED_ORIGINS: 'http://localhost:8080' } });
      try {
        await h.waitForPort();
        const r = await request(h.port, '/healthz');
        if (r.status !== 200) throw new Error(`GET /healthz -> ${r.status}: ${r.text}`);
        if (!/^application\/json/.test(r.headers['content-type'] ?? '')) {
          throw new Error(`content-type is ${r.headers['content-type']}`);
        }
        if (!r.json || r.json.status !== 'ok') throw new Error(`body is ${r.text}`);
        if (typeof r.json.uptime !== 'number') throw new Error(`uptime missing: ${r.text}`);
        if (!/^\d{4}-\d{2}-\d{2}T/.test(r.json.timestamp ?? '')) throw new Error(`timestamp missing: ${r.text}`);
        // the log line the helper (and an operator) reads the port from
        if (!h.log().includes('api: listening on http://')) throw new Error(`no listen line:\n${h.log()}`);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: 'PORT from the environment is used when no --port flag is given',
    async fn({ root, testUrl }) {
      const h = startServer({ root, databaseUrl: testUrl, passPortFlag: false, env: { PORT: '8790' } });
      try {
        await h.waitForPort();
        if (h.port !== 8790) throw new Error(`expected port 8790, listening on ${h.port}`);
        const r = await request(8790, '/healthz');
        if (r.status !== 200) throw new Error(`GET /healthz on $PORT -> ${r.status}`);
      } finally {
        await h.stop();
      }
    },
  },
  {
    name: 'an invalid --port exits non-zero naming the port, without listening',
    async fn({ root, testUrl }) {
      const started = Date.now();
      const r = spawnSync(process.execPath, [join(root, 'api', 'server.mjs'), '--port', 'not-a-port'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: testUrl },
        timeout: 15_000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status === 0) throw new Error(`an invalid port must fail the start:\n${out}`);
      if (!out.includes('not-a-port')) throw new Error(`the message should name the bad value:\n${out}`);
      if (Date.now() - started > 10_000) throw new Error('a bad port must be refused immediately');
    },
  },
  {
    name: 'an unreachable DATABASE_URL exits non-zero printing DATABASE_URL is not reachable',
    async fn({ root }) {
      const started = Date.now();
      const r = spawnSync(process.execPath, [join(root, 'api', 'server.mjs'), '--port', '8791'], {
        cwd: root,
        encoding: 'utf8',
        // a port where nothing listens: an immediate, unmistakable failure
        env: { ...process.env, DATABASE_URL: 'postgresql://nobody:secret@127.0.0.1:9/hearth' },
        timeout: 30_000,
      });
      const elapsed = Date.now() - started;
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status === 0) throw new Error(`an unreachable database must fail the start:\n${out}`);
      if (!out.includes(DB_UNREACHABLE_MESSAGE)) {
        throw new Error(`expected ${JSON.stringify(DB_UNREACHABLE_MESSAGE)} in the output:\n${out}`);
      }
      if (elapsed > 10_000) throw new Error(`the process took ${elapsed}ms; the bound is 10 seconds`);
    },
  },
  {
    name: 'a missing or unparseable DATABASE_URL fails the same way',
    async fn({ root }) {
      const r = spawnSync(process.execPath, [join(root, 'api', 'server.mjs'), '--port', '8792'], {
        cwd: root,
        encoding: 'utf8',
        // nothing the driver can dial: no DSN, no PG*, and the default cluster
        // port of this probe is pointed at a dead one
        env: {
          ...process.env,
          DATABASE_URL: 'not-a-dsn',
          PGHOST: '127.0.0.1',
          PGPORT: '9',
        },
        timeout: 30_000,
      });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status === 0) throw new Error(`an unparseable DATABASE_URL must fail the start:\n${out}`);
      if (!out.includes(DB_UNREACHABLE_MESSAGE)) throw new Error(`expected the standard line:\n${out}`);
    },
  },
  {
    name: 'a database that never answers is cut off by the watchdog, not left hanging',
    async fn({ root }) {
      // 10.254.254.254 is TEST-NET: the TCP connect goes nowhere, so only the
      // process' own watchdog can end the start. The bound under test is the
      // 10 seconds the plan states, checked from spawn to exit.
      const started = Date.now();
      const r = spawnSync(process.execPath, [join(root, 'api', 'server.mjs'), '--port', '8793'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: 'postgresql://postgres@10.254.254.254:5432/hearth' },
        timeout: 30_000,
      });
      const elapsed = Date.now() - started;
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status === 0) throw new Error(`a hanging database must fail the start:\n${out}`);
      if (!out.includes(DB_UNREACHABLE_MESSAGE)) throw new Error(`expected the standard line:\n${out}`);
      if (elapsed > 10_000) throw new Error(`the process took ${elapsed}ms to give up; the bound is 10 seconds`);
    },
  },
  {
    name: 'on a fresh database the start runs every migration, and a second start applies none',
    async fn({ root, testUrl }) {
      const dsn = await freshScratch(testUrl);
      const expected = readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).length;
      const h = startServer({ root, databaseUrl: dsn });
      try {
        await h.waitForPort();
        const log = h.log();
        if (!new RegExp(`api: applied ${expected} migration\\(s\\)`).test(log)) {
          throw new Error(`first start did not apply the ${expected} migrations:\n${log}`);
        }
        const r = await request(h.port, '/healthz');
        if (r.status !== 200) throw new Error(`healthz after migrating -> ${r.status}`);
      } finally {
        await h.stop();
      }
      const second = startServer({ root, databaseUrl: dsn });
      try {
        await second.waitForPort();
        const log = second.log();
        if (/api: applied \d+ migration/.test(log)) throw new Error(`second start re-ran migrations:\n${log}`);
        if (!log.includes('database schema is up to date')) throw new Error(`second start is not idempotent:\n${log}`);
        const r = await request(second.port, '/healthz');
        if (r.status !== 200) throw new Error(`healthz on the second start -> ${r.status}`);
      } finally {
        await second.stop();
      }
      // the migrated scratch database really is the ported schema
      const probe = new pg.Client({
        host: new URL(dsn).hostname,
        port: Number(new URL(dsn).port || 5432),
        user: decodeURIComponent(new URL(dsn).username || 'postgres'),
        password: new URL(dsn).password ? decodeURIComponent(new URL(dsn).password) : '',
        database: decodeURIComponent(new URL(dsn).pathname.replace(/^\//, '')),
        connectionTimeoutMillis: 5000,
      });
      try {
        await probe.connect();
        const n = await probe.query(
          `select (select count(*) from information_schema.tables where table_schema='public')::int t,
                  (select count(*) from public.schema_migrations)::int m`
        );
        if (n.rows[0].m !== expected) throw new Error(`schema_migrations holds ${n.rows[0].m} rows, expected ${expected}`);
        if (n.rows[0].t < 13) throw new Error(`only ${n.rows[0].t} tables in the migrated database`);
      } finally {
        await probe.end();
      }
    },
  },
  {
    name: 'two instances starting at the same time both come up on the same database',
    async fn({ root, testUrl }) {
      // The migration step is serialised behind a Postgres advisory lock, so
      // concurrent starts (a rolling deploy) cannot race the same DDL.
      const dsn = await freshScratch(testUrl);
      const a = startServer({ root, databaseUrl: dsn });
      const b = startServer({ root, databaseUrl: dsn });
      try {
        const [ha, hb] = await Promise.all([a.waitForPort(), b.waitForPort()]);
        if (ha.port === hb.port) throw new Error(`both instances claim port ${ha.port}`);
        for (const h of [a, b]) {
          const r = await request(h.port, '/healthz');
          if (r.status !== 200) throw new Error(`healthz -> ${r.status}:\n${h.log()}`);
        }
        const migrations = [a, b].filter((h) => /api: applied \d+ migration/.test(h.log()));
        if (migrations.length > 1) throw new Error('two instances applied migrations at once');
      } finally {
        await a.stop();
        await b.stop();
      }
      // the scratch database left behind for the next run is gone again
      const admin = new pg.Client({
        host: new URL(dsn).hostname,
        port: Number(new URL(dsn).port || 5432),
        user: decodeURIComponent(new URL(dsn).username || 'postgres'),
        password: new URL(dsn).password ? decodeURIComponent(new URL(dsn).password) : '',
        database: 'postgres',
        connectionTimeoutMillis: 5000,
      });
      try {
        await admin.connect();
        const name = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
        if (!existsSync(join(root, 'db', 'migrations'))) throw new Error('db/migrations vanished');
        await admin.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await admin.end();
      }
    },
  },
];
