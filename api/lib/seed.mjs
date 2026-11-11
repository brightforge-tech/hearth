// api/lib/seed.mjs — idempotent start-up seeding (task t5, criterion W20).
//
// api/server.mjs calls seedAccounts({env, log, query}) after the migrations and
// before the port opens, so a fresh machine needs only a reachable PostgreSQL
// and the environment documented in .env.example. The plan's fixed account set
// (milestone-2 criteria W14/W17/W20 name them) is:
//
//   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD  -> role 'admin'  (default
//                                                        admin@example.test
//                                                        / Admin#2025test)
//   SEED_STAFF_EMAIL / SEED_STAFF_PASSWORD  -> role 'user'   (default
//                                                        staff@example.test
//                                                        / Staff#2025test)
//
// The password is never stored raw: it goes through api/lib/passwords.mjs, so
// app_users.password_hash holds a salted scrypt record (W20).
//
// Idempotent in the strong sense — replaying changes nothing:
//   * the account row is inserted `on conflict (email) do nothing`, so an
//     operator who changed a seed account's password (or who created the
//     account first) is never overwritten;
//   * the role grant is `on conflict (user_id, role) do nothing`;
//   * the clinic_settings singleton insert is the same statement 0004_seed.sql
//     runs, repeated here so a database migrated before that seed existed (or
//     restored without it) still comes up with the settings row;
//   * starting the server twice creates nothing twice (W20).
//
// SEED_ACCOUNTS=0|false|off switches the whole step off (the regression suite
// uses that so its fixtures own the users table exactly).

import { hashPassword } from './passwords.mjs';

// The accounts the first start-up of a fresh database gets. Defaults are the
// credentials the milestone-2 acceptance criteria (W14) sign in with; an
// operator points SEED_* at their own addresses and secrets for a real
// deployment — and should change the passwords afterwards, which is why the
// insert never overwrites an existing row.
export const DEFAULT_SEED_ACCOUNTS = Object.freeze([
  Object.freeze({
    key: 'admin',
    role: 'admin',
    emailEnv: 'SEED_ADMIN_EMAIL',
    passwordEnv: 'SEED_ADMIN_PASSWORD',
    email: 'admin@example.test',
    password: 'Admin#2025test',
  }),
  Object.freeze({
    key: 'staff',
    role: 'user',
    emailEnv: 'SEED_STAFF_EMAIL',
    passwordEnv: 'SEED_STAFF_PASSWORD',
    email: 'staff@example.test',
    password: 'Staff#2025test',
  }),
]);

export function forcePasswordChange(env = process.env) {
  const raw = String(env.SEED_FORCE_PASSWORD_CHANGE ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

// seedAccountsEnabled(env): on unless explicitly disabled.
export function seedAccountsEnabled(env = process.env) {
  const raw = String(env.SEED_ACCOUNTS ?? '').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(raw);
}

async function userIdFor(query, email) {
  const { rows } = await query('select id from public.app_users where email = $1', [email]);
  return rows[0]?.id ?? null;
}

// seedAccounts({env, log, query}): ensure the settings singleton and the
// configured staff accounts, and say what happened in one log-friendly line.
// `query` comes from api/server.mjs (the pool); it is required so an embedding
// harness — the regression suite above all — can run the same code inside its
// own transaction and roll it back.
export async function seedAccounts({ env = process.env, log = () => {}, query } = {}) {
  if (typeof query !== 'function') {
    throw new Error('seedAccounts needs a query(sql, params) function');
  }
  if (!seedAccountsEnabled(env)) {
    log('api: seed accounts disabled (SEED_ACCOUNTS)');
    return 'seed accounts disabled';
  }

  // The clinic_settings singleton, replay-safe, exactly as 0004_seed.sql has it.
  await query(
    `insert into public.clinic_settings (singleton, currency_code, tax_enabled, tax_name, tax_rate, default_appointment_duration_minutes)
     values (true, 'USD', false, 'VAT', 0.00, 30)
     on conflict (singleton) do nothing`
  );

  const created = [];
  const existing = [];
  const skipped = [];
  for (const spec of DEFAULT_SEED_ACCOUNTS) {
    const email = String(env[spec.emailEnv] ?? spec.email).trim().toLowerCase();
    const password = env[spec.passwordEnv] ?? spec.password;
    if (!email || password === '') {
      skipped.push(`${spec.key} (${spec.passwordEnv} is empty)`);
      continue;
    }
    if ((await userIdFor(query, email)) === null) {
      const hash = await hashPassword(String(password));
      // Seeded passwords are known to whoever read the configuration, so the
      // account must choose its own at first sign-in (SEED_FORCE_PASSWORD_CHANGE=0
      // switches that off, e.g. for automated test environments).
      await query(
        'insert into public.app_users (email, password_hash, must_change_password) values ($1, $2, $3) on conflict (email) do nothing',
        [email, hash, forcePasswordChange(env)]
      );
      created.push(spec.key);
    } else {
      existing.push(spec.key);
    }
    const id = await userIdFor(query, email);
    await query('insert into public.user_roles (user_id, role) values ($1, $2::public.app_role) on conflict (user_id, role) do nothing', [id, spec.role]);
  }

  const parts = [];
  if (created.length) parts.push(`${created.length} created (${created.join(', ')})`);
  if (existing.length) parts.push(`${existing.length} already present (${existing.join(', ')})`);
  if (skipped.length) parts.push(`${skipped.length} skipped (${skipped.join('; ')})`);
  const summary = `seed accounts: ${parts.length ? parts.join(', ') : 'nothing to do'}`;
  log(`api: ${summary}`);
  return summary;
}

export default seedAccounts;
