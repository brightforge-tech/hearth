// scripts/migrate.mjs — ordered, idempotent migration runner (task t3).
//
//   npm run db:migrate
//
// Applies every db/migrations/*.sql file in filename order, each one inside
// its own transaction (a file fails -> its transaction rolls back and no
// later file runs), and records the filename in public.schema_migrations.
// Files already recorded are skipped, so a second run reports zero new
// migrations. The runner connects to the target database resolved from
// DATABASE_URL / PG* (see api/db.mjs); run npm run db:init first if that
// database does not exist yet.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { loadEnv } from '../api/lib/env.mjs';
import { parseDbConfig, redactDsn } from '../api/db.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';

// Sorted list of the migration files (filename order is apply order).
export function listMigrations(dir = join(ROOT, 'db', 'migrations')) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

// Applies the unrecorded files. `log` is injectable for tests; pg is used
// directly here (a script, not the API pool).
export async function runMigrations({ config, migrationsDir = join(ROOT, 'db', 'migrations'), log = console.log }) {
  const client = new pg.Client(config);
  await client.connect();
  try {
    // The ledger itself is not a migration file: the runner owns it, and it
    // exists right after the first db:migrate (W2 lists it among the tables).
    await client.query(`
      create table if not exists public.schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const files = listMigrations(migrationsDir);
    const recorded = await client.query('select name from public.schema_migrations');
    const done = new Set(recorded.rows.map((r) => r.name));

    const applied = [];
    const skipped = [];
    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        log(`db:migrate: skipped ${file} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.schema_migrations (name) values ($1)', [file]);
        await client.query('commit');
        applied.push(file);
        log(`db:migrate: applied ${file}`);
      } catch (e) {
        try {
          await client.query('rollback');
        } catch {
          /* the transaction was already aborted server-side */
        }
        const err = new Error(`db:migrate: ${file} failed: ${e.message}`);
        err.code = e.code ?? 'MIGRATION_FAILED';
        err.migration = file;
        throw err;
      }
    }
    return { applied, skipped, files };
  } finally {
    await client.end();
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
  try {
    const { applied, skipped } = await runMigrations({ config });
    console.log(`db:migrate: applied ${applied.length} new migration(s); ${skipped.length} skipped (already applied)`);
  } catch (e) {
    if (e.code === '3D000') {
      console.error(
        `db:migrate: database "${config.database}" does not exist on ` +
          `${config.host}:${config.port} — run npm run db:init first (check DATABASE_URL ` +
          `(${redactDsn(process.env.DATABASE_URL ?? '')}))`
      );
    } else if (e.migration) {
      console.error(e.message);
    } else {
      console.error(`db:migrate: ${e.message} — check DATABASE_URL`);
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
