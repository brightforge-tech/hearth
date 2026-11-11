// tests/api/http.test.mjs — the helpers in api/lib/http.mjs (task t4), exercised
// directly rather than through a socket: the error envelope, the ApiError -> status
// mapping, the body readers and their caps, and the async wrapper that stops a
// rejected handler from hanging a request. tests/api/routing.test.mjs covers the
// same helpers over real HTTP; this file pins the parts the wire cannot show.

import { Readable } from 'node:stream';

import {
  ApiError,
  asyncHandler,
  codeForStatus,
  errorHandler,
  errorBody,
  jsonBodyParser,
  notFoundHandler,
  readJsonBody,
  readRawBody,
  sendJson,
} from '../../api/lib/http.mjs';

// A fake express response: chainable, records what was written.
function fakeRes() {
  const res = {
    headersSent: false,
    statusCode: null,
    body: undefined,
    mediaType: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(t) {
      this.mediaType = t;
      return this;
    },
    json(value) {
      this.body = value;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
  };
  return res;
}

// A request whose body is the given chunks, with the content type it claims —
// and a Content-Length like a real HTTP/1.1 request would carry, since the
// parser uses it to decide whether there is a body at all.
function fakeReq({ body, contentType, parsed, rawBody } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.headers = {};
  if (contentType) req.headers['content-type'] = contentType;
  if (body !== undefined) req.headers['content-length'] = String(Buffer.byteLength(body));
  if (parsed !== undefined) req.body = parsed;
  if (rawBody !== undefined) req.rawBody = Buffer.from(rawBody);
  req.jsonContentType = /^application\/json\b/i.test(contentType ?? '');
  return req;
}

function expectApiError(fn, { status, code } = {}) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        throw new Error('expected the call to throw an ApiError');
      },
      (e) => {
        if (!(e instanceof ApiError)) throw new Error(`expected an ApiError, got ${e?.name}: ${e?.message}`);
        if (status !== undefined && e.status !== status) throw new Error(`status ${e.status}, expected ${status}`);
        if (code !== undefined && e.code !== code) throw new Error(`code ${e.code}, expected ${code}`);
        return e;
      }
    );
}

export default [
  {
    name: 'ApiError carries a sane status and a default code; anything odd falls back to 500',
    async fn() {
      const e = new ApiError(409, 'duplicate', 'DUPLICATE_ROW');
      if (e.status !== 409 || e.code !== 'DUPLICATE_ROW' || e.message !== 'duplicate') throw new Error(`${e.status}/${e.code}`);
      if (!(e instanceof Error)) throw new Error('ApiError must be an Error so it can be thrown and logged');
      if (new ApiError(401, 'no').code !== 'UNAUTHORIZED') throw new Error('a 401 must default to UNAUTHORIZED');
      for (const [status, code] of [[400, 'BAD_REQUEST'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [413, 'PAYLOAD_TOO_LARGE'], [429, 'INTERNAL_ERROR']]) {
        if (new ApiError(status, 'x').code !== code) throw new Error(`${status} -> ${new ApiError(status, 'x').code}, expected ${code}`);
      }
      for (const bad of [undefined, 200, '404', 0, 999, 400.5]) {
        if (new ApiError(bad, 'x').status !== 500) throw new Error(`status ${JSON.stringify(bad)} must fall back to 500`);
      }
      if (codeForStatus(500) !== 'INTERNAL_ERROR' || codeForStatus(409) !== 'CONFLICT') throw new Error('codeForStatus');
    },
  },
  {
    name: 'the error envelope is always {"error":{"code","message"}}, and a 5xx never repeats the internal message',
    async fn() {
      const conf = errorBody(new ApiError(409, 'that email already exists', 'EMAIL_TAKEN'));
      if (JSON.stringify(conf) !== '{"error":{"code":"EMAIL_TAKEN","message":"that email already exists"}}') {
        throw new Error(JSON.stringify(conf));
      }
      const boom = errorBody(new Error('connection string for postgresql://...'));
      if (boom.error.message !== 'Internal server error') {
        throw new Error(`a bare Error is a 500 and must be masked, got ${JSON.stringify(boom)}`);
      }
      if (!boom.error.code) throw new Error('message missing');
      const fromApiError500 = errorBody(new ApiError(500, 'column invoice_items.unit_price does not exist'));
      if (fromApiError500.error.message !== 'Internal server error') {
        throw new Error(`a 500 must be masked, got ${JSON.stringify(fromApiError500)}`);
      }
    },
  },
  {
    name: 'sendJson writes the status, the JSON content type, and nothing at all once headers went out',
    async fn() {
      const res = fakeRes();
      sendJson(res, 201, { ok: true });
      if (res.statusCode !== 201) throw new Error(`status ${res.statusCode}`);
      if (res.mediaType !== 'application/json; charset=utf-8') throw new Error(`media type ${res.mediaType}`);
      if (JSON.stringify(res.body) !== '{"ok":true}') throw new Error(JSON.stringify(res.body));

      const late = fakeRes();
      late.headersSent = true;
      late.body = 'already sent';
      sendJson(late, 500, { error: { code: 'X', message: 'y' } });
      if (late.body !== 'already sent') throw new Error('sendJson overwrote a response already on the wire');
    },
  },
  {
    name: 'readRawBody returns the stream, and caps it at the given limit with a 413',
    async fn() {
      const one = await readRawBody(fakeReq({ body: 'hello' }));
      if (!Buffer.isBuffer(one) || one.toString() !== 'hello') throw new Error('small body');
      const empty = await readRawBody(fakeReq({}));
      if (empty.length !== 0) throw new Error('an empty request must read as zero bytes');
      const e = await expectApiError(() => readRawBody(fakeReq({ body: 'x'.repeat(2048) }), 1024));
      if (e.status !== 413 || e.code !== 'PAYLOAD_TOO_LARGE') throw new Error(`cap -> ${e.status}/${e.code}`);
      // a body express.raw() already turned into a Buffer is reused, not re-read
      const pre = fakeReq({});
      pre.body = Buffer.from('pre-read');
      const reused = await readRawBody(pre);
      if (reused.toString() !== 'pre-read') throw new Error('an express.raw() body was not reused');
    },
  },
  {
    name: 'readJsonBody: parses what is there, {} for nothing, 400 for junk or a non-object',
    async fn() {
      const parsed = await readJsonBody(fakeReq({ parsed: { a: 1 }, contentType: 'application/json' }));
      if (JSON.stringify(parsed) !== '{"a":1}') throw new Error('a parsed body must be returned as-is');

      const fromStream = await readJsonBody(fakeReq({ body: '{"b":2}', contentType: 'application/x-www-form-urlencoded' }));
      if (JSON.stringify(fromStream) !== '{"b":2}') throw new Error('a JSON body with another content type must still be readable');

      const stringBody = await readJsonBody(fakeReq({ body: '{"c":3}' }));
      const asString = await readJsonBody({ body: '{"c":3}', headers: {} });
      if (JSON.stringify(stringBody) !== '{"c":3}' || JSON.stringify(asString) !== '{"c":3}') throw new Error('a string body');

      const nothing = await readJsonBody(fakeReq({}));
      if (JSON.stringify(nothing) !== '{}') throw new Error('a body-less request is not a malformed one');

      await expectApiError(() => readJsonBody(fakeReq({ body: '{oops' })), { status: 400, code: 'INVALID_JSON' });
      await expectApiError(() => readJsonBody(fakeReq({ body: '[1,2]' })), { status: 400 });
      await expectApiError(() => readJsonBody(fakeReq({ body: '"just a string"' })), { status: 400 });
      await expectApiError(() => readJsonBody(fakeReq({ parsed: null, contentType: 'application/json' })), { status: 400 });
      await expectApiError(() => readJsonBody(fakeReq({ body: 'x'.repeat(4096) }), { limit: 1024 }), { status: 413 });
    },
  },
  {
    name: 'jsonBodyParser parses application/json, remembers the content type, and passes the rest through',
    async fn() {
      const parser = jsonBodyParser({ limit: 1024 });

      const run = (req) =>
        new Promise((resolve) => parser(req, fakeRes(), (err) => resolve({ err, req })));

      const json = await run(fakeReq({ body: '{"email":"a@b.test"}', contentType: 'application/json' }));
      if (json.err) throw new Error(`application/json failed: ${json.err.message}`);
      if (json.req.jsonContentType !== true || json.req.body?.email !== 'a@b.test') throw new Error('application/json was not parsed');
      if (!Buffer.isBuffer(json.req.rawBody)) throw new Error('the raw body was not kept for the form/CSRF distinction');

      const plus = await run(fakeReq({ body: '{"n":1}', contentType: 'application/vnd.hh+json' }));
      if (plus.err || plus.req.body?.n !== 1) throw new Error('a +json content type must be parsed too');

      const form = await run(fakeReq({ body: 'user=a', contentType: 'application/x-www-form-urlencoded' }));
      if (form.err) throw new Error(`a form body must pass through, got ${form.err.message}`);
      if (form.req.body !== undefined) throw new Error('a form body must not be parsed as JSON');
      if (form.req.jsonContentType !== false) throw new Error('jsonContentType must record the real content type');

      const get = await run(fakeReq({ contentType: undefined }));
      if (get.err || get.req.body !== undefined) throw new Error('a GET must pass through untouched');

      const bad = await run(fakeReq({ body: '{oops', contentType: 'application/json' }));
      if (!bad.err || bad.err.status !== 400) throw new Error('a malformed JSON body must reach the error handler as 400');

      const big = await run(fakeReq({ body: 'x'.repeat(2048), contentType: 'application/json' }));
      if (!big.err || big.err.status !== 413) throw new Error('an oversize body must reach the error handler as 413');
    },
  },
  {
    name: 'asyncHandler delivers throws and rejections to next() exactly once',
    async fn() {
      let calls = 0;
      const next = (e) => {
        calls++;
        next.error = e;
      };
      await asyncHandler(async () => {
        throw new ApiError(403, 'no role', 'FORBIDDEN');
      })({}, fakeRes(), next);
      if (calls !== 1 || next.error?.code !== 'FORBIDDEN') throw new Error(`async throw: ${calls} calls`);

      calls = 0;
      await asyncHandler(() => {
        throw new Error('sync throw');
      })({}, fakeRes(), next);
      if (calls !== 1 || next.error?.message !== 'sync throw') throw new Error(`sync throw: ${calls} calls`);

      calls = 0;
      await asyncHandler(async () => ({ handled: true }))({}, fakeRes(), next);
      if (calls !== 0) throw new Error('a resolved handler must not call next');

      // a handler that never resolves must not crash the process
      await asyncHandler(() => new Promise(() => {}))({}, fakeRes(), () => {});
    },
  },
  {
    name: 'notFoundHandler answers the envelope naming the method and path',
    async fn() {
      const res = fakeRes();
      notFoundHandler({ method: 'POST', originalUrl: '/api/query' }, res);
      if (res.statusCode !== 404) throw new Error(`status ${res.statusCode}`);
      if (res.body?.error?.code !== 'NOT_FOUND') throw new Error(JSON.stringify(res.body));
      if (!res.body.error.message.includes('POST /api/query')) throw new Error(res.body.error.message);
    },
  },
  {
    name: 'the error handler: ApiError status, parser codes, 5xx masking with the cause logged',
    async fn() {
      const logged = [];
      const handler = errorHandler({ log: (line) => logged.push(String(line)) });

      const conflict = fakeRes();
      handler(new ApiError(409, 'that email already exists', 'EMAIL_TAKEN'), { method: 'POST', originalUrl: '/api/auth/signup' }, conflict, () => {});
      if (conflict.statusCode !== 409 || conflict.body.error.code !== 'EMAIL_TAKEN') throw new Error(JSON.stringify(conflict.body));
      if (logged.length !== 0) throw new Error('a 4xx must not be logged as a fault');

      const oversized = fakeRes();
      handler(Object.assign(new Error('too large'), { type: 'entity.too.large' }), { method: 'POST', originalUrl: '/api/x' }, oversized, () => {});
      if (oversized.statusCode !== 413) throw new Error(`entity.too.large -> ${oversized.statusCode}`);

      const parse = fakeRes();
      handler(Object.assign(new Error('bad json'), { type: 'entity.parse.failed' }), { method: 'POST', originalUrl: '/api/x' }, parse, () => {});
      if (parse.statusCode !== 400) throw new Error(`entity.parse.failed -> ${parse.statusCode}`);

      const internal = fakeRes();
      handler(new Error('secret DSN postgresql://postgres:pw@host'), { method: 'GET', originalUrl: '/api/x' }, internal, () => {});
      if (internal.statusCode !== 500 || internal.body.error.message !== 'Internal server error') throw new Error(JSON.stringify(internal.body));
      if (logged.length !== 1 || !logged[0].includes('secret DSN')) throw new Error('the cause was not logged for the operator');
      if (JSON.stringify(internal.body).includes('secret DSN')) throw new Error('the cause reached the caller');

      // a response already on the wire goes back to express, untouched
      const half = fakeRes();
      half.headersSent = true;
      let handedOn = null;
      handler(new Error('too late'), {}, half, (e) => {
        handedOn = e;
      });
      if (handedOn?.message !== 'too late') throw new Error('headersSent must delegate to express');
    },
  },
];
