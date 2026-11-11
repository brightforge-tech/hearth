// tests/api/cors.test.mjs — api/lib/cors.mjs: the allow-list that replaces the
// shipped functions' `Access-Control-Allow-Origin: *` (task t4, S27, W19).
//
// Both halves matter: an origin in ALLOWED_ORIGINS is echoed back verbatim with
// the headers a browser preflight asks for, and an origin outside it gets no
// CORS headers at all — while nothing on /api ever answers with a wildcard.

import { createApp } from '../../api/routes/index.mjs';
import { ALLOW_HEADERS, ALLOW_METHODS, corsMiddleware, parseAllowedOrigins } from '../../api/lib/cors.mjs';
import { serve } from '../helpers/server.mjs';

// withCors({allowed, ...}, fn): the app with ALLOWED_ORIGINS pinned for the
// duration of the case (the middleware reads the environment per request).
async function withCors(fn, { allowed = 'http://localhost:8080' } = {}) {
  const saved = process.env.ALLOWED_ORIGINS;
  process.env.ALLOWED_ORIGINS = allowed;
  const app = await createApp({ distDir: '/nonexistent-dist-for-cors-test', log: () => {} });
  const h = await serve(app);
  try {
    await fn(h);
  } finally {
    await h.close();
    if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = saved;
  }
}

const WILDCARD = 'access-control-allow-origin';

export default [
  {
    name: 'parseAllowedOrigins: splits and trims, ignores blanks, and refuses a wildcard',
    async fn() {
      const list = parseAllowedOrigins(' http://localhost:8787 , https://clinic.example , ');
      if (list.join('|') !== 'http://localhost:8787|https://clinic.example') throw new Error(list.join('|'));
      if (parseAllowedOrigins('').length !== 0) throw new Error('an empty allow-list must be empty');
      if (parseAllowedOrigins(undefined).length !== 0) throw new Error('an unset allow-list must be empty');
      for (const bad of ['*', 'https://a.test, *', ' , *']) {
        let caught = null;
        try {
          parseAllowedOrigins(bad);
        } catch (e) {
          caught = e;
        }
        if (!caught || caught.code !== 'CORS_WILDCARD_FORBIDDEN') {
          throw new Error(`ALLOWED_ORIGINS=${JSON.stringify(bad)} must be refused, got ${caught?.code ?? 'accepted'}`);
        }
      }
    },
  },
  {
    name: 'OPTIONS /api/query from an allowed origin is answered, with the origin verbatim and the API headers',
    async fn() {
      await withCors(async (h) => {
        const r = await h.request('/api/query', {
          method: 'OPTIONS',
          headers: {
            origin: 'http://localhost:8080',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization,content-type',
          },
        });
        if (r.status !== 204) throw new Error(`preflight -> ${r.status}: ${r.text}`);
        const echo = r.headers[WILDCARD];
        if (echo !== 'http://localhost:8080') throw new Error(`Allow-Origin is ${JSON.stringify(echo)}, expected the origin verbatim`);
        if (echo === '*') throw new Error('the response uses a wildcard origin');
        const headers = (r.headers['access-control-allow-headers'] ?? '').toLowerCase();
        if (!headers.includes('authorization') || !headers.includes('content-type')) {
          throw new Error(`Allow-Headers must list authorization and content-type, got ${JSON.stringify(headers)}`);
        }
        if (headers !== ALLOW_HEADERS) throw new Error(`Allow-Headers is ${headers}`);
        if (r.headers['access-control-allow-methods'] !== ALLOW_METHODS) {
          throw new Error(`Allow-Methods is ${r.headers['access-control-allow-methods']}`);
        }
        if (r.headers.vary !== 'Origin') throw new Error(`Vary is ${JSON.stringify(r.headers.vary)}`);
        if (r.headers['access-control-allow-credentials'] !== 'true') throw new Error('credentials must be allowed for the session cookie');
        if (!/^\d+$/.test(r.headers['access-control-max-age'] ?? '')) throw new Error('the preflight answer must be cacheable');
      });
    },
  },
  {
    name: 'an Origin outside ALLOWED_ORIGINS gets no Access-Control-Allow-Origin at all',
    async fn() {
      await withCors(async (h) => {
        const preflight = await h.request('/api/query', {
          method: 'OPTIONS',
          headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
        });
        if (preflight.headers[WILDCARD] !== undefined) {
          throw new Error(`unlisted origin got Allow-Origin ${preflight.headers[WILDCARD]}`);
        }
        if (preflight.headers['access-control-allow-methods'] !== undefined) throw new Error('unlisted origin got an allow-methods answer');
        for (const [method, path] of [['GET', '/api/auth/session'], ['POST', '/api/query'], ['DELETE', '/api/storage/signatures/x.png']]) {
          const r = await h.request(path, { method, headers: { origin: 'http://evil.example', 'content-length': '0' } });
          if (r.headers[WILDCARD] !== undefined) throw new Error(`${method} ${path} from a foreign origin got Allow-Origin ${r.headers[WILDCARD]}`);
        }
      });
    },
  },
  {
    name: 'an allowed origin is echoed on real responses too, including errors and 404s',
    async fn() {
      await withCors(async (h) => {
        const ok = await h.request('/healthz');
        if (ok.status !== 200) throw new Error(`healthz -> ${ok.status}`);
        // /healthz is not part of the /api CORS surface; that is deliberate, but
        // it must never carry a wildcard either.
        if (ok.headers[WILDCARD] === '*') throw new Error('/healthz carries a wildcard origin');

        const missing = await h.request('/api/whatever', { headers: { origin: 'http://localhost:8080' } });
        if (missing.status !== 404) throw new Error(`unknown /api -> ${missing.status}`);
        if (missing.headers[WILDCARD] !== 'http://localhost:8080') {
          throw new Error(`a 404 from an allowed origin must still be readable by it, got ${missing.headers[WILDCARD]}`);
        }
      });
    },
  },
  {
    name: 'no /api response anywhere sets Access-Control-Allow-Origin: *',
    async fn() {
      // With an explicit allow-list, the literal '*' Origin is not in it, so the
      // only way a wildcard could appear on the wire is a hard-coded '*'.
      await withCors(
        async (h) => {
          const calls = [
            ['GET', '/healthz', undefined],
            ['GET', '/api/nope', 'http://localhost:8080'],
            ['GET', '/api/nope', '*'],
            ['POST', '/api/query', '*'],
            ['OPTIONS', '/api/query', '*'],
            ['POST', '/api/auth/login', 'https://clinic.example'],
            ['GET', '/billing', 'http://localhost:8080'],
            ['GET', '/', '*'],
          ];
          for (const [method, path, origin] of calls) {
            const headers = origin ? { origin, 'content-length': '0' } : { 'content-length': '0' };
            const r = await h.request(path, { method, headers });
            if (r.headers[WILDCARD] === '*') throw new Error(`${method} ${path} Origin=${origin} answered with a wildcard`);
          }
        },
        { allowed: 'http://localhost:8080,https://clinic.example' }
      );
    },
  },
  {
    name: "origin comparison ignores the host case and a spelled-out default port",
    async fn() {
      await withCors(
        async (h) => {
          const echoed = await h.request('/api/nope', { headers: { origin: 'http://localhost:8080' } });
          if (echoed.headers[WILDCARD] !== 'http://localhost:8080') throw new Error(`case-insensitive match failed: ${echoed.headers[WILDCARD]}`);
          const otherPort = await h.request('/api/nope', { headers: { origin: 'http://localhost:8081' } });
          if (otherPort.headers[WILDCARD] !== undefined) throw new Error('a different port must not match');
          const scheme = await h.request('/api/nope', { headers: { origin: 'https://localhost:8080' } });
          if (scheme.headers[WILDCARD] !== undefined) throw new Error('a different scheme must not match');
        },
        { allowed: 'http://Localhost:8080' }
      );
      // an unset ALLOWED_ORIGINS allows nothing
      const saved = process.env.ALLOWED_ORIGINS;
      delete process.env.ALLOWED_ORIGINS;
      const app = await createApp({ distDir: '/nonexistent-dist-for-cors-test', log: () => {} });
      const h = await serve(app);
      try {
        const r = await h.request('/api/nope', { headers: { origin: 'http://localhost:8080' } });
        if (r.headers[WILDCARD] !== undefined) throw new Error(`unset ALLOWED_ORIGINS allowed ${r.headers[WILDCARD]}`);
      } finally {
        await h.close();
        if (saved !== undefined) process.env.ALLOWED_ORIGINS = saved;
      }
    },
  },
  {
    name: 'a request without an Origin header is served as usual (same-origin and server-to-server)',
    async fn() {
      await withCors(async (h) => {
        const r = await h.request('/api/nope');
        if (r.status !== 404) throw new Error(`no-origin /api request -> ${r.status}`);
        if (r.headers[WILDCARD] !== undefined) throw new Error('a request without an Origin must not get CORS headers');
        const pre = await h.request('/api/query', { method: 'OPTIONS', headers: { 'content-length': '0' } });
        if (pre.status !== 204) throw new Error(`no-origin preflight -> ${pre.status}`);
        if (pre.headers[WILDCARD] !== undefined) throw new Error('a preflight without an Origin must not get CORS headers');
      });
    },
  },
  {
    name: 'a misconfigured ALLOWED_ORIGINS=* fails loudly instead of silently allowing the world',
    async fn() {
      const saved = process.env.ALLOWED_ORIGINS;
      process.env.ALLOWED_ORIGINS = '*';
      try {
        const err = await new Promise((resolve) => {
          corsMiddleware()({ method: 'GET', headers: { origin: 'http://anyone.test' } }, {}, resolve);
        });
        if (!err || err.code !== 'CORS_WILDCARD_FORBIDDEN') throw new Error(`expected the wildcard error, got ${err?.code ?? 'next() without error'}`);
      } finally {
        if (saved === undefined) delete process.env.ALLOWED_ORIGINS;
        else process.env.ALLOWED_ORIGINS = saved;
      }
    },
  },
];
