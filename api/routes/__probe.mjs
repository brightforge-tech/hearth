// api/routes/__probe.mjs — opt-in self-test route, mounted only when
// HH_TEST_PROBE=1 (which only the regression suite sets; nothing in production
// or in the app's own start-up does).
//
// The HTTP helpers in api/lib/http.mjs — the JSON body parser, readJsonBody,
// ApiError, asyncHandler and the error envelope — are the contract every later
// route inherits, and they need exercising through the real express stack: a
// unit call cannot show that a rejected async handler reaches the error handler,
// that a body over the limit answers 413 JSON, or that a malformed body is 400
// rather than a hang. These routes reach them over real HTTP. They read and
// write no table and no file, so they cannot leak data or damage anything.

import express from 'express';

import { ApiError, asyncHandler, readJsonBody } from '../lib/http.mjs';

export default function probeRouter() {
  const router = express.Router();

  router.get('/who', (req, res) => {
    res.json({ ok: true, query: req.query, jsonContentType: req.jsonContentType === true });
  });

  // what the shared parser made of the body
  router.post('/body', (req, res) => {
    res.json({ parsed: req.body ?? null, jsonContentType: req.jsonContentType === true });
  });

  // readJsonBody on a body the parser left alone (non-JSON content type),
  // with a small cap so the 413 path is reachable in a test
  router.post('/read-json', asyncHandler(async (req, res) => {
    res.json({ read: await readJsonBody(req, { limit: 1024 }) });
  }));

  // ApiError -> its own status and code, through the error handler
  router.get('/api-error', () => {
    throw new ApiError(409, 'duplicate', 'DUPLICATE_ROW');
  });
  router.get('/boom', () => {
    throw new Error('a server-side fault whose text must not reach the caller');
  });
  router.get('/reject', asyncHandler(async () => {
    await Promise.reject(new ApiError(400, 'rejected on purpose', 'REJECTED'));
  }));

  return router;
}
