// api/server.mjs — the API process: one Node service for the SPA and /api (task t4).
//
//   node api/server.mjs --port 8787
//
// Startup sequence (fixed, and every step must succeed before the port opens):
//
//   1. env      — load .env, read PORT / --port, ALLOWED_ORIGINS, JWT_SECRET ...
//   2. db ping  — one round trip to the Postgres behind DATABASE_URL; an
//                 unreachable database is a hard failure: the process prints
//                 'DATABASE_URL is not reachable' and exits non-zero (within
//                 10 seconds — a watchdog guarantees the bound).
//   3. migrate  — apply any db/migrations/*.sql not yet in schema_migrations
//                 (replay-safe, serialised behind a Postgres advisory lock, so
//                 two containers starting at once cannot both run them).
//   4. seed     — seed the admin/staff accounts (api/lib/seed.mjs, task t5)
//                 idempotently, so a fresh machine needs only a reachable
//                 PostgreSQL and the SEED_* environment.
//   5. listen   — start serving; /healthz answers 200 from here on.
//
// The process is configured entirely by the environment documented in
// .env.example: DATABASE_URL (or PG*), PORT, ALLOWED_ORIGINS, JWT_SECRET,
// UPLOAD_DIR, SEED_*, RESEND_*.

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { close, getPool, parseDbConfig } from './db.mjs';
import { loadEnv } from './lib/env.mjs';
import { createApp } from './routes/index.mjs';
import { runMigrations } from '../scripts/migrate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '..');

// The line the operator (and the health checks in the plan) grep for when the
// database is missing or unreachable.
export const DB_UNREACHABLE_MESSAGE = 'DATABASE_URL is not reachable';

// How long the process waits for its own startup before giving up. Below the
// 10-second bound the plan puts on a failed start, so a hung network cannot
// turn a failing start into a silent 30-second one.
export const STARTUP_TIMEOUT_MS = 9000;

// parseArgs(argv, env): the command line wins over the environment, which wins
// over the documented default port.
export function parseArgs(argv = [], env = process.env) {
  const out = { port: undefined, host: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a.startsWith('--port=')) out.port = a.slice('--port='.length);
    else if (a === '--host') out.host = argv[++i];
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  const fromEnv = env.PORT !== undefined && env.PORT !== '' ? env.PORT : '8787';
  const raw = out.port !== undefined && out.port !== '' ? out.port : fromEnv;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const err = new Error(`invalid port ${JSON.stringify(raw)}: pass --port <n> or set PORT to a number between 0 and 65535`);
    err.code = 'BAD_PORT';
    throw err;
  }
  // Bind to loopback unless told otherwise: put a TLS reverse proxy in front,
  // or set HOST=0.0.0.0 inside a container.
  const host = out.host ?? (env.HOST && String(env.HOST).trim() !== '' ? String(env.HOST).trim() : '127.0.0.1');
  return { port, host, help: out.help };
}

const HELP = `Hearth API — serves the built SPA and /api on one port

usage: node api/server.mjs [--port <n>] [--host <addr>]

  --port, -p <n>    port to listen on (default: $PORT, else 8787; 0 = ephemeral)
  --host <addr>     address to bind (default: $HOST, else 127.0.0.1)

configuration comes from the environment and .env — see .env.example.`;

// Startup step 2: one round trip. Anything the driver reports (refused,
// timeout, bad credentials, missing database) is the same answer for the
// operator: the configured database cannot be used.
async function pingDatabase() {
  await getPool().query('select 1');
}

// Startup step 3: migrations, under an advisory lock so concurrent starts (two
// containers, a restart during a rollout) take turns instead of racing the same
// DDL. Both statements run on one pooled connection, which is what makes the
// lock belong to this process.
async function migrateIfNeeded({ log }) {
  const client = await getPool().connect();
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', ['hh_migrate']);
    // the runner's per-file "skipped" chatter is noise on every start-up; only
    // what it actually applied is interesting, and that is summarised below.
    const { applied } = await runMigrations({
      config: parseDbConfig(),
      log: (line) => {
        if (!/skipped/.test(String(line))) log(line);
      },
    });
    if (applied.length) log(`api: applied ${applied.length} migration(s): ${applied.join(', ')}`);
    else log('api: database schema is up to date');
    return applied;
  } finally {
    try {
      await client.query('select pg_advisory_unlock(hashtext($1))', ['hh_migrate']);
    } catch {
      /* the connection is going away, which releases the lock anyway */
    }
    client.release();
  }
}

// Startup step 4: seed accounts. The seed module arrives with task t5; the
// hook is wired now so the startup sequence is complete and t5 only has to
// write api/lib/seed.mjs. Absent -> nothing to do (milestone-2 behaviour).
async function seedAccounts({ env, log }) {
  const file = join(HERE, 'lib', 'seed.mjs');
  if (!existsSync(file)) return null;
  const mod = await import(pathToFileURL(file).href);
  const seed = mod.seedAccounts ?? mod.seed ?? (typeof mod.default === 'function' ? mod.default : null);
  if (!seed) throw new Error('api/lib/seed.mjs must export seedAccounts(query) or seed(query)');
  const result = await seed({ env, log, query: (sql, params) => getPool().query(sql, params) });
  log(`api: ${typeof result === 'string' ? result : 'seeded accounts'}`);
  return result;
}

// The whole startup sequence, up to (but excluding) listen. Exported so the
// tests can drive each step, and so an embedding harness can start the API in
// its own process.
export async function bootstrap({ env = process.env, log = console.log } = {}) {
  // 1. env
  loadEnv();
  // 2. db ping
  await pingDatabase();
  // 3. migrate-if-needed
  await migrateIfNeeded({ log });
  // 4. seed accounts
  await seedAccounts({ env, log });
}

// startServer({port, host, env, distDir, log}): the app from api/routes/index.mjs
// plus the startup sequence above; resolves once the port is actually open, with
// the port that was bound (which is not `port` when 0 was asked for).
export async function startServer({ port, host = '127.0.0.1', env = process.env, distDir, log = console.log } = {}) {
  const app = await createApp({ distDir, env, log });
  const server = createServer(app);
  await new Promise((resolve, reject) => {
    const onError = (e) => {
      server.removeListener('listening', onListening);
      reject(e);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  const bound = server.address();
  return { app, server, port: bound.port, host: bound.address };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  // A startup that never completes is a startup that failed: guarantee the
  // 10-second bound the plan puts on "unreachable database" even if the driver
  // or a hung socket would wait longer.
  const watchdog = setTimeout(() => {
    console.error(DB_UNREACHABLE_MESSAGE);
    console.error(`api: startup did not complete within ${STARTUP_TIMEOUT_MS / 1000}s — check DATABASE_URL`);
    process.exit(1);
  }, STARTUP_TIMEOUT_MS);
  watchdog.unref?.();

  try {
    await bootstrap({ env: process.env });
  } catch (e) {
    clearTimeout(watchdog);
    console.error(DB_UNREACHABLE_MESSAGE);
    console.error(`api: ${firstLine(e)}`);
    await close().catch(() => {});
    process.exit(1);
  }

  let started;
  try {
    started = await startServer({ port: args.port, host: args.host });
  } catch (e) {
    clearTimeout(watchdog);
    if (e && e.code === 'EADDRINUSE') {
      console.error(`api: port ${args.port} is already in use — pass --port <n> or set PORT`);
    } else {
      console.error(`api: ${firstLine(e)}`);
    }
    await close().catch(() => {});
    process.exit(1);
  }
  clearTimeout(watchdog);
  console.log(`api: listening on http://${started.host}:${started.port} (dist: ${join(PROJECT_ROOT, 'dist')})`);

  const shutdown = (signal) => {
    console.log(`api: ${signal} — closing`);
    server_close(started.server);
    close().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

function server_close(server) {
  try {
    server.close();
    server.closeIdleConnections?.();
  } catch {
    /* already closed */
  }
}

function firstLine(e) {
  return String(e?.message ?? e).split('\n')[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
