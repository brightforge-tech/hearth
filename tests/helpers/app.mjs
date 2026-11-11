// tests/helpers/app.mjs — one Hearth API on a scratch database, for the
// security / audit / booking suites. Seeding is ON (the documented demo
// accounts), forced password change is OFF unless a case switches it on.

import pg from 'pg';

import { clientParams, createScratch, dropScratch } from './db.mjs';
import { request, startServer } from './server.mjs';

export const JWT_SECRET = 'hearth-security-suite-secret-0123456789abcdef';
export const ADMIN = { email: 'admin@example.test', password: 'Admin#2025test' };
export const STAFF = { email: 'staff@example.test', password: 'Staff#2025test' };

let counter = 0;

export async function withHearth({ root, testUrl, env = {} }, fn) {
  const suffix = `_sec${process.pid}_${++counter}`;
  const dsn = await createScratch(testUrl, suffix);
  const handle = startServer({
    root,
    databaseUrl: dsn,
    env: { JWT_SECRET, SEED_ACCOUNTS: '1', SEED_FORCE_PASSWORD_CHANGE: '0', ALLOWED_ORIGINS: 'http://127.0.0.1', ...env },
  });
  const db = new pg.Client(clientParams(dsn, decodeURIComponent(new URL(dsn).pathname.slice(1))));
  try {
    await handle.waitForPort();
    await db.connect();
    const call = (path, { method = 'GET', body, token, headers = {} } = {}) =>
      request(handle.port, path, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
    const api = {
      db,
      port: handle.port,
      log: handle.log,
      call,
      post: (path, body, token, headers) => call(path, { method: 'POST', body: body ?? {}, token, headers }),
      login: (email, password, headers) => call('/api/auth/login', { method: 'POST', body: { email, password }, headers }),
      async token(who = ADMIN) {
        const r = await api.login(who.email, who.password);
        if (r.status !== 200) throw new Error(`login ${who.email} -> ${r.status} ${r.text}`);
        return r.json.access_token;
      },
      query: (body, token) => call('/api/query', { method: 'POST', body, token }),
      // a user with a role, created through the admin endpoint (forced change
      // cleared so the account can be used straight away)
      async createUser(adminToken, email, role, password = 'Correct-Horse-Battery-9') {
        const r = await api.post('/api/auth/admin/users', { email, password, role }, adminToken);
        if (r.status !== 200) throw new Error(`create ${email} -> ${r.status} ${r.text}`);
        await db.query('update public.app_users set must_change_password = false where email = $1', [email]);
        return { id: r.json.user.id, email, password };
      },
      audit: async (where = 'true', params = []) => (await db.query(`select * from public.audit_log where ${where} order by id`, params)).rows,
    };
    return await fn(api);
  } finally {
    try {
      await db.end();
    } catch {
      /* already closed */
    }
    await handle.stop();
    await dropScratch(testUrl, suffix);
  }
}

export function expectStatus(r, status, code, label = '') {
  if (r.status !== status) throw new Error(`${label} expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`);
  if (code && r.json?.error?.code !== code) throw new Error(`${label} expected code ${code}, got ${r.text.slice(0, 300)}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
