// scripts/db-init.mjs — create/check the target database (task t3).
//
//   npm run db:init
//
// Resolves the connection from DATABASE_URL, falling back to
// PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD (see api/db.mjs). Then, through
// the cluster's maintenance database:
//   * refuses any server below PostgreSQL 13 (gen_random_uuid() must be core)
//     with `PostgreSQL 13 or newer required` and a non-zero exit, before it
//     could create anything;
//   * creates the target database when it is missing and the connected role
//     is permitted to; when the role is not permitted (or the server cannot
//     be reached) it exits non-zero naming DATABASE_URL.
//
// Importable (runInit/assertServerVersion are exported and openAdmin can be
// injected) so the version gate is testable without an old server.

import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../api/lib/env.mjs';
import { parseDbConfig, redactDsn } from '../api/db.mjs';

export const MIN_SERVER_VERSION_NUM = 130000;
export const VERSION_MESSAGE = 'PostgreSQL 13 or newer required';

// Throws Error('PostgreSQL 13 or newer required') for 12.x and older.
export function assertServerVersion(serverVersionNum) {
  const num = Number(serverVersionNum);
  if (!(num >= MIN_SERVER_VERSION_NUM)) {
    const err = new Error(VERSION_MESSAGE);
    err.code = 'PG_TOO_OLD';
    throw err;
  }
}

// The whole flow, with the maintenance connection factory injectable:
// openAdmin(config) -> a connected client-like { query, end }.
export async function runInit({ config, database, openAdmin, maintenance = 'postgres' }) {
  const admin = await openAdmin({ ...config, database: maintenance });
  try {
    const v = await admin.query(
      "select current_setting('server_version') as version, " +
        "current_setting('server_version_num')::int as num"
    );
    // The version gate runs before anything that could write to the cluster.
    assertServerVersion(v.rows[0].num);

    const found = await admin.query('select 1 from pg_database where datname = $1', [database]);
    if (found.rowCount) {
      return { created: false, version: v.rows[0].version, num: Number(v.rows[0].num) };
    }
    if (!/^[a-z_][a-z0-9_$]*$/i.test(database)) {
      const err = new Error(
        `cannot create database "${database}": only plain identifiers are supported ` +
          `(check the database in DATABASE_URL)`
      );
      err.code = 'BAD_DB_NAME';
      throw err;
    }
    await admin.query(`create database "${database}"`);
    return { created: true, version: v.rows[0].version, num: Number(v.rows[0].num) };
  } finally {
    await admin.end();
  }
}

async function main() {
  loadEnv();
  let config;
  try {
    config = parseDbConfig();
  } catch (e) {
    console.error(`${e.message} — set DATABASE_URL (see .env.example)`);
    process.exitCode = 1;
    return;
  }
  const where = `${config.host}:${config.port}`;
  try {
    const result = await runInit({
      config,
      database: config.database,
      openAdmin: async (cfg) => {
        const client = new pg.Client(cfg);
        await client.connect();
        return client;
      },
    });
    const pgver = `PostgreSQL ${result.version} (server_version_num ${result.num})`;
    if (result.created) console.log(`db:init: created database "${config.database}" on ${where} — ${pgver}`);
    else console.log(`db:init: database "${config.database}" already exists on ${where} — ${pgver}, nothing to create`);
  } catch (e) {
    if (e.code === 'PG_TOO_OLD') {
      console.error(`db:init: ${e.message}`);
      process.exitCode = 1;
      return;
    }
    if (e.code === '28P01' || e.code === '3D000' || e.code === '28000') {
      console.error(`db:init: cannot open a maintenance connection to ${where} (${e.message}) — check DATABASE_URL (${redactDsn(process.env.DATABASE_URL ?? '')})`);
    } else if (e.code === '42501') {
      console.error(`db:init: not permitted to create database "${config.database}" (${e.message}) — check DATABASE_URL (${redactDsn(process.env.DATABASE_URL ?? '')})`);
    } else {
      console.error(`db:init: ${e.message} — check DATABASE_URL`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
