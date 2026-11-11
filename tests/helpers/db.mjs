// tests/helpers/db.mjs — scratch-database plumbing shared by the contract and
// parity suites (task t14).
//
// Every suite that drives the API needs the same three things tests/api/*
// hand-rolled one file at a time: a scratch database next to the shared test
// database (so a suite owns its rows and a rolled-back runner transaction can
// never interfere with a live HTTP request), a client to insert fixture rows,
// and a generic seeder that can load the tests/fixtures/*.json blocks — the
// same seed blocks the contract's byte-comparisons are pinned against — in FK
// order with every value bound as $n.
//
// The scratch database is created empty: api/server.mjs runs the migration
// runner on start-up, so the rows land on a freshly migrated schema — the
// same way the operator gets one.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { ensureTestSessions } from './session.mjs';

// Table names this seeder will insert into. Anything else is a bug in the
// fixture, not something to pass through to SQL.
const TABLES = new Set([
  'clinic_settings', 'patients', 'appointments', 'visit_notes', 'services',
  'invoices', 'invoice_items', 'payments', 'app_users', 'user_roles',
]);

// A safe identifier is one the schema itself uses; column names are checked
// against the live catalog by the caller before they reach SQL anyway, but
// this keeps a broken fixture from producing a cryptic syntax error.
const IDENT = /^[a-z_][a-z0-9_]*$/;

// --- connection helpers ------------------------------------------------------

// clientParams(url, database): pg.Client parameters for one database of the
// cluster the test URL names. Mirrors tests/api/* so both suites agree.
export function clientParams(url, database) {
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

// scratchDsn(testUrl, suffix): the DSN of `<testdb><suffix>` — the scratch
// database named by a suite, e.g. hearth_test + '_contract'.
export function scratchDsn(testUrl, suffix) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const u = new URL(testUrl);
  u.pathname = `/${base}${suffix}`;
  u.search = '';
  return u.toString();
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

// createScratch(testUrl, suffix) -> dsn: (re)create the suite's scratch
// database. FORCE drops it even with live connections — a previous crashed
// run must not wedge the suite.
export async function createScratch(testUrl, suffix) {
  const name = `${decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''))}${suffix}`;
  await withAdminDb(testUrl, async (admin) => {
    await admin.query(`drop database if exists "${name}" with (force)`);
    await admin.query(`create database "${name}"`);
  });
  return scratchDsn(testUrl, suffix);
}

// dropScratch(testUrl, suffix): best-effort cleanup for the finally block.
export async function dropScratch(testUrl, suffix) {
  const name = `${decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''))}${suffix}`;
  try {
    await withAdminDb(testUrl, async (admin) => {
      await admin.query(`drop database if exists "${name}" with (force)`);
    });
  } catch {
    /* a leaked scratch database is noise, not a failure */
  }
}

// connectDb(dsn): a connected pg.Client for the caller to seed and read.
export async function connectDb(dsn) {
  const db = new pg.Client(clientParams(dsn, decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''))));
  await db.connect();
  return db;
}

// --- fixture seeding ----------------------------------------------------------

// loadFixtures(root, ...names): read the named tests/fixtures/<name>.json
// files and hand them back keyed by name.
export function loadFixtures(root, ...names) {
  const out = {};
  for (const name of names) out[name] = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', `${name}.json`), 'utf8'));
  return out;
}

// insertRow(db, table, row): one insert with every value bound as $n. The
// column names come from the fixture and are validated against the live
// catalog (information_schema) before they are interpolated — only after, and
// only ever as "quoted" identifiers.
async function insertRow(db, table, row) {
  const columns = Object.keys(row);
  for (const column of columns) {
    if (!IDENT.test(column)) throw new Error(`fixture column ${JSON.stringify(column)} is not a safe identifier`);
  }
  const check = await db.query(
    'select column_name from information_schema.columns where table_schema = $1 and table_name = $2',
    ['public', table]
  );
  if (!check.rowCount) throw new Error(`fixture seeds unknown table public.${table}`);
  const known = new Set(check.rows.map((r) => r.column_name));
  const unknown = columns.filter((c) => !known.has(c));
  if (unknown.length) throw new Error(`fixture row for ${table} names unknown column(s): ${unknown.join(', ')}`);

  const cols = columns.map((c) => `"${c}"`).join(', ');
  const params = columns.map((_, i) => `$${i + 1}`);
  // The clinic_settings singleton repeats across fixtures and may collide
  // with the 0004_seed.sql row (different id, same singleton), so the
  // replay-safe form for this one table is a bare conflict-do-nothing.
  const conflict = table === 'clinic_settings' ? ' on conflict do nothing' : '';
  await db.query(`insert into public."${table}" (${cols}) values (${params.join(', ')})${conflict}`, columns.map((c) => row[c]));
}

// seedFixture(db, fixture): insert fixture.seed in fixture.seed_order order
// (patients -> appointments -> ... -> payments, the FK order), plus the
// fixture's clinic_settings block when it names one.
export async function seedFixture(db, fixture) {
  if (fixture.clinic_settings) await insertRow(db, 'clinic_settings', fixture.clinic_settings);
  const seed = fixture.seed ?? {};
  const order = fixture.seed_order ?? Object.keys(seed);
  for (const table of order) {
    if (!TABLES.has(table)) throw new Error(`fixture seeds unsupported table ${JSON.stringify(table)}`);
    for (const row of seed[table] ?? []) await insertRow(db, table, row);
  }
}

// seedFixtures(db, fixtures, ...names): several fixtures in the given order.
export async function seedFixtures(db, fixtures, ...names) {
  for (const name of names) await seedFixture(db, fixtures[name]);
}

// seedUsers(db, users): staff accounts the suites sign session tokens for.
// The hash is a placeholder — these accounts are never used to log in over
// HTTP in these suites (the token helpers sign directly), so it only has to
// satisfy the not-null/shape of app_users.password_hash, exactly like the
// fixtures in tests/api/*.
export async function seedUsers(db, users) {
  for (const user of users) {
    await db.query(
      'insert into public.app_users (id, email, password_hash) values ($1, $2, $3) on conflict (id) do nothing',
      [user.id, user.email, 'scrypt$fixture$not-a-real-hash']
    );
    for (const role of user.roles ?? []) {
      await db.query(
        'insert into public.user_roles (user_id, role) values ($1, $2::public.app_role) on conflict (user_id, role) do nothing',
        [user.id, role]
      );
    }
  }
  await ensureTestSessions(db);
}

// rowsOf(db, sql, params): plain rows, for the assertions.
export async function rowsOf(db, sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows;
}

// tableNames(dir): the db/migrations file list, for schema tests.
export function migrationFiles(root) {
  return readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
}
