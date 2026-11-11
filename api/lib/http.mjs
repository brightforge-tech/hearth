// api/lib/http.mjs — the HTTP plumbing every route shares (task t4).
//
//   ApiError        — an error that carries the response status (and optional
//                     machine-readable code) the error handler should answer with;
//   sendJson        — the one place a JSON response is written;
//   jsonBodyParser  — express-style middleware that parses an application/json
//                     body and records whether the content type really said
//                     application/json (task t5's CSRF rule needs that flag);
//   readJsonBody    — parse a JSON body from the raw stream for routes whose
//                     content type is not application/json (form logins...);
//   readRawBody     — raw bytes for the storage uploads (task t9);
//   asyncHandler    — wraps an async route so a rejection reaches the error
//                     handler instead of hanging the request;
//   notFoundHandler / errorHandler — the JSON contract for everything else:
//                     {"error":{"code":string,"message":string}}.
//
// The three ported edge functions (tasks t10..t12) keep their legacy response
// bodies; they answer with sendJson(status, legacyShape) and never use the
// envelope helpers here.

// An error whose status/code the error handler turns straight into a response.
export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'ApiError';
    this.status = Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
    this.code = code ?? codeForStatus(this.status);
  }
}

// Default machine-readable codes for the envelope; routes may pass their own.
export function codeForStatus(status) {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 405: return 'METHOD_NOT_ALLOWED';
    case 409: return 'CONFLICT';
    case 413: return 'PAYLOAD_TOO_LARGE';
    case 415: return 'UNSUPPORTED_MEDIA_TYPE';
    default: return 'INTERNAL_ERROR';
  }
}

// sendJson(res, status, value): the single JSON writer. `charset=utf-8` is
// explicit so error text and JSON payloads are unambiguous on the wire.
export function sendJson(res, status, value) {
  if (res.headersSent) return res;
  res.status(status).type('application/json; charset=utf-8').json(value);
  return res;
}

// The error envelope every /api failure uses (legacy ports excepted).
export function errorBody(err) {
  const status = err instanceof ApiError ? err.status : 500;
  const code = err.code ?? codeForStatus(status);
  const message = status >= 500 ? 'Internal server error' : err.message;
  return { error: { code, message } };
}

// jsonBodyParser({limit}): parse an application/json request body into req.body
// and set req.jsonContentType = true when the request really said
// `Content-Type: application/json` (a cross-site form cannot set that header,
// which is what task t5's mutation guard relies on). Other content types are
// passed through untouched for readJsonBody()/express.raw() to handle.
// Malformed JSON is a 400 and an oversized body a 413, both as ApiError, so the
// error handler answers them with the same envelope as everything else.
export function jsonBodyParser({ limit = 1_048_576 } = {}) {
  return async function jsonBody(req, res, next) {
    const ct = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    req.jsonContentType = ct === 'application/json' || /^application\/[a-z0-9.+-]+\+json$/i.test(ct);
    if (!req.jsonContentType || !hasBody(req)) return next();
    try {
      const raw = await readRawBody(req, limit);
      req.rawBody = raw;
      req.body = raw.length === 0 ? {} : parseJsonObject(raw);
      next();
    } catch (e) {
      next(e);
    }
  };
}

function hasBody(req) {
  const len = req.headers['content-length'];
  if (len !== undefined) return Number(len) > 0;
  return req.headers['transfer-encoding'] !== undefined;
}

function parseJsonObject(raw) {
  let value;
  try {
    value = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new ApiError(400, 'Request body is not valid JSON', 'INVALID_JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'JSON body must be an object', 'INVALID_JSON');
  }
  return value;
}

// readJsonBody(req, {limit}): JSON body from whatever is available — the value
// jsonBodyParser parsed for an application/json request, otherwise the raw
// stream (form logins and scripted callers post other content types).
// A body-less request resolves to {}; anything unparseable is a 400.
export async function readJsonBody(req, { limit = 1_048_576 } = {}) {
  if (req.body !== undefined && !Buffer.isBuffer(req.body) && !(typeof req.body === 'string')) {
    if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new ApiError(400, 'JSON body must be an object', 'INVALID_JSON');
    }
    return req.body;
  }
  if (typeof req.body === 'string' && req.body.trim() !== '') {
    return parseJsonObject(Buffer.from(req.body, 'utf8'));
  }
  const raw = Buffer.isBuffer(req.rawBody) && req.jsonContentType ? req.rawBody : await readRawBody(req, limit);
  if (raw.length === 0) return {};
  return parseJsonObject(raw);
}

// Raw bytes of the request, capped at `limit` (413 when exceeded).
export async function readRawBody(req, limit = 10 * 1024 * 1024) {
  if (Buffer.isBuffer(req.body)) return req.body; // express.raw() already read it
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new ApiError(413, `Request body exceeds ${limit} bytes`, 'PAYLOAD_TOO_LARGE');
      err.limit = limit;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// asyncHandler(fn): an async route whose rejection (or thrown error) is handed
// to the error handler. Without it an awaited throw would leave the request
// hanging until the browser gives up.
export function asyncHandler(fn) {
  return (req, res, next) => {
    let p;
    try {
      p = fn(req, res, next);
    } catch (e) {
      return next(e);
    }
    if (p && typeof p.catch === 'function') p.catch(next);
    return undefined;
  };
}

// Unknown /api path -> 404 with the envelope (never express' HTML page).
export function notFoundHandler(req, res) {
  sendJson(res, 404, errorBody(new ApiError(404, `No route for ${req.method} ${req.originalUrl}`, 'NOT_FOUND')));
}

// errorHandler({log}) -> express error middleware: ApiError answers with its own
// status/code; a body-limit overflow from a parser answers 413; anything else is
// a 500 whose real cause is logged server-side and reported as
// 'Internal server error' so internals never reach the browser.
export function errorHandler({ log = console.error } = {}) {
  return (err, req, res, next) => {
    // The caller hung up (or the socket died) while the body was still coming
    // in: there is nothing to answer, and writing would only raise a second
    // error on a dead socket.
    const gone = res.writableEnded || res.destroyed || req.aborted === true || req.destroyed === true;
    if (gone && !(err instanceof ApiError)) return undefined;
    if (res.headersSent) return next(err);
    const status = err instanceof ApiError ? err.status : httpStatusOf(err);
    const code = err.code ?? codeForStatus(status);
    const message = status >= 500 ? 'Internal server error' : err.message;
    if (status >= 500) log(`${req.method} ${req.originalUrl} -> ${status}: ${err.stack ?? err}`);
    sendJson(res, status, { error: { code, message } });
  };
}

function httpStatusOf(err) {
  if (err && err.type === 'entity.too.large') return 413;
  if (err && err.type === 'entity.parse.failed') return 400;
  if (err && err.code === 'EAI_AGAIN') return 502;
  if (err && typeof err.status === 'number' && err.status >= 400) return err.status;
  return 500;
}
