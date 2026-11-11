// api/lib/env.mjs — tiny .env loader and required-variable checks (task t3).
//
// Every entry point (api/server.mjs, scripts/db-init.mjs, scripts/migrate.mjs)
// calls loadEnv() before reading the environment, so a project `.env` file is
// honoured without adding dotenv or any other dependency. A real environment
// variable always wins over the one in the file, which is what makes
// TEST_DATABASE_URL-style overrides keep working.
//
// .env syntax supported: `KEY=value`, `export KEY=value`, `# comments`, blank
// lines, and values wrapped in single or double quotes. Everything after `=`
// up to the end of the line is the value (trimmed).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Project root, resolved from this file (api/lib/ -> up two levels).
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

// Loads <root>/.env into `env` (default process.env), never overwriting a
// variable that is already set. Returns the path loaded, or null when there
// is no .env file.
export function loadEnv(root = ROOT, env = process.env) {
  const file = join(root, '.env');
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (env[key] !== undefined) continue; // the real environment wins
    env[key] = raw.trim().replace(/^(['"])(.*)\1$/s, '$2');
  }
  return file;
}

// Returns env[name] or throws an Error whose .code is MISSING_ENV. Used by
// later milestones for values the API must not run without (JWT_SECRET...).
export function requireEnv(name, env = process.env) {
  const value = env[name];
  if (value === undefined || value === '') {
    const err = new Error(`missing required environment variable ${name} (see .env.example)`);
    err.code = 'MISSING_ENV';
    throw err;
  }
  return value;
}
