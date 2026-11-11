// tests/api/routing.test.mjs — api/routes/index.mjs: the shape of the service
// (task t4). Built with the app's own createApp() over a fixture build in dist/,
// because every assertion here is about the HTTP surface itself: the JSON error
// contract, static hosting with the SPA fallback, CORS from ALLOWED_ORIGINS, and
// the async error handler. The startup sequence around it is tests/api/startup.test.mjs.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../../api/routes/index.mjs';
import { serve } from '../helpers/server.mjs';

// A fixture "build": an index.html plus a hashed asset, in a throwaway
// directory, so the tests do not depend on the repo's dist/ being built.
function fixtureDist() {
  const dir = mkdtempSync(join(tmpdir(), 'hh-dist-'));
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Harbourview Medical Center</title><div id="root"></div>');
  writeFileSync(join(dir, 'assets', 'index-abc123.css'), 'body{margin:0}');
  writeFileSync(join(dir, 'robots.txt'), 'User-agent: *\n');
  return dir;
}

// withApp({env, dist}): build the app and give it an ephemeral port.
async function withApp(fn, { env = {}, dist, logs = [] } = {}) {
  const distDir = dist ?? fixtureDist();
  const created = dist === undefined;
  const app = await createApp({ distDir, env: { ...process.env, ...env }, log: (line) => logs.push(String(line)) });
  const h = await serve(app);
  try {
    await fn(h, { distDir });
  } finally {
    await h.close();
    if (created) rmSync(distDir, { recursive: true, force: true });
  }
}

const ALLOWED = 'http://localhost:8080';

export default [
  {
    name: 'GET /healthz answers 200 with JSON, without a session',
    async fn() {
      await withApp(async (h) => {
        const r = await h.request('/healthz');
        if (r.status !== 200) throw new Error(`GET /healthz -> ${r.status}`);
        if (!/^application\/json/.test(r.headers['content-type'] ?? '')) throw new Error(`content-type ${r.headers['content-type']}`);
        if (r.json?.status !== 'ok' || typeof r.json.uptime !== 'number') throw new Error(`body ${r.text}`);
      });
    },
  },
  {
    name: 'an unknown /api path is a JSON 404, for every verb, never the HTML page',
    async fn() {
      await withApp(async (h) => {
        for (const [method, path] of [
          ['GET', '/api/nope'],
          ['POST', '/api/nope'],
          ['PUT', '/api/query'],
          ['PATCH', '/api/auth/whatever'],
          ['DELETE', '/api/storage/signatures/x.png'],
        ]) {
          const r = await h.request(path, { method, headers: { 'content-length': '0' } });
          if (r.status !== 404) throw new Error(`${method} ${path} -> ${r.status}: ${r.text}`);
          if (!/^application\/json/.test(r.headers['content-type'] ?? '')) {
            throw new Error(`${method} ${path} content-type ${r.headers['content-type']}: ${r.text}`);
          }
          if (!r.json?.error?.message || !r.json?.error?.code) {
            throw new Error(`${method} ${path} body is not the error envelope: ${r.text}`);
          }
          if (!r.json.error.message.includes(method) || !r.json.error.message.includes(path)) {
            throw new Error(`${method} ${path} message does not name the call: ${r.json.error.message}`);
          }
        }
        // /api itself, and a path that only starts with the same letters: the
        // boundary is the /api path prefix, so /apifoo is a client-side route
        // and belongs to the SPA.
        const root = await h.request('/api');
        if (root.status !== 404) throw new Error(`GET /api -> ${root.status}`);
        const near = await h.request('/apifoo');
        if (near.status !== 200 || !near.text.includes('id="root"')) {
          throw new Error(`GET /apifoo should reach the SPA shell, got ${near.status}: ${near.text.slice(0, 60)}`);
        }
      });
    },
  },
  {
    name: 'a route that throws (sync, async, or ApiError) reaches the async error handler as JSON',
    async fn() {
      const logs = [];
      await withApp(
        async (h) => {
          const boom = await h.request('/api/__probe/boom');
          if (boom.status !== 500) throw new Error(`throw -> ${boom.status}: ${boom.text}`);
          if (!boom.text.includes('"Internal server error"')) throw new Error(`500 must be generic: ${boom.text}`);
          if (boom.text.includes('must not reach the caller')) throw new Error(`the internal message leaked: ${boom.text}`);
          if (boom.json?.error?.code !== 'INTERNAL_ERROR') throw new Error(`code ${boom.json?.error?.code}`);

          const rej = await h.request('/api/__probe/reject');
          if (rej.status !== 400 || rej.json?.error?.message !== 'rejected on purpose') {
            throw new Error(`rejected async handler -> ${rej.status}: ${rej.text}`);
          }
          const apiErr = await h.request('/api/__probe/api-error');
          if (apiErr.status !== 409 || apiErr.json?.error?.code !== 'DUPLICATE_ROW') {
            throw new Error(`ApiError -> ${apiErr.status} ${apiErr.text}`);
          }
        },
        { env: { HH_TEST_PROBE: '1' }, logs }
      );
      // the real cause is logged server-side even though the caller only sees
      // 'Internal server error'
      const logged = logs.filter((l) => l.includes('a server-side fault'));
      if (!logged.length) throw new Error('the internal cause was never logged');
    },
  },
  {
    name: 'the JSON body parser: parses application/json, leaves other content types alone, reports 400/413 as JSON',
    async fn() {
      await withApp(
        async (h) => {
          const good = await h.request('/api/__probe/body', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"email":"a@b.test"}',
          });
          if (good.status !== 200 || good.json?.parsed?.email !== 'a@b.test' || good.json?.jsonContentType !== true) {
            throw new Error(`application/json -> ${good.status} ${good.text}`);
          }
          const charset = await h.request('/api/__probe/body', {
            method: 'POST',
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: '{"n":1}',
          });
          if (charset.json?.parsed?.n !== 1) throw new Error(`charset form -> ${charset.text}`);

          const form = await h.request('/api/__probe/body', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'user=alice&pass=secret',
          });
          if (form.json?.parsed !== null || form.json?.jsonContentType !== false) {
            throw new Error(`a form body must not be auto-parsed as JSON: ${form.text}`);
          }
          // ...but the route can still read JSON off the raw stream (the scripted-login path)
          const raw = await h.request('/api/__probe/read-json', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: '{"user":"alice"}',
          });
          if (raw.json?.read?.user !== 'alice') throw new Error(`readJsonBody on a form body -> ${raw.text}`);

          const empty = await h.request('/api/__probe/read-json', { method: 'POST', headers: { 'content-length': '0' } });
          if (empty.status !== 200 || JSON.stringify(empty.json?.read) !== '{}') {
            throw new Error(`an empty body must read as {}, got ${empty.status} ${empty.text}`);
          }

          const bad = await h.request('/api/__probe/body', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"broken":',
          });
          if (bad.status !== 400 || bad.json?.error?.code !== 'INVALID_JSON') throw new Error(`malformed JSON -> ${bad.status} ${bad.text}`);

          const array = await h.request('/api/__probe/body', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '[1,2,3]',
          });
          if (array.status !== 400) throw new Error(`a JSON array body -> ${array.status} ${array.text}`);

          // the probe's readJsonBody caps at 1024 bytes: the cap must bite as a 413
          const big = await h.request('/api/__probe/read-json', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: 'x'.repeat(2048),
          });
          if (big.status !== 413 || big.json?.error?.code !== 'PAYLOAD_TOO_LARGE') throw new Error(`oversize body -> ${big.status} ${big.text}`);
        },
        { env: { HH_TEST_PROBE: '1' } }
      );
    },
  },
  {
    name: 'static files come from dist/, and every other non-/api GET answers with index.html',
    async fn() {
      await withApp(async (h, { distDir }) => {
        const home = await h.request('/');
        if (home.status !== 200 || !home.text.includes('Harbourview Medical Center')) {
          throw new Error(`GET / -> ${home.status}: ${home.text.slice(0, 80)}`);
        }
        if (!/^text\/html/.test(home.headers['content-type'] ?? '')) throw new Error(`content-type ${home.headers['content-type']}`);

        const asset = await h.request('/assets/index-abc123.css');
        if (asset.status !== 200 || asset.text !== 'body{margin:0}') throw new Error(`asset -> ${asset.status}: ${asset.text}`);
        if (!/^text\/css/.test(asset.headers['content-type'] ?? '')) throw new Error(`asset content-type ${asset.headers['content-type']}`);
        // a content-hashed file can be held forever...
        if (!/immutable/.test(asset.headers['cache-control'] ?? '')) throw new Error(`hashed asset is not immutable: ${asset.headers['cache-control']}`);
        // ...but the shell must always be revalidated, or a deploy never lands
        const homeAgain = await h.request('/');
        if (!/no-cache/.test(homeAgain.headers['cache-control'] ?? '')) throw new Error(`index.html is cacheable: ${homeAgain.headers['cache-control']}`);

        const robots = await h.request('/robots.txt');
        if (robots.status !== 200 || !robots.text.startsWith('User-agent')) throw new Error(`robots.txt -> ${robots.status}`);

        // deep links: /billing, /admin/settings reloads must reach the SPA shell
        for (const path of ['/billing', '/admin/settings', '/queue']) {
          const deep = await h.request(path);
          if (deep.status !== 200 || !deep.text.includes('id="root"')) throw new Error(`${path} -> ${deep.status}: ${deep.text.slice(0, 80)}`);
          if ((deep.headers['cache-control'] ?? '') !== 'no-cache') {
            throw new Error(`${path} must not be cached by a browser: cache-control ${deep.headers['cache-control']}`);
          }
        }
        // a GET for a file that does not exist falls back to the shell too —
        // that is what makes a client-side route with an extension work
        const missing = await h.request('/does-not-exist');
        if (missing.status !== 200 || !missing.text.includes('id="root"')) throw new Error(`missing file -> ${missing.status}`);

        // the real build is served when it exists
        if (existsSync(join(distDir, 'index.html'))) {
          const real = await h.request('/');
          if (real.status !== 200) throw new Error('real dist is not served');
        }
      });
    },
  },
  {
    name: 'the SPA fallback never swallows an /api path',
    async fn() {
      await withApp(async (h) => {
        // /api/... must never be answered with index.html. (/api/auth/session
        // was still unmounted when this case was written; with auth.mjs landed
        // it answers 401, so the definitely-unmounted subpath is probed here,
        // plus the session route itself as a mounted path that must still
        // answer JSON, never the shell.)
        for (const path of ['/api', '/api/', '/api/auth/session/nope', '/api/query']) {
          const r = await h.request(path);
          if (r.text.includes('id="root"')) throw new Error(`${path} was answered with the SPA shell`);
          if (r.status !== 404 || !r.json?.error) throw new Error(`${path} -> ${r.status}: ${r.text}`);
        }
        const session = await h.request('/api/auth/session');
        if (session.text.includes('id="root"')) throw new Error('/api/auth/session was answered with the SPA shell');
        if (session.status !== 401 || !session.json?.error) throw new Error(`/api/auth/session -> ${session.status}: ${session.text}`);
        // a non-GET to a page path is a JSON 404 as well, not HTML
        const post = await h.request('/billing', { method: 'POST', headers: { 'content-length': '0' } });
        if (post.status !== 404 || !post.json?.error) throw new Error(`POST /billing -> ${post.status}: ${post.text}`);
      });
    },
  },
  {
    name: 'a route file that appears in api/routes/ is mounted at its planned path, and its misses still 404 as JSON',
    async fn() {
      // A fixture api/routes/ holding one group file, so the loader is exercised
      // before task t5 drops in the real auth.mjs.
      const dir = mkdtempSync(join(tmpdir(), 'hh-routes-'));
      // CORS reads the environment per request, so pin it for this case.
      const savedOrigins = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = 'http://localhost:8080';
      // a default factory, and a named `router` export — the two shapes the
      // loader accepts. They are plain middleware, so no imports are needed
      // from a directory that has no node_modules of its own.
      writeFileSync(
        join(dir, 'auth.mjs'),
        [
          'export default function authRouter({ env }) {',
          '  return (req, res, next) => {',
          "    if (req.path === '/ping') {",
          "      res.status(200).type('application/json').json({ pong: env.HH_FIXTURE_FLAG ?? null });",
          '      return;',
          '    }',
          '    next();',
          '  };',
          '}',
          '',
        ].join('\n')
      );
      writeFileSync(
        join(dir, 'rpc.mjs'),
        [
          'export const router = (req, res, next) => {',
          "  if (req.path === '/ping') {",
          "    res.status(200).type('application/json').json({ rpc: true });",
          '    return;',
          '  }',
          '  next();',
          '};',
          '',
        ].join('\n')
      );
      try {
        const app = await createApp({
          distDir: fixtureDist(),
          routeDir: dir,
          env: { ...process.env, HH_FIXTURE_FLAG: 'set' },
          log: () => {},
        });
        const h = await serve(app);
        try {
          const hit = await h.request('/api/auth/ping');
          if (hit.status !== 200 || hit.json?.pong !== 'set') throw new Error(`default-factory group did not run: ${hit.status} ${hit.text}`);
          const named = await h.request('/api/rpc/ping');
          if (named.status !== 200 || named.json?.rpc !== true) throw new Error(`named-router group did not run: ${named.status} ${named.text}`);
          // a request the group declines falls through to the shared JSON 404,
          // exactly like an unknown path today
          for (const path of ['/api/auth/nope', '/api/whatever']) {
            const miss = await h.request(path);
            if (miss.status !== 404 || !miss.json?.error) throw new Error(`${path} -> ${miss.status}: ${miss.text}`);
          }
          // CORS still fronts a mounted group
          const pre = await h.request('/api/auth/ping', { method: 'OPTIONS', headers: { origin: 'http://localhost:8080' } });
          if (pre.status !== 204 || pre.headers['access-control-allow-origin'] !== 'http://localhost:8080') {
            throw new Error(`preflight to a mounted group -> ${pre.status}`);
          }
        } finally {
          await h.close();
        }
      } finally {
        if (savedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = savedOrigins;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'a route file that cannot be loaded stops the start instead of serving a half-mounted API',
    async fn() {
      const dir = mkdtempSync(join(tmpdir(), 'hh-routes-bad-'));
      writeFileSync(join(dir, 'query.mjs'), 'this is not valid javascript;');
      try {
        let caught = null;
        try {
          await createApp({ distDir: fixtureDist(), routeDir: dir, env: { ...process.env }, log: () => {} });
        } catch (e) {
          caught = e;
        }
        if (!caught || !/query\.mjs/.test(caught.message)) {
          throw new Error(`expected the load of query.mjs to fail startup, got ${caught?.message ?? 'no error'}`);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'every request is logged with method, path, status and duration, without bodies or headers',
    async fn() {
      const logs = [];
      await withApp(
        async (h) => {
          await h.request('/healthz');
          await h.request('/api/nope');
          await h.request('/api/__probe/body', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"password":"hunter2"}',
          });
        },
        { env: { HH_TEST_PROBE: '1' }, logs }
      );
      const lines = logs.filter((l) => l.startsWith('http '));
      const want = ['http GET /healthz 200', 'http GET /api/nope 404', 'http POST /api/__probe/body 200'];
      for (const w of want) {
        if (!lines.some((l) => l.startsWith(w))) throw new Error(`missing log line for ${w}: ${JSON.stringify(lines)}`);
      }
      if (!lines.every((l) => /\d+\.\d+ms$/.test(l))) throw new Error(`a log line has no duration: ${JSON.stringify(lines)}`);
      if (logs.some((l) => l.includes('hunter2'))) throw new Error('a request body reached the log');
      if (logs.some((l) => /content-type/i.test(l))) throw new Error('request headers reached the log');
    },
  },
];
