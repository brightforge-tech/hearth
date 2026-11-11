// tests/run.mjs — minimal test runner for this project (no framework).
// Discovers tests/**/*.test.mjs (restricted by --dir), runs every case each
// file exports, and writes a JUnit XML report to process.env.JUNIT_OUTPUT
// (default reports/junit.xml). Exits 0 only when every case passes.
//
// The database is reset and db/migrations applied before the cases run.
// Connection comes from TEST_DATABASE_URL, else DATABASE_URL with `_test`
// appended to the database name, else the documented local default.
// TZ is pinned to UTC before anything else loads, so date/time assertions are
// environment-independent.
process.env.TZ = 'UTC';

import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- tiny .env loader (no dependency), so DATABASE_URL can live in .env ----
if (existsSync(join(ROOT, '.env'))) {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

// ---- CLI -------------------------------------------------------------------
const argv = process.argv.slice(2);
let testDir = 'tests';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--dir') testDir = argv[++i] ?? testDir;
}
const dirAbs = resolve(ROOT, testDir);
if (!statSync(dirAbs, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`not a directory: ${dirAbs}`);
  process.exit(2);
}

// ---- database resolution ---------------------------------------------------
function defaultTestUrl() {
  const base =
    process.env.DATABASE_URL ||
    'postgresql://postgres:postgres@127.0.0.1:5432/hearth';
  try {
    const u = new URL(base);
    u.pathname = (u.pathname || '/hearth').replace(/\/$/, '') + '_test';
    return u.toString();
  } catch {
    return base;
  }
}
const TEST_URL = process.env.TEST_DATABASE_URL || defaultTestUrl();
const target = new URL(TEST_URL);
const dbName = decodeURIComponent(target.pathname.replace(/^\//, ''));
if (!dbName.endsWith('_test') && process.env.ALLOW_DESTRUCTIVE !== '1') {
  console.error(
    `refusing to reset ${dbName}: only *_test databases may be wiped ` +
      `(set ALLOW_DESTRUCTIVE=1 to override)`
  );
  process.exit(2);
}

function log(...a) {
  console.log(...a);
}

// ---- schema reset + migrations ----------------------------------------------
async function prepareDatabase() {
  const params = {
    host: target.hostname,
    port: Number(target.port || 5432),
    user: decodeURIComponent(target.username || 'postgres'),
    password: target.password ? decodeURIComponent(target.password) : '',
    ssl: false,
    connectionTimeoutMillis: 5000,
  };
  // create the test database if it does not exist yet
  {
    const admin = new pg.Client({ ...params, database: 'postgres' });
    try {
      await admin.connect();
    } catch (e) {
      console.error(
        `cannot reach PostgreSQL at ${target.hostname}:${params.port} ` +
          `(${e.message}); set DATABASE_URL or TEST_DATABASE_URL`
      );
      process.exit(2);
    }
    const exists = await admin.query('select 1 from pg_database where datname = $1', [dbName]);
    if (!exists.rowCount) {
      if (!/^[a-z0-9_]+$/.test(dbName)) {
        console.error(`refusing to create database with unusual name ${dbName}`);
        process.exit(2);
      }
      await admin.query(`create database ${dbName}`);
      log(`created database ${dbName}`);
    }
    await admin.end();
  }
  const client = new pg.Client({ ...params, database: dbName });
  await client.connect();
  await client.query('drop schema if exists public cascade; create schema public;');
  const files = readdirSync(join(ROOT, 'db', 'migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const f of files) {
    const sql = readFileSync(join(ROOT, 'db', 'migrations', f), 'utf8');
    await client.query('begin');
    try {
      await client.query(sql);
      await client.query('commit');
    } catch (e) {
      await client.query('rollback');
      throw new Error(`migration ${f} failed: ${e.message}`);
    }
    log(`applied db/migrations/${f}`);
  }
  return client;
}

// ---- discovery ---------------------------------------------------------------
function findTests(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...findTests(p));
    else if (ent.isFile() && /\.test\.mjs$/.test(ent.name)) out.push(p);
  }
  return out.sort();
}

// ---- helpers given to every case --------------------------------------------
let saved = 0;
async function withClient(client) {
  await client.query('begin');
}

function makeCtx(client) {
  // Roll a statement back to a savepoint when it is expected to fail, so the
  // case can continue after constraint/trigger errors inside the shared tx.
  const expectError = async (fn, sqlstate) => {
    await client.query(`savepoint sp_${++saved}`);
    const sp = `sp_${saved}`;
    try {
      await fn();
    } catch (e) {
      await client.query(`rollback to savepoint ${sp}`);
      if (sqlstate && e.code !== sqlstate) {
        throw new Error(`expected sqlstate ${sqlstate}, got ${e.code}: ${e.message}`);
      }
      return e;
    }
    await client.query(`release savepoint ${sp}`);
    throw new Error('expected the statement to fail, but it succeeded');
  };
  return { client, expectError, root: ROOT, testUrl: TEST_URL };
}

// ---- junit -------------------------------------------------------------------
const xml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c])
  );

function writeJUnit(suites) {
  const out = process.env.JUNIT_OUTPUT
    ? resolve(ROOT, process.env.JUNIT_OUTPUT)
    : join(ROOT, 'reports', 'junit.xml');
  mkdirSync(dirname(out), { recursive: true });
  const total = suites.reduce((n, s) => n + s.cases.length, 0);
  const failures = suites.reduce((n, s) => n + s.cases.filter((c) => !c.pass).length, 0);
  const secs = suites.reduce((n, s) => n + s.cases.reduce((m, c) => m + c.ms, 0), 0) / 1000;
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="regression" tests="${total}" failures="${failures}" time="${secs.toFixed(3)}">`,
  ];
  for (const s of suites) {
    const sf = s.cases.filter((c) => !c.pass).length;
    parts.push(
      `  <testsuite name="${xml(s.name)}" tests="${s.cases.length}" failures="${sf}" time="${(
        s.cases.reduce((m, c) => m + c.ms, 0) / 1000
      ).toFixed(3)}">`
    );
    for (const c of s.cases) {
      parts.push(`    <testcase classname="${xml(s.name)}" name="${xml(c.name)}" time="${(c.ms / 1000).toFixed(3)}"`);
      if (c.pass) parts.push('/>');
      else
        parts.push(
          `>\n      <failure message="${xml(String(c.error?.message ?? c.error).split('\n')[0])}">${xml(
            String(c.error?.stack ?? c.error)
          )}</failure>\n    </testcase>`
        );
    }
    parts.push('  </testsuite>');
  }
  parts.push('</testsuites>');
  writeFileSync(out, parts.join('\n') + '\n');
  log(`junit report written to ${out}`);
}

// ---- main --------------------------------------------------------------------
const files = findTests(dirAbs);
if (!files.length) {
  console.error(`no *.test.mjs files under ${dirAbs}`);
  process.exit(2);
}
log(`test database: ${target.hostname}:${target.port || 5432}/${dbName}`);
const client = await prepareDatabase();

const suites = [];
let failed = 0;
for (const file of files) {
  const name = file.slice(ROOT.length + 1).replace(/\\/g, '/');
  const mod = await import(pathToFileURL(file).href);
  const cases = mod.default ?? [];
  log(`\n# ${name}`);
  const suite = { name, cases: [] };
  for (const c of cases) {
    const t0 = Date.now();
    let pass = true;
    let error = null;
    await withClient(client);
    try {
      await c.fn(makeCtx(client));
      await client.query('rollback');
    } catch (e) {
      pass = false;
      error = e;
      try { await client.query('rollback'); } catch { /* tx already aborted */ }
    }
    const ms = Date.now() - t0;
    if (!pass) failed++;
    log(`${pass ? 'PASS' : 'FAIL'}  ${c.name} (${ms}ms)${pass ? '' : '\n      ' + (error?.stack ?? error)}`);
    suite.cases.push({ name: c.name, pass, ms, error });
  }
  suites.push(suite);
}
await client.end();
writeJUnit(suites);

const total = suites.reduce((n, s) => n + s.cases.length, 0);
log(`\n${total - failed}/${total} cases passed`);
process.exit(failed ? 1 : 0);
