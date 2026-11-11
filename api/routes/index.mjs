// api/routes/index.mjs — route registration for the API (task t4).
//
// createApp wires everything into this one function so `api/server.mjs` stays a
// thin startup script. Order matters and is fixed:
//
//   1. request logging            (every request, /api and static alike)
//   2. GET /healthz               (liveness, no session — see W13)
//   3. /api tree:
//        a. CORS from ALLOWED_ORIGINS, never '*'        (api/lib/cors.mjs)
//        b. application/json body parsing               (api/lib/http.mjs)
//        c. the mounted route groups (auth / query / rpc / ... as they land)
//        d. 404 JSON for an unknown /api path
//   4. static dist/ + index.html fallback for non-/api GETs (the SPA)
//   5. the async error handler -> {"error":{"code","message"}}
//
// Which route files exist is discovered at start-up rather than hard-coded: each
// later task (t5 auth, t6 rpc, t7 query, t9 realtime/storage, t10..t12 the
// ported edge functions) drops its file in api/routes/ and this table picks it
// up, without two tasks having to edit the same lines. A file's module must
// export either `router` (an express.Router) or a default factory
// `(deps) => express.Router`.

import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

import { ROOT } from '../lib/env.mjs';
import { corsMiddleware } from '../lib/cors.mjs';
import { errorHandler, jsonBodyParser, notFoundHandler } from '../lib/http.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// The route groups of the plan, in mount order. `file` is relative to api/routes/.
// A task whose file is not written yet is simply skipped here — t5 drops in
// auth.mjs, t6 rpc.mjs, t7 query.mjs, t9 realtime.mjs/storage.mjs, t10..t12 the
// three ported edge functions, and each is picked up by this table on its own.
export const ROUTE_GROUPS = [
  { name: 'auth', file: 'auth.mjs', path: '/api/auth' }, // t5
  { name: 'rpc', file: 'rpc.mjs', path: '/api/rpc' }, // t6
  { name: 'query', file: 'query.mjs', path: '/api/query' }, // t7
  { name: 'realtime', file: 'realtime.mjs', path: '/api/realtime' }, // t9
  { name: 'storage', file: 'storage.mjs', path: '/api/storage' }, // t9
  { name: 'quickbooks-export', file: 'quickbooks-export.mjs', path: '/api/quickbooks-export' }, // t10
  { name: 'send-invoice-email', file: 'send-invoice-email.mjs', path: '/api/send-invoice-email' }, // t11
  { name: 'send-receipt-email', file: 'send-receipt-email.mjs', path: '/api/send-receipt-email' }, // t12
  { name: 'public', file: 'public.mjs', path: '/api/public' }, // public booking requests
  { name: 'booking-requests', file: 'booking-requests.mjs', path: '/api/booking-requests' },
  { name: 'audit', file: 'audit.mjs', path: '/api/audit' },
  { name: 'expenses', file: 'expenses.mjs', path: '/api/expenses' },
];

// trustProxySetting(env): which hops may set X-Forwarded-For (the client IP
// feeds the login throttle and the audit log). Default: loopback and private
// networks — a reverse proxy on the same host or the same Docker network —
// so a client talking to the port directly cannot spoof its address.
// TRUST_PROXY=false trusts nobody; any other value is passed to express.
export function trustProxySetting(env = process.env) {
  const raw = String(env.TRUST_PROXY ?? '').trim();
  if (raw === '') return 'loopback, linklocal, uniquelocal';
  if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false;
  if (['true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

// Baseline browser hardening for every response. The SPA loads only its own
// bundle, so a strict same-origin policy fits.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
}

// createApp({ distDir, routeDir, env, log }): the express application, not yet
// listening. Exported so the tests can build the app with their own environment
// and their own fixture of route files — and so a future embedding (a harness
// that keeps the API in-process) needs no fork.
export async function createApp({
  distDir = join(ROOT, 'dist'),
  routeDir = HERE,
  env = process.env,
  log = console.log,
} = {}) {
  const app = express();
  // The API may sit behind a proxy in deployment; trust the first hop so req.ip
  // and the secure-cookie flag are right.
  app.set('trust proxy', trustProxySetting(env));
  app.disable('x-powered-by');

  app.use(requestLogger(log));
  app.use(securityHeaders);

  // Liveness/readiness: 200 + JSON once the startup sequence has reached
  // "listen" (the sequence only reaches listen after a DB ping, migrations and
  // seeding, so a 200 here means the app is ready — W13).
  app.get('/healthz', (req, res) => {
    res.status(200).type('application/json; charset=utf-8').json({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  // --- the /api tree -------------------------------------------------------
  // Receipt images are the one large JSON body; everything else stays at 1 MB.
  const smallJson = jsonBodyParser();
  const receiptJson = jsonBodyParser({ limit: 12 * 1024 * 1024 });
  app.use('/api', corsMiddleware(), (req, res, next) =>
    (req.path === '/expenses/analyze-receipt' ? receiptJson : smallJson)(req, res, next)
  );
  // Patient data must never sit in a shared or browser cache.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  if (env.HH_TEST_PROBE) app.use('/api/__probe', (await import('./__probe.mjs')).default({ env, log }));
  for (const group of await loadExistingRoutes(routeDir, env, log)) {
    app.use(group.path, group.router);
  }
  // Anything under /api that no route group claimed: JSON, never HTML.
  app.use('/api', notFoundHandler);

  // --- the SPA -------------------------------------------------------------
  // Real files first (hashed assets, favicon, robots.txt...), then index.html
  // for every other non-/api GET so deep links like /billing survive a reload.
  // Caching follows what vite emits: a content-hashed file never changes, so it
  // may be held for a year; everything else, and above all index.html, must be
  // revalidated, or a deploy would not reach a browser that already has it.
  if (existsSync(distDir)) {
    app.use(
      express.static(distDir, {
        index: 'index.html',
        fallthrough: true,
        setHeaders: (res, path) => {
          const rel = relative(distDir, path).replace(/\\/g, '/');
          res.setHeader('Cache-Control', /^assets\//.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache');
        },
      })
    );
  } else {
    log(`api: no build found at ${distDir} — run "npm run build" to serve the SPA`);
  }
  app.use(spaFallback(distDir));

  // Nothing claimed this request (a non-/api POST, a PUT to a page path...):
  // answer with the same JSON 404 the /api tree uses instead of express' HTML
  // page, so no caller ever has to parse HTML out of this service.
  app.use(notFoundHandler);

  app.use(errorHandler({ log }));
  return app;
}

// Request logging: one line per request with the status and duration. Bodies,
// headers and tokens are never logged.
function requestLogger(log) {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      log(`http ${req.method} ${req.originalUrl} ${res.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  };
}

// Deep-link fallback: any GET that is not /api and did not resolve to a static
// file answers with index.html. /api paths never reach here (they are answered
// by notFoundHandler above), so an unknown endpoint stays a JSON 404 and the
// SPA shell is never served for it.
function spaFallback(distDir) {
  const indexFile = join(distDir, 'index.html');
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const path = req.path ?? req.url;
    if (path === '/api' || path.startsWith('/api/')) return next();
    if (!existsSync(indexFile)) {
      return res.status(503).type('text/plain; charset=utf-8').send('The SPA has not been built: run npm run build');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexFile, (err) => {
      if (err && !res.headersSent) next(err);
    });
  };
}

// Imports every route group whose file exists in `routeDir` (skipping the tasks
// not built yet) and normalises what it exports into { path, router }. A file
// that exists but cannot be loaded is a startup failure: serving half the API is
// worse than not starting.
async function loadExistingRoutes(routeDir, env, log) {
  const out = [];
  for (const group of ROUTE_GROUPS) {
    const file = join(routeDir, group.file);
    if (!existsSync(file)) continue;
    let mod;
    try {
      mod = await import(pathToFileURL(file).href);
    } catch (e) {
      e.message = `route group ${group.name} (${group.file}) failed to load: ${e.message}`;
      throw e;
    }
    const made = mod.router ?? (typeof mod.default === 'function' ? mod.default({ env, log }) : mod.default);
    if (!made) throw new Error(`route group ${group.name} (${group.file}) exports neither router nor a default router factory`);
    out.push({ path: group.path, router: made, name: group.name });
  }
  return out;
}
