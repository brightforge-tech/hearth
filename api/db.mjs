// api/db.mjs — the single Postgres access point (task t3).
//
// Everything that talks to the database — the API routes, the ported edge
// functions, scripts/migrate.mjs — goes through this module, so the DSN lives
// in server-side environment only and never reaches the browser.
//
// Configuration (resolved lazily, when the pool is first created, so tests
// may set the environment before the first query):
//   1. DATABASE_URL (postgresql:// or postgres:// DSN) — wins when set;
//   2. otherwise PGHOST / PGPORT / PGDATABASE / PGUSER / PGPASSWORD;
//   3. otherwise the documented local defaults (127.0.0.1:5432, database
//      hearth, user postgres).
//
// All SQL must use $1..$n placeholders; the only interpolated value anywhere
// here is the uuid passed to withUser(), and only after a strict uuid check.
// Errors thrown out of this module carry a .code (the Postgres sqlstate, or
// INVALID_UID / BAD_DSN for local misuse).

import pg from 'pg';
import { loadEnv } from './lib/env.mjs';

loadEnv(); // honour a project .env (no-op when the file is absent)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Builds pg connection parameters from the environment. Exported so
// scripts/db-init.mjs and scripts/migrate.mjs resolve the DSN the same way.
export function parseDbConfig(env = process.env) {
  const url = (env.DATABASE_URL ?? '').trim();
  if (url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      const err = new Error(`DATABASE_URL is not a valid postgresql:// DSN: ${redactDsn(url)}`);
      err.code = 'BAD_DSN';
      throw err;
    }
    const sslmode = u.searchParams.get('sslmode');
    return {
      host: decodeURIComponent(u.hostname) || '127.0.0.1',
      port: u.port ? Number(u.port) : 5432,
      user: u.username ? decodeURIComponent(u.username) : 'postgres',
      password: u.password ? decodeURIComponent(u.password) : '',
      database: decodeURIComponent((u.pathname ?? '').replace(/^\//, '')) || 'postgres',
      ...(sslmode ? { ssl: sslmode === 'disable' ? false : true } : {}),
      connectionTimeoutMillis: 10_000,
    };
  }
  return {
    host: env.PGHOST || '127.0.0.1',
    port: env.PGPORT ? Number(env.PGPORT) : 5432,
    user: env.PGUSER || 'postgres',
    password: env.PGPASSWORD ?? '',
    database: env.PGDATABASE || 'hearth',
    connectionTimeoutMillis: 10_000,
  };
}

// DSN with the password masked, safe to print in scripts' error messages.
export function redactDsn(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return String(url).replace(/:[^:@/]+@/, ':***@');
  }
}

let pool = null;

// Lazily created pool: importing this module never touches the network, and
// close() can hand the next caller a fresh pool.
export function getPool() {
  if (!pool) pool = new pg.Pool(parseDbConfig());
  return pool;
}

// query(text, params) -> {rows, rowCount}, from the pool.
export async function query(text, params) {
  const r = await getPool().query(text, params);
  return { rows: r.rows, rowCount: r.rowCount };
}

// tx(fn): one client, one transaction. fn receives the dedicated client
// (use client.query / the helpers below with it); commit on resolve, rollback
// and rethrow on reject. The client always goes back to the pool.
export async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e) {
    try {
      await client.query('rollback');
    } catch {
      /* the transaction was already aborted server-side */
    }
    throw e;
  } finally {
    client.release();
  }
}

// withUser(uid, fn): runs fn inside a transaction whose caller identity is the
// given uuid, by issuing `set local app.uid = '<uuid>'` first — the GUC that
// public.current_uid() reads (db/migrations/0005_auth.sql). `set local` is
// transaction-scoped, so the identity can never leak to the next caller that
// reuses this pooled connection, and it is dropped again on rollback.
// SET has no $n parameter form, so the uuid is validated strictly and only
// then interpolated.
export async function withUser(uid, fn) {
  if (typeof uid !== 'string' || !UUID_RE.test(uid)) {
    const err = new Error(`withUser: uid must be a uuid string, got ${JSON.stringify(uid)}`);
    err.code = 'INVALID_UID';
    throw err;
  }
  return tx(async (client) => {
    await client.query(`set local app.uid = '${uid}'`);
    return fn(client);
  });
}

// close(): ends the pool if one was created; safe to call repeatedly.
export async function close() {
  const ending = pool;
  pool = null;
  if (ending) await ending.end();
}
