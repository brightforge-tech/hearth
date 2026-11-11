// tests/helpers/http.mjs — the HTTP side of the contract/parity harness
// (task t14).
//
// Three things every suite in tests/contract and tests/parity needs, in one
// place:
//
//   * startTestApp() — the app booted the way the operator boots it
//     (`node api/server.mjs --port 0`), pointed at the suite's scratch
//     database, on an ephemeral port, with the environment the milestones pin
//     (JWT secret, seeding off so the suite owns the users table);
//   * startResendStub() — a local stand-in for the Resend API that records
//     every payload the endpoints would have sent and answers
//     {"id":"re_stub_1"}, so "the endpoint mailed exactly this HTML from
//     exactly this sender" is asserted on bytes the API actually wrote to a
//     socket, and RESEND_API_BASE keeps the real provider out of the test run;
//   * makeTokens() — session tokens for the callers the authorization matrix
//     runs: anonymous (no Authorization header at all), 'user'-role staff, and
//     admin. Tokens are signed with the same api/lib/tokens.mjs the login
//     route uses; the caller rows must exist in app_users/user_roles (see
//     seedUsers in ./db.mjs), because session.mjs re-reads roles on every
//     request exactly like the live policies did.

import http from 'node:http';

import { signToken } from '../../api/lib/tokens.mjs';
import { request, startServer } from './server.mjs';

// The senders the contract suites boot the app with. The milestones' sender
// fix (S10/W48) is that these come from the environment and the legacy
// addresses never appear; the contract tests assert the stub received exactly
// these, and no case may hardcode the legacy senders anywhere.
export const CONTRACT_SENDERS = Object.freeze({
  RESEND_FROM_INVOICE: 'Harbourview Medical Centre <invoices@clinic.example>',
  RESEND_FROM_RECEIPT: 'Harbourview Medical Centre <receipts@clinic.example>',
});

// --- the Resend stub -----------------------------------------------------------

// startResendStub({ id }) -> { port, baseUrl, requests, setResponder, reset,
// close }. Every request is recorded in arrival order as
// { method, url, headers, raw, json } and answered 200 {"id": <id>} — by
// default 're_stub_1', the id the contract tests expect back as emailId.
// setResponder(record => { status, body }) overrides one behaviour (e.g. a
// 4xx provider) without touching the recording.
export async function startResendStub({ id = 're_stub_1' } = {}) {
  const requests = [];
  let responder = () => ({ status: 200, body: { id } });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        /* the caller sent non-JSON — still recorded */
      }
      const record = { method: req.method, url: req.url, headers: req.headers, raw, json };
      requests.push(record);
      const out = responder(record) ?? {};
      res.statusCode = out.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(out.body ?? { id }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    setResponder(fn) {
      responder = fn;
    },
    reset() {
      requests.length = 0;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- the app -------------------------------------------------------------------

// startTestApp({ root, databaseUrl, jwtSecret, env, resend }) -> the running
// app plus its stub. `databaseUrl` is the suite's scratch DSN; the server's
// own start-up migrates it before the port opens.
export async function startTestApp({ root, databaseUrl, jwtSecret, env = {}, resend = true } = {}) {
  if (!jwtSecret) throw new Error('startTestApp needs a jwtSecret (tokens.mjs fails closed without JWT_SECRET)');
  const stub = resend ? await startResendStub() : null;
  const handle = startServer({
    root,
    databaseUrl,
    env: {
      JWT_SECRET: jwtSecret,
      // the suites seed their own users; the start-up seed must not surprise them
      SEED_ACCOUNTS: '0',
      ...(stub
        ? {
            RESEND_API_BASE: stub.baseUrl,
            RESEND_API_KEY: 'rk_contract_stub_key',
            ...CONTRACT_SENDERS,
          }
        : {}),
      ...env,
    },
  });
  try {
    await handle.waitForPort();
  } catch (e) {
    if (stub) await stub.close();
    throw e;
  }

  const app = {
    port: handle.port,
    log: () => handle.log(),
    resend: stub,
    // request(): the raw node:http call (exact headers/bodies; raw bytes back)
    request: (path, opts) => request(handle.port, path, opts),
    // api(path, body, token): the JSON call shape the suites use most —
    // POST + application/json + Bearer (omitted for a null/undefined token,
    // which is how the anonymous allow-list cases are driven).
    async api(path, body, token, { method = 'POST', headers = {} } = {}) {
      return request(handle.port, path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    async stop() {
      await handle.stop();
      if (stub) await stub.close();
    },
  };
  return app;
}

// --- tokens ---------------------------------------------------------------------

// ANONYMOUS: the caller with no session. Passing it as the token of app.api /
// makeTokens leaves the Authorization header off, which is exactly the
// anonymous traffic the allow-list serves.
export const ANONYMOUS = null;

// makeTokens(jwtSecret, users) -> { [key]: token, anonymous: null }.
// users are { key, id, email } — the rows the suite seeded with seedUsers.
// The 'anonymous' key is part of the map so a table-driven matrix can look up
// every caller the same way.
export function makeTokens(jwtSecret, users) {
  const tokens = { anonymous: ANONYMOUS };
  for (const user of users) {
    tokens[user.key] = signToken({ sub: user.id, email: user.email }, { secret: jwtSecret });
  }
  return tokens;
}
