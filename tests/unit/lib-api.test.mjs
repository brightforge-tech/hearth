// tests/unit/lib-api.test.mjs — the wire contract of src/lib/api.ts (task
// t16): the helper the Billing/Exports call sites use attaches the session
// token and the JSON content type to EVERY request, and the three named
// endpoint helpers target exactly the three ported paths, so the pages never
// need (and never carry) an endpoint URL of their own (W61).
//
// No server and no database: a recording fetch stands in for the network, so
// what is asserted is the exact request object the shipped pages will issue —
// method, URL, headers, body — plus how responses are read back. api.ts is
// loaded through node's type stripping, i.e. the REAL shipped source.
//
// The fake fetch is installed at module load, before api.ts is ever imported
// (nothing in src/ touches fetch at import time, so this ordering is safe).

import assert from 'node:assert/strict';

// The shim's session-store key: read from the real shim source rather than
// hardcoded, so the store apiFetch reads and the store auth.ts writes can
// never silently drift apart from this test's knowledge of it.
const { SESSION_STORAGE_KEY } = await import('../../src/integrations/supabase/shim/auth.ts');

// A localStorage stand-in holding the shim's session entry, shared with
// whatever earlier-installed stand-in another suite left in place (each suite
// clears its own keys; ours is scoped to SESSION_STORAGE_KEY).
const store = new Map();
const local = globalThis.localStorage ?? {};
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : (local.getItem?.(k) ?? null)),
  setItem: (k, v) => {
    store.set(k, String(v));
    local.setItem?.(k, v);
  },
  removeItem: (k) => {
    store.delete(k);
    local.removeItem?.(k);
  },
};

const { apiFetch, createApiFetch, ApiError, QUICKBOOKS_EXPORT_PATH, SEND_INVOICE_EMAIL_PATH, SEND_RECEIPT_EMAIL_PATH } =
  await import('../../src/lib/api.ts');

/** A fetch stand-in that records every request and replays canned replies. */
function recordingFetch(replies = []) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
    });
    const reply = replies.shift() ?? { status: 200, body: 'ok', contentType: 'text/csv' };
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      headers: { get: () => reply.contentType ?? 'application/json' },
      text: async () => reply.body,
    };
  };
  impl.calls = calls;
  return impl;
}

/** Write a `hh.session` entry — the store the shim's sign-in owns. */
function writeSession(accessToken) {
  if (accessToken === null) globalThis.localStorage.removeItem(SESSION_STORAGE_KEY);
  else
    globalThis.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ access_token: accessToken, token_type: 'Bearer', user: null })
    );
}

// --- the cases -----------------------------------------------------------------

export default [
  {
    name: 'U16.1 apiFetch sends Authorization: Bearer <session token> + Content-Type: application/json (t16/W61)',
    fn: async () => {
      writeSession('tok.t16.session');
      const doFetch = recordingFetch([
        { status: 200, body: JSON.stringify({ success: true, message: 'Invoice sent', emailId: 're_1' }) },
        { status: 200, body: JSON.stringify({ user: { email: 'staff@example.test' } }) },
      ]);
      // getToken omitted -> the real sessionToken() reader, from the store:
      const call = createApiFetch({ baseUrl: 'https://api.test', fetch: doFetch });

      await call('/api/send-invoice-email', { body: { invoiceId: 'i-1' } });
      assert.equal(doFetch.calls.length, 1);
      const req = doFetch.calls[0];
      assert.equal(req.method, 'POST', 'the ported contracts were POST-only');
      assert.equal(req.url, 'https://api.test/api/send-invoice-email');
      assert.equal(req.headers.Authorization, 'Bearer tok.t16.session',
        'the session bearer token must ride on every request');
      assert.equal(req.headers['Content-Type'], 'application/json',
        'a JSON body must be announced as application/json');
      assert.equal(req.body, JSON.stringify({ invoiceId: 'i-1' }));

      // a request with no body (e.g. accept json GETs) carries the bearer but
      // no content type, since nothing is being sent:
      await call('/api/auth/session', { method: 'GET' });
      const get = doFetch.calls[1];
      assert.equal(get.method, 'GET');
      assert.equal(get.headers.Authorization, 'Bearer tok.t16.session');
      assert.equal(get.headers['Content-Type'], undefined);
      assert.equal(get.body, undefined);

      writeSession(null);
    },
  },

  {
    name: 'U16.2 no session: no Authorization header is sent, and the 401 envelope throws as an Error',
    fn: async () => {
      writeSession(null);
      const doFetch = recordingFetch([
        { status: 401, body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }) },
      ]);
      const anon = createApiFetch({ baseUrl: 'https://api.test', fetch: doFetch });
      const err = await anon('/api/quickbooks-export', { body: { exportType: 'invoices' } }).then(() => null, (e) => e);
      assert.ok(err instanceof ApiError && err instanceof Error, 'must throw an Error (ApiError)');
      assert.equal(err.status, 401);
      assert.equal(err.message, 'Authentication required');
      const req = doFetch.calls[0];
      assert.equal(req.headers.Authorization, undefined, 'without a session no bearer token may be sent');
      assert.equal(req.headers['Content-Type'], 'application/json');
    },
  },

  {
    name: 'U16.3 the three endpoint helpers target exactly the three ported paths and read the bodies the pages need',
    fn: async () => {
      assert.deepEqual(
        [QUICKBOOKS_EXPORT_PATH, SEND_INVOICE_EMAIL_PATH, SEND_RECEIPT_EMAIL_PATH],
        ['/api/quickbooks-export', '/api/send-invoice-email', '/api/send-receipt-email'],
        'the endpoint paths are the three ported edge functions'
      );

      const doFetch = recordingFetch([
        { status: 200, body: 'Date,Customer\n8/5/2025,"Ada Example"\n', contentType: 'text/csv' },
        { status: 200, body: JSON.stringify({ success: true, message: 'Invoice sent', emailId: 're_1' }) },
        { status: 200, body: JSON.stringify({ success: true, message: 'Receipt sent', emailId: 're_2' }) },
      ]);
      // The helpers close over the module-level apiFetch, which resolves its
      // base URL per call from VITE_API_URL and its fetch per call from
      // globalThis — so pointing both here drives the shipped helpers.
      const savedFetch = globalThis.fetch;
      const savedToken = globalThis.localStorage.getItem(SESSION_STORAGE_KEY);
      process.env.VITE_API_URL = 'https://api.test';
      globalThis.fetch = doFetch;
      writeSession('tok.injected');
      try {
        const { apiQuickBooksExport, apiSendInvoiceEmail, apiSendReceiptEmail } = await import('../../src/lib/api.ts');

        const csv = await apiQuickBooksExport({ exportType: 'invoices' });
        assert.equal(typeof csv, 'string', 'the CSV helper must resolve with raw text (the Blob input)');
        assert.ok(csv.startsWith('Date,Customer'));

        const inv = await apiSendInvoiceEmail({ invoiceId: 'i-1', recipientEmail: 'a@b.c' });
        assert.deepEqual(inv, { success: true, message: 'Invoice sent', emailId: 're_1' },
          'the invoice helper must resolve with the parsed JSON contract Billing.tsx consumes');

        const rec = await apiSendReceiptEmail({ paymentId: 'p-1', recipientEmail: 'a@b.c' });
        assert.equal(rec.emailId, 're_2');

        assert.deepEqual(doFetch.calls.map((c) => [c.method, c.url]), [
          ['POST', 'https://api.test/api/quickbooks-export'],
          ['POST', 'https://api.test/api/send-invoice-email'],
          ['POST', 'https://api.test/api/send-receipt-email'],
        ]);
        for (const req of doFetch.calls) {
          assert.equal(req.headers.Authorization, 'Bearer tok.injected',
            'every helper request carries the session bearer (the apiFetch path)');
          assert.equal(req.headers['Content-Type'], 'application/json');
        }
      } finally {
        globalThis.fetch = savedFetch;
        delete process.env.VITE_API_URL;
        if (savedToken === null) writeSession(null);
        else globalThis.localStorage.setItem(SESSION_STORAGE_KEY, savedToken);
      }
    },
  },

  {
    name: 'U16.4 sessionToken(): fresh read of the shim session store — token present, absent, useless, or unparsable',
    fn: async () => {
      const { sessionToken } = await import('../../src/lib/api.ts');

      writeSession('tok.fresh');
      assert.equal(sessionToken(), 'tok.fresh');
      // a sign-out (store entry removed) takes effect on the very next read:
      writeSession(null);
      assert.equal(sessionToken(), null);
      // an entry without a usable access_token — no bearer:
      globalThis.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token_type: 'Bearer' }));
      assert.equal(sessionToken(), null, 'an entry with no access_token is no session');
      globalThis.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ access_token: '' }));
      assert.equal(sessionToken(), null, 'an empty access_token is no session');
      globalThis.localStorage.setItem(SESSION_STORAGE_KEY, 'not json{');
      assert.equal(sessionToken(), null, 'an unparsable entry is no session');
      writeSession(null);
    },
  },

  {
    name: 'U16.5 a non-JSON failure body still throws a usable message (the pages never toast an empty description)',
    fn: async () => {
      const doFetch = recordingFetch([{ status: 502, body: '<html>gateway</html>' }]);
      const call = createApiFetch({ baseUrl: 'https://api.test', getToken: () => null, fetch: doFetch });
      const err = await call('/api/quickbooks-export', { body: {} }).then(() => null, (e) => e);
      assert.ok(err instanceof Error);
      assert.equal(err.status, 502);
      assert.match(err.message, /502/);
    },
  },
];
