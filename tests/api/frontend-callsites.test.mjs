// tests/api/frontend-callsites.test.mjs — the front-end call-site swap (task
// t12): src/lib/api.ts and the three call sites in Billing.tsx / Exports.tsx
// that replaced `supabase.functions.invoke` with fetch + Authorization.
//
// Like the shim suite, this imports the REAL sources — the .ts of
// src/lib/api.ts, loaded through node's built-in type stripping — and drives
// them against a running `node api/server.mjs` on a scratch database, so what
// is pinned is the wire contract as the shipped pages will execute it:
//
//   T12.1  the module-level apiFetch sends the bearer token it finds in the
//          shim session store and returns the CSV export as raw TEXT — the
//          exact call Exports.tsx's handleExport now makes (W42 proves the
//          header was attached: the endpoint is requireAuth-gated);
//   T12.2  accept 'json' (the default) parses the JSON body — the shape
//          Billing.tsx's email mutations destructure;
//   T12.3  with no session the 401 envelope's message is thrown as an Error,
//          which is what turns into the pages' toast description;
//   T12.4  the ported endpoints' flat {"error":"..."} bodies surface as the
//          message AND the status (the legacy 'Invalid export type' /
//          'Invalid date range' / 'Payment ID and recipient email are
//          required' contracts the toasts now read);
//   T12.5  createApiFetch honours an injected baseUrl and token source — the
//          seam the suite itself (and any page-level unit test) uses;
//   T12.6  the swapped call sites: the two pages carry the three /api/...
//          paths and no supabase.functions call survives anywhere in src/.
//
// The session store: apiFetch reads the shim's `hh.session` localStorage
// entry per call, so each case just writes or removes that entry — the same
// storage the shim's own sign-in writes in the browser. The fake is installed
// at module load, before api.ts is ever imported.

import pg from 'pg';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { startServer } from '../helpers/server.mjs';

const SCRATCH = '_t12';
const JWT_SECRET = 't12-front-end-suite-secret-0123456789abcdef';

// The seeded staff account is the identity the pages log in as here (the
// fixture users carry fake hashes); it passes the endpoints' requireRole gate.
const SEED_STAFF = { email: 'staff@example.test', password: 'Staff#2025test' };

// A localStorage stand-in holding the shim's session entry; apiFetch reads it
// fresh on every call. Installed before api.ts loads (nothing in src reads
// localStorage at import time, so this ordering is safe for every module).
const sessionStore = new Map();
globalThis.localStorage = {
  getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
  setItem: (k, v) => sessionStore.set(k, String(v)),
  removeItem: (k) => sessionStore.delete(k),
};

let api = null;
let auth = null;
async function loadApi() {
  if (!api) api = await import('../../src/lib/api.ts');
  if (!auth) auth = await import('../../src/integrations/supabase/shim/auth.ts');
  return { ...api, SESSION_STORAGE_KEY: auth.SESSION_STORAGE_KEY };
}

function swapDb(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

function clientParams(url, database) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username || 'postgres'),
    password: u.password ? decodeURIComponent(u.password) : '',
    database,
    connectionTimeoutMillis: 5000,
  };
}

const ID = {
  ada: '00000000-0000-4000-8000-0000000000f1',
  appt1: '00000000-0000-4000-8000-0000000000f2',
  invoice: '00000000-0000-4000-8000-0000000000f3',
  itemTaxable: '00000000-0000-4000-8000-0000000000f4',
  itemPlain: '00000000-0000-4000-8000-0000000000f5',
};

const FIXTURE = [
  `insert into public.patients (id, first_name, last_name, date_of_birth, sex, email)
   values ($1, 'Ada', 'Example', '1980-02-02', 'f', 'ada@t12.test')`,
  [ID.ada],

  `insert into public.appointments (id, patient_id, scheduled_start, duration_minutes, status, reason)
   values ($1, $2, '2025-08-05T14:00:00Z', 30, 'completed', 't12 fixture')`,
  [ID.appt1, ID.ada],

  // the W44 invoice: tax_rate 10, one 2x10.00 taxable item and one 5.00
  // non-taxable item, created 2025-08-05T14:30:00Z (the pinned 8/5/2025)
  `insert into public.invoices (id, appointment_id, tax_enabled, tax_rate, status, created_at)
   values ($1, $2, true, 10, 'issued', '2025-08-05T14:30:00Z')`,
  [ID.invoice, ID.appt1],

  `insert into public.invoice_items (id, invoice_id, description, quantity, unit_price, taxable) values
     ($1, $3, 'Consultation', 2, 10.00, true),
     ($2, $3, 'Dressing',     1,  5.00, false)`,
  [ID.itemTaxable, ID.itemPlain, ID.invoice],
];

const INVOICE_HEADER =
  'Date,Customer,Customer Email,Invoice Number,Item Description,Quantity,Rate,Amount,Taxable,Tax Amount,Total,Currency';

// withFrontend({root, testUrl}, fn): scratch database + running API + helpers
// for the session store and for pointing the default apiFetch at it.
async function withFrontend({ root, testUrl }, fn) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const scratch = `${base}${SCRATCH}`;
  const dsn = swapDb(testUrl, scratch);
  {
    const admin = new pg.Client(clientParams(testUrl, 'postgres'));
    await admin.connect();
    try {
      await admin.query(`drop database if exists "${scratch}" with (force)`);
      await admin.query(`create database "${scratch}"`);
    } finally {
      await admin.end();
    }
  }

  const handle = startServer({ root, databaseUrl: dsn, env: { JWT_SECRET, SEED_ACCOUNTS: '1' } });
  const db = new pg.Client(clientParams(dsn, scratch));
  const savedViteApiUrl = process.env.VITE_API_URL;
  const baseUrl = () => `http://127.0.0.1:${handle.port}`;
  try {
    await handle.waitForPort();
    await db.connect();
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);

    const api = {
      db,
      log: handle.log,
      baseUrl: baseUrl(),

      /** Write a `hh.session` entry, i.e. the shim having signed in. */
      setSession(accessToken) {
        if (accessToken === null) sessionStore.delete('hh.session');
        else sessionStore.set('hh.session', JSON.stringify({ access_token: accessToken, token_type: 'Bearer', user: null }));
      },

      /** The real POST /api/auth/login, then store the token the way the
       *  shim's sign-in stores it. Returns the bearer token. */
      async signIn() {
        const res = await fetch(`${baseUrl()}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(SEED_STAFF),
        });
        const json = await res.json().catch(() => null);
        if (res.status !== 200 || typeof json?.access_token !== 'string') {
          throw new Error(`seed staff sign-in failed: ${res.status} ${JSON.stringify(json).slice(0, 160)}`);
        }
        api.setSession(json.access_token);
        return json.access_token;
      },

      /** Point the module-level apiFetch (per-call base-URL resolution) here. */
      useDefaultBaseUrl() {
        process.env.VITE_API_URL = baseUrl();
      },
    };
    try {
      return await fn(api);
    } catch (e) {
      e.message += `\n--- server log ---\n${handle.log()}`;
      throw e;
    }
  } finally {
    if (savedViteApiUrl === undefined) delete process.env.VITE_API_URL;
    else process.env.VITE_API_URL = savedViteApiUrl;
    sessionStore.delete('hh.session'); // the shim session entry, always cleared
    try { await db.end(); } catch { /* already gone */ }
    await handle.stop();
    const admin = new pg.Client(clientParams(testUrl, 'postgres'));
    await admin.connect();
    try {
      await admin.query(`drop database if exists "${scratch}" with (force)`);
    } finally {
      await admin.end();
    }
  }
}

// The exact body Exports.tsx's handleExport sends.
const exportBody = {
  exportType: 'invoices',
  startDate: '2025-08-01T00:00:00',
  endDate: '2025-08-31T23:59:59',
};

function listSourceFiles(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSourceFiles(p));
    else if (/\.tsx?$/.test(ent.name)) out.push(p);
  }
  return out;
}

// --- the cases -----------------------------------------------------------------

export default [
  {
    name: 'T12.1 apiFetch: session bearer from the shim store + CSV export as raw text (the Exports.tsx call)',
    fn: async (ctx) => withFrontend(ctx, async ({ baseUrl, signIn, setSession, useDefaultBaseUrl }) => {
      const { apiFetch } = await loadApi();
      const token = await signIn();
      assert.ok(token, 'sign-in produced a bearer token');
      useDefaultBaseUrl();

      const csv = await apiFetch('/api/quickbooks-export', { body: exportBody, accept: 'text' });

      assert.equal(typeof csv, 'string', 'accept text must return the raw body as a string');
      assert.ok(csv.startsWith(`${INVOICE_HEADER}\n`), `unexpected header line: ${csv.split('\n')[0]}`);
      // the milestone's pinned cells, proving the response really came from
      // the endpoint (which is 401 without the Authorization header):
      assert.ok(csv.includes('"8/5/2025","Ada Example","ada@t12.test"'), csv);
      assert.ok(csv.includes(`"INV-${ID.invoice.slice(-8)}"`), csv);
      assert.ok(csv.includes(',Y,2,22,"USD"'), csv);
      assert.ok(csv.includes(',N,0,5,"USD"'), csv);

      // and the header really was attached: the same call with the session
      // removed is a 401, never a CSV (the W42 gate seen from the client).
      setSession(null);
      const err = await apiFetch('/api/quickbooks-export', { body: exportBody, accept: 'text' }).then(
        () => null,
        (e) => e
      );
      assert.ok(err instanceof Error, 'a 401 must surface as an Error');
      assert.equal(err.status, 401);
    }),
  },

  {
    name: 'T12.2 accept json (default): the parsed object arrives (the Billing.tsx email-mutation shape)',
    fn: async (ctx) => withFrontend(ctx, async ({ signIn, useDefaultBaseUrl }) => {
      const { apiFetch } = await loadApi();
      await signIn();
      useDefaultBaseUrl();

      const body = await apiFetch('/api/auth/session', { method: 'GET' });
      assert.ok(body && typeof body === 'object', `expected a parsed object, got ${typeof body}`);
      assert.equal(body.user.email, SEED_STAFF.email);
      assert.ok(Array.isArray(body.user.roles) && body.user.roles.length > 0, JSON.stringify(body));
    }),
  },

  {
    name: 'T12.3 no session: the 401 envelope message is thrown as an Error (the toast description)',
    fn: async (ctx) => withFrontend(ctx, async ({ baseUrl, useDefaultBaseUrl }) => {
      const { apiFetch } = await loadApi();
      useDefaultBaseUrl();

      // what the server actually says, straight from the wire —
      const raw = await fetch(`${baseUrl}/api/quickbooks-export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(exportBody),
      });
      const envelope = await raw.json();
      assert.equal(raw.status, 401);
      assert.ok(envelope?.error?.message, `expected {"error":{"message"}}, got ${JSON.stringify(envelope).slice(0, 160)}`);

      const err = await apiFetch('/api/quickbooks-export', { body: exportBody }).then(() => null, (e) => e);
      assert.ok(err instanceof Error, 'non-2xx must throw an Error');
      assert.equal(err.message, envelope.error.message, 'the message must be the server\'s own, verbatim');
      assert.equal(err.status, 401);
    }),
  },

  {
    name: 'T12.4 the ported endpoints\' flat {"error":"..."} bodies surface as the legacy message',
    fn: async (ctx) => withFrontend(ctx, async ({ signIn, useDefaultBaseUrl }) => {
      const { apiFetch } = await loadApi();
      await signIn();
      useDefaultBaseUrl();

      const badType = await apiFetch('/api/quickbooks-export', { body: { ...exportBody, exportType: 'nonsense' } }).then(() => null, (e) => e);
      assert.equal(badType.message, 'Invalid export type');
      assert.equal(badType.status, 500);

      const inverted = await apiFetch('/api/quickbooks-export', {
        body: { ...exportBody, startDate: '2025-08-31T00:00:00', endDate: '2025-08-01T00:00:00' },
      }).then(() => null, (e) => e);
      assert.equal(inverted.message, 'Invalid date range');
      assert.equal(inverted.status, 400);

      const noPayment = await apiFetch('/api/send-receipt-email', { body: { recipientEmail: 'p@example.com' } }).then(() => null, (e) => e);
      assert.equal(noPayment.message, 'Payment ID and recipient email are required');
      assert.equal(noPayment.status, 500);
    }),
  },

  {
    name: 'T12.5 createApiFetch honours an injected baseUrl and token source (the unit-test seam)',
    fn: async (ctx) => withFrontend(ctx, async ({ baseUrl, signIn }) => {
      const { createApiFetch } = await loadApi();

      const anon = createApiFetch({ baseUrl, getToken: () => null });
      const err = await anon('/api/quickbooks-export', { body: exportBody, accept: 'text' }).then(() => null, (e) => e);
      assert.equal(err.status, 401, 'an injected null token sends no Authorization header');

      const token = await signIn(); // also writes the session store — cleared again below
      const staff = createApiFetch({ baseUrl, getToken: () => token });
      const csv = await staff('/api/quickbooks-export', { body: exportBody, accept: 'text' });
      assert.ok(csv.startsWith(`${INVOICE_HEADER}\n`), csv.slice(0, 120));
    }),
  },

  {
    name: 'T12.6 the three call sites use the api.ts helpers; src/ carries no supabase.functions reference and no endpoint path outside src/lib/api.ts',
    fn: async ({ root }) => {
      const billing = readFileSync(join(root, 'src', 'pages', 'Billing.tsx'), 'utf8');
      const exports = readFileSync(join(root, 'src', 'pages', 'Exports.tsx'), 'utf8');
      const apiLib = readFileSync(join(root, 'src', 'lib', 'api.ts'), 'utf8');

      // The pages reach the endpoints ONLY through the named helpers defined
      // in src/lib/api.ts (task t16 / W61): each imports the helper and calls
      // it; none of the three /api/... paths is spelled out in the pages.
      assert.ok(/import\s*\{[^}]*\bapiSendInvoiceEmail\b[^}]*\}\s*from\s*['"]@\/lib\/api['"]/.test(billing),
        'Billing.tsx must import the ported invoice-email helper from @/lib/api');
      assert.ok(/import\s*\{[^}]*\bapiSendReceiptEmail\b[^}]*\}\s*from\s*['"]@\/lib\/api['"]/.test(billing),
        'Billing.tsx must import the ported receipt-email helper from @/lib/api');
      assert.ok(/import\s*\{[^}]*\bapiQuickBooksExport\b[^}]*\}\s*from\s*['"]@\/lib\/api['"]/.test(exports),
        'Exports.tsx must import the ported CSV-export helper from @/lib/api');
      assert.ok(billing.includes('apiSendInvoiceEmail({'), 'Billing.tsx must call the invoice-email helper');
      assert.ok(billing.includes('apiSendReceiptEmail({'), 'Billing.tsx must call the receipt-email helper');
      assert.ok(exports.includes('apiQuickBooksExport({'), 'Exports.tsx must call the CSV-export helper');
      for (const path of ['/api/quickbooks-export', '/api/send-invoice-email', '/api/send-receipt-email']) {
        assert.ok(!billing.includes(path), `Billing.tsx must not spell out the ${path} path itself`);
        assert.ok(!exports.includes(path), `Exports.tsx must not spell out the ${path} path itself`);
        // and src/lib/api.ts is the ONLY src file where the path appears:
        const elsewhere = listSourceFiles(join(root, 'src')).filter(
          (f) => f !== join(root, 'src', 'lib', 'api.ts') && readFileSync(f, 'utf8').includes(path)
        );
        assert.deepEqual(elsewhere, [], `the ${path} path must appear only in src/lib/api.ts`);
      }

      // W61's other half: no supabase.functions reference survives in src/,
      // not even in a comment (the string the Definition-of-Done greps for).
      for (const file of listSourceFiles(join(root, 'src'))) {
        const src = readFileSync(file, 'utf8');
        assert.ok(!/supabase\.functions/.test(src), `src file still references supabase.functions: ${file}`);
        const code = src
          .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
          .replace(/^\s*\/\/.*$/gm, ''); // line comments
        assert.ok(!/\.functions\b/.test(code), `src file still touches supabase.functions: ${file}`);
      }

      // apiFetch sends the two headers W61 pins...
      assert.ok(/headers\.Authorization\s*=\s*`Bearer \$\{bearer\}`/.test(apiLib),
        'api.ts must send Authorization: Bearer <session token>');
      assert.ok(/headers\['Content-Type'\]\s*=\s*'application\/json'/.test(apiLib),
        'api.ts must send Content-Type: application/json with a JSON body');

      // ...and the pages keep the user-visible flow W61 pins unchanged.
      assert.ok(exports.includes("new Blob([csv], { type: 'text/csv' })"),
        'Exports.tsx must keep building the text/csv Blob from the returned CSV text');
      assert.ok(exports.includes('link.download = `quickbooks-${exportType}-${startDate}-to-${endDate}.csv`'),
        'the download filename must stay quickbooks-<type>-<start>-to-<end>.csv');
      assert.ok(exports.includes('setIsExporting(true)') && exports.includes('setIsExporting(false)'),
        'the isExporting flow must be kept');
      assert.ok(exports.includes('title: "Export successful"'), 'the success toast wording must not change');
      assert.ok(exports.includes('title: "Export failed"'), 'the failure toast wording must not change');
      assert.ok(billing.includes('title: "Email sent"') && billing.includes('Invoice has been sent successfully.'),
        'the invoice-email success toast wording must not change');
      assert.ok(billing.includes('title: "Receipt sent"') && billing.includes('Receipt has been emailed successfully.'),
        'the receipt-email success toast wording must not change');
    },
  },
];
