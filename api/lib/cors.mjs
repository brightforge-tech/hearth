// api/lib/cors.mjs — CORS from an explicit allow-list, never a wildcard (task t4, S27).
//
// The shipped Supabase Edge Functions answered every response with
// `Access-Control-Allow-Origin: *` (supabase/functions/*/index.ts), which is safe
// only while the endpoints do not check who calls them. The ported endpoints do,
// so the origin set comes from ALLOWED_ORIGINS and the response echoes the
// caller's exact origin — a wildcard can never appear, and an origin that is not
// listed gets no CORS headers at all, which is what makes the browser block it.
//
//   ALLOWED_ORIGINS=http://localhost:8787,https://clinic.example
//
// Entries are compared after trimming and lowercasing the host; the value echoed
// back is the caller's origin verbatim.

// ALLOWED_ALLOW_HEADERS / ALLOWED_METHODS are the fixed preflight answers: the
// API's only credentials are the Authorization header and the session cookie,
// and the only bodies are JSON (plus raw uploads, which are same-origin).
export const ALLOW_HEADERS = 'authorization, content-type, x-upsert';
export const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
export const MAX_AGE_SECONDS = '600';

// parseAllowedOrigins(value): the ALLOWED_ORIGINS string -> array of origins.
// Blank entries are ignored; a '*' entry is refused (CORS_WILDCARD_FORBIDDEN),
// because allowing it would mean shipping S27 back in.
export function parseAllowedOrigins(value) {
  const origins = String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.some((o) => o === '*')) {
    const err = new Error('ALLOWED_ORIGINS must not contain "*" — list the exact origins (see .env.example)');
    err.code = 'CORS_WILDCARD_FORBIDDEN';
    throw err;
  }
  return origins;
}

// corsMiddleware(): allow-listed CORS for the /api tree. The allow-list is read
// from process.env on every request, so a deployment or a test that sets
// ALLOWED_ORIGINS before/around start-up is always honoured.
//   * an allowed Origin gets `Access-Control-Allow-Origin: <origin>` (verbatim),
//     `Vary: Origin`, and credentials (the session cookie);
//   * an OPTIONS preflight from an allowed origin is answered 204 here, so the
//     browser gets the answer even for a route that is not mounted yet;
//   * any other Origin — unlisted, malformed, or the literal '*' — gets nothing.
export function corsMiddleware() {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin || typeof origin !== 'string') {
      // No Origin header: a same-origin request or a server-to-server call —
      // nothing for CORS to decide.
      if (req.method === 'OPTIONS') return respond(res, 204);
      return next();
    }
    let allowed;
    try {
      allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS).some((a) => sameOrigin(a, origin));
    } catch (e) {
      return next(e); // a misconfigured ALLOWED_ORIGINS must not be a silent '*'
    }
    if (!allowed) {
      // Unlisted (or unparseable) origin: no CORS headers at all, so the browser
      // blocks the response. A preflight still ends cleanly instead of falling
      // through to the 404/HTML path.
      if (req.method === 'OPTIONS') return respond(res, 204);
      return next();
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', ALLOW_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOW_HEADERS);
      res.setHeader('Access-Control-Max-Age', MAX_AGE_SECONDS);
      return respond(res, 204);
    }
    return next();
  };
}

function respond(res, status) {
  res.status(status).end();
  return res;
}

// Origin strings are scheme://host[:port]; compare case-insensitively on the
// host, exactly on scheme and port (the default port spelled out is treated as
// the same origin, e.g. http://localhost == http://localhost:80).
function sameOrigin(allowed, actual) {
  const a = normaliseOrigin(allowed);
  const b = normaliseOrigin(actual);
  return a !== null && b !== null && a === b;
}

function normaliseOrigin(value) {
  const v = String(value).trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const host = u.hostname.toLowerCase();
    const defaultPort = u.protocol === 'https:' ? '443' : '80';
    const port = u.port || defaultPort;
    return `${u.protocol.toLowerCase()}://${host}:${port}`;
  } catch {
    return null;
  }
}
