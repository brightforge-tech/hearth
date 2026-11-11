// tests/helpers/server.mjs — shared plumbing for the API suites (task t4).
//
// The API is one process that owns a port and a Postgres connection, so the
// honest way to test it is the way the operator starts it: spawn
// `node api/server.mjs --port <n>` with the suite's environment, drive it over
// real HTTP, and kill it afterwards. The process is always reaped in `stop()`,
// and every suite is expected to stop what it started.
//
// The database it is pointed at comes from the suite (normally the shared test
// database run.mjs has already migrated), so nothing here creates or resets a
// schema.

import { spawn } from 'node:child_process';
import http from 'node:http';

const LISTEN_LINE = /api: listening on http:\/\/(\S+):(\d+)/;

// startServer({ root, env, port, args, waitFor }) -> a handle for one API
// process. `env` is layered over a minimal, deliberately explicit environment:
// DATABASE_URL is taken from `databaseUrl` so a stray .env or shell value can
// never point a suite at the wrong cluster.
export function startServer({
  root,
  databaseUrl,
  env = {},
  port = 0,
  host = '127.0.0.1',
  args = [],
  passPortFlag = true,
  waitForMs = 30_000,
} = {}) {
  const childEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    // no .env discovery surprises: the suites say exactly what they mean
    //
    // The start-up seed (api/lib/seed.mjs) is switched off here so a suite's
    // users table holds exactly the fixture rows the suite wrote — the RPC
    // suite counts app_users rows, for instance. Suites that exercise seeding
    // itself (tests/api/auth.test.mjs) pass SEED_ACCOUNTS: '1' to switch it
    // back on. The server's own default stays "seed on": a bare
    // `node api/server.mjs` must always come up with its staff accounts.
    SEED_ACCOUNTS: '0',
    SEED_FORCE_PASSWORD_CHANGE: '0',
    ...env,
  };
  const argv = ['api/server.mjs'];
  if (passPortFlag) argv.push('--port', String(port));
  if (host) argv.push('--host', host);
  argv.push(...args);
  const child = spawn(process.execPath, argv, {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (b) => log.push(String(b)));
  child.stderr.on('data', (b) => log.push(String(b)));

  const handle = {
    child,
    log: () => log.join(''),
    port: null,
    async waitForPort() {
      const deadline = Date.now() + waitForMs;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) {
          throw new Error(`the API process exited early (code ${child.exitCode}):\n${handle.log()}`);
        }
        const m = LISTEN_LINE.exec(handle.log());
        if (m) {
          handle.port = Number(m[2]);
          handle.host = m[1];
          return handle;
        }
        await sleep(50);
      }
      await handle.stop();
      throw new Error(`the API never reported a listening port within ${waitForMs}ms:\n${handle.log()}`);
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) await sleep(50);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    },
  };
  return handle;
}

// request(port, path, opts): one HTTP call, no fetch magic — the suites need
// exact control of method, headers and raw bodies (CORS tests, malformed JSON,
// oversize uploads), so node:http is used directly.
// Resolves {status, headers, body, text, json}. `body` is the raw bytes — the
// storage suite compares an upload against the served bytes, which a utf8 text
// round trip could not prove.
export function request(port, path, { method = 'GET', headers = {}, body, host = '127.0.0.1', timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host, port, path, method, headers: { host: `${host}:${port}`, ...headers }, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const text = raw.toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* not JSON — the caller looks at text */
          }
          resolve({ status: res.statusCode, headers: res.headers, body: raw, text, json });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs}ms: ${method} ${path}`)));
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : Buffer.from(body));
    req.end();
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// serve(app): bind an express application (from api/routes/index.mjs'
// createApp) to an ephemeral port on 127.0.0.1 and hand back {port, close}.
// Used by the suites that exercise the wiring of the app itself — static
// hosting, the SPA fallback, the /api 404, CORS, the error envelope — because
// those need no database and no spawned process.
export async function serve(app, { host = '127.0.0.1' } = {}) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const port = server.address().port;
  return {
    port,
    request: (path, opts) => request(port, path, { host, ...opts }),
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
