// tests/api/quickbooks-export.test.mjs — POST /api/quickbooks-export: the
// ported QuickBooks CSV export (task t10; milestone-4 criteria W39, W40, W41,
// W42, W43, W44).
//
// Every case drives the endpoint the way the operator runs it — a real
// `node api/server.mjs --port <n>` against a real PostgreSQL, over real HTTP —
// on a scratch database of its own that the server's own start-up migrates.
// The clinic rows are inserted straight into that database (the way the
// parity suite will seed fixtures) and compared against byte-exact CSV.
//
// Pinned here:
//   W42  no Authorization, a forged signature and a roleless session never
//        reach the CSV; admin/moderator/user do;
//   W39  the invoices contract: 200, text/csv, the attachment filename built
//        from the raw body strings, the exact header line, one row per invoice
//        item, only status 'issued' in the created_at range, created_at asc,
//        and the Date cell '8/5/2025' for a 2025-08-05T14:30:00Z invoice;
//   W40  the payments contract: exact header, one row per payment in
//        received_at order, INV-/PAY- + last eight id chars, and a blank
//        Customer when the invoice has no appointment patient;
//   W41  exportType nonsense/absent -> 500 {"error":"Invalid export type"} as
//        JSON; endDate before startDate -> 400 {"error":"Invalid date range"}
//        and nothing written;
//   W43  the S6 fix: `O"Neil, Bob` -> `"O""Neil, Bob"`, `=cmd...` ->
//        `"'=cmd...`, + - @ likewise prefixed, while the numeric cells and the
//        Taxable Y/N stay unquoted (`...,Y,2,22,"USD"` — the shipped template
//        quoted the Currency cell, so the port emits `"USD"` too);
//   W44  the S8 fix: per-line tax/total (2/22 and 0/5), never the invoice's
//        2 and 27 repeated on every row.

import pg from 'pg';

import { signTestToken as signToken, ensureTestSessions } from '../helpers/session.mjs';
import { request, startServer } from '../helpers/server.mjs';

const SCRATCH = '_t10';
const JWT_SECRET = 't10-export-suite-secret-0123456789abcdef';
const PATH = '/api/quickbooks-export';

const INVOICE_HEADER =
  'Date,Customer,Customer Email,Invoice Number,Item Description,Quantity,Rate,Amount,Taxable,Tax Amount,Total,Currency';
const PAYMENT_HEADER = 'Date,Customer,Invoice Number,Payment Method,Amount,Reference,Payment ID';

// --- scratch-database plumbing (same shape as the RPC suite) -----------------
function scratchDsn(testUrl) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const u = new URL(testUrl);
  u.pathname = `/${base}${SCRATCH}`;
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

async function withAdminDb(testUrl, fn) {
  const admin = new pg.Client(clientParams(testUrl, 'postgres'));
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

// --- fixture helpers ----------------------------------------------------------
const PATIENT_FIX = Object.freeze({
  // the milestone's quote-and-comma name: first + ' ' + last === `O"Neil, Bob`
  first: 'O"Neil,',
  last: 'Bob',
  email: 'b.oboneil@example.com',
});

async function insertPatient(db, { first = PATIENT_FIX.first, last = PATIENT_FIX.last, email = PATIENT_FIX.email } = {}) {
  const r = await db.query('insert into public.patients (first_name, last_name, email) values ($1,$2,$3) returning id', [first, last, email]);
  return r.rows[0].id;
}

async function insertAppointment(db, patientId, { start = '2025-08-05T14:00:00Z' } = {}) {
  const r = await db.query(
    'insert into public.appointments (patient_id, scheduled_start, reason) values ($1,$2,$3) returning id',
    [patientId, start, 'routine visit']
  );
  return r.rows[0].id;
}

async function insertInvoice(db, { appointment_id = null, created_at, status = 'issued', tax_enabled = true, tax_rate = 0 } = {}) {
  const r = await db.query(
    `insert into public.invoices (appointment_id, status, tax_enabled, tax_rate, created_at)
     values ($1,$2::public.invoice_status,$3,$4,$5) returning id`,
    [appointment_id, status, tax_enabled, tax_rate, created_at]
  );
  return r.rows[0].id;
}

async function insertItem(db, invoice_id, { description, quantity, unit_price, taxable = true }) {
  // line_total and the invoice totals follow from the schema's triggers —
  // exactly the rows the real app would have produced.
  const r = await db.query(
    'insert into public.invoice_items (invoice_id, description, quantity, unit_price, taxable) values ($1,$2,$3,$4,$5) returning id',
    [invoice_id, description, quantity, unit_price, taxable]
  );
  return r.rows[0].id;
}

async function insertPayment(db, invoice_id, { amount, method = 'cash', reference = null, received_at }) {
  const r = await db.query(
    `insert into public.payments (invoice_id, amount, method, reference, received_at)
     values ($1,$2,$3::public.payment_method,$4,$5) returning id`,
    [invoice_id, amount, method, reference, received_at]
  );
  return r.rows[0].id;
}

async function insertUser(db, alias, role) {
  const r = await db.query(
    'insert into public.app_users (email, password_hash) values ($1,$2) returning id, email',
    [`${alias}@t10.test`, 'scrypt$t10$fixture$not-a-real-hash']
  );
  const user = r.rows[0];
  if (role) await db.query('insert into public.user_roles (user_id, role) values ($1,$2::public.app_role)', [user.id, role]);
  return user;
}

// withApi({root, testUrl, seed, fixture}, fn): scratch database -> running API
// -> fixture rows committed -> the case runs -> everything dropped.
async function withApi({ root, testUrl, seed = {}, fixture = null }, fn) {
  const dsn = scratchDsn(testUrl);
  const scratch = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  await withAdminDb(testUrl, async (admin) => {
    await admin.query(`drop database if exists "${scratch}" with (force)`);
    await admin.query(`create database "${scratch}"`);
  });

  const handle = startServer({ root, databaseUrl: dsn, env: { JWT_SECRET } });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();

    const users = {};
    for (const [alias, role] of Object.entries(seed)) users[alias] = await insertUser(db, alias, role);
    await ensureTestSessions(db);

    const fx = fixture ? await fixture(db) : {};

    const api = {
      db,
      fx,
      users,
      port: handle.port,
      log: handle.log,
      tokenFor: (user) => signToken({ sub: user.id, email: user.email }, { secret: JWT_SECRET }),
      export: (body, token = null, headers = {}) =>
        request(handle.port, PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
          body: JSON.stringify(body),
        }),
    };
    await fn(api);
  } finally {
    try {
      await db.end();
    } catch {
      /* the connection may already have gone with the server */
    }
    await handle.stop();
    try {
      await withAdminDb(testUrl, (admin) => admin.query(`drop database if exists "${scratch}" with (force)`));
    } catch {
      /* leaving a scratch database behind is not a test failure */
    }
  }
}

function expectError(r, status, code, { label = `${status}` } = {}) {
  if (r.status !== status) throw new Error(`${label}: expected ${status}, got ${r.status}: ${r.text}`);
  if (!/^application\/json/.test(r.headers['content-type'] ?? '')) {
    throw new Error(`${label}: content-type is ${r.headers['content-type']}: ${r.text}`);
  }
  if (typeof r.json?.error?.code !== 'string' || typeof r.json?.error?.message !== 'string') {
    throw new Error(`${label}: expected the {"error":{"code","message"}} envelope, got ${r.text}`);
  }
  if (r.json.error.code !== code) throw new Error(`${label}: expected code ${code}, got ${JSON.stringify(r.json.error)}`);
}

const lines = (csv) => csv.split('\n');
const body = (r) => lines(r.text).slice(1, -1); // drop the header and the '' tail

// The milestone's range, verbatim, as the Exports page sends it (naive strings).
const RANGE = { startDate: '2025-08-01T00:00:00', endDate: '2025-08-31T23:59:59' };

// --- the invoice fixture the milestone describes ------------------------------
// E: boundary start, one item      D: one item, decimals      A: W43/W44 rows
// G: same period but status draft  F: same items but out of range (September)
async function invoiceFixture(db) {
  const patient = await insertPatient(db);
  const appointment = await insertAppointment(db, patient);

  const invoiceE = await insertInvoice(db, { appointment_id: appointment, created_at: '2025-08-01T00:00:00Z' });
  await insertItem(db, invoiceE, { description: 'Boundary check', quantity: 1, unit_price: 0, taxable: false });

  const invoiceD = await insertInvoice(db, { appointment_id: appointment, created_at: '2025-08-02T09:00:00Z', tax_rate: 10 });
  await insertItem(db, invoiceD, { description: 'Dressing change', quantity: 3, unit_price: 2.5, taxable: false });

  const invoiceA = await insertInvoice(db, { appointment_id: appointment, created_at: '2025-08-05T14:30:00Z', tax_rate: 10 });
  await insertItem(db, invoiceA, { description: "=cmd|' /C calc'!A0", quantity: 2, unit_price: 10, taxable: true });
  await insertItem(db, invoiceA, { description: 'Consultation', quantity: 1, unit_price: 5, taxable: false });

  const invoiceG = await insertInvoice(db, { appointment_id: appointment, created_at: '2025-08-04T10:00:00Z', status: 'draft', tax_rate: 10 });
  await insertItem(db, invoiceG, { description: 'Never issued', quantity: 1, unit_price: 99, taxable: true });

  const invoiceF = await insertInvoice(db, { appointment_id: appointment, created_at: '2025-09-15T10:00:00Z', tax_rate: 10 });
  await insertItem(db, invoiceF, { description: 'Next month', quantity: 1, unit_price: 50, taxable: true });

  return { patient, appointment, invoiceE, invoiceD, invoiceA, invoiceG, invoiceF };
}

export default [
  {
    name: 'W42: no Authorization, a forged signature and a roleless session are refused; every staff role passes',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin', mod: 'moderator', nurse: 'user', ghost: null }, fixture: invoiceFixture }, async (api) => {
        // the 401/403 come from the session layer, in the standard envelope,
        // and no CSV is ever produced for them
        const anon = await api.export({ exportType: 'invoices', ...RANGE });
        expectError(anon, 401, 'UNAUTHORIZED', { label: 'no Authorization header' });
        if (/^Date,Customer/m.test(anon.text)) throw new Error(`the anonymous answer leaked CSV: ${anon.text}`);

        const forged = signToken({ sub: api.users.boss.id, email: api.users.boss.email }, { secret: 'a-different-issuer-secret-00000' });
        expectError(await api.export({ exportType: 'invoices', ...RANGE }, forged), 401, 'UNAUTHORIZED', { label: 'forged signature' });

        const roleless = await api.export({ exportType: 'invoices', ...RANGE }, api.tokenFor(api.users.ghost));
        expectError(roleless, 403, 'NO_ROLE', { label: 'session with no user_roles row' });

        // the normal path: the finance roles pass requireRole and get the CSV;
        // clinical staff ('user') are refused — exports are not their job
        expectError(await api.export({ exportType: 'invoices', ...RANGE }, api.tokenFor(api.users.nurse)), 403, 'FORBIDDEN', { label: 'clinical staff' });
        for (const alias of ['boss', 'mod']) {
          const ok = await api.export({ exportType: 'invoices', ...RANGE }, api.tokenFor(api.users[alias]));
          if (ok.status !== 200) throw new Error(`${alias} token -> ${ok.status}: ${ok.text}`);
          if (!(ok.headers['content-type'] ?? '').startsWith('text/csv')) throw new Error(`${alias}: content-type ${ok.headers['content-type']}`);
        }

        // and a session is required for the payments type and the error types
        // too: the gate runs before the body is even looked at
        expectError(await api.export({ exportType: 'payments', ...RANGE }), 401, 'UNAUTHORIZED', { label: 'payments, no session' });
        expectError(await api.export({ exportType: 'nonsense' }), 401, 'UNAUTHORIZED', { label: 'bad type, no session' });
      });
    },
  },
  {
    name: 'W39: invoices export — headers, filename, status filter, range, order, one row per item, 8/5/2025',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin' }, fixture: invoiceFixture }, async (api) => {
        const token = api.tokenFor(api.users.boss);
        const r = await api.export({ exportType: 'invoices', ...RANGE }, token);
        if (r.status !== 200) throw new Error(`staff token -> ${r.status}: ${r.text}`);
        if (r.headers['content-type'] !== 'text/csv') throw new Error(`content-type is ${JSON.stringify(r.headers['content-type'])}, want exactly text/csv`);
        if (r.headers['content-disposition'] !== 'attachment; filename="quickbooks-invoices-2025-08-01T00:00:00-to-2025-08-31T23:59:59.csv"') {
          throw new Error(`content-disposition is ${JSON.stringify(r.headers['content-disposition'])}`);
        }

        const rows = body(r);
        if (lines(r.text)[0] !== INVOICE_HEADER) throw new Error(`header line is ${JSON.stringify(lines(r.text)[0])}`);

        // only 'issued' invoices inside the created_at range: draft G and the
        // September invoice F are absent; E (exactly on startDate), D and A
        // are present, created_at ascending, one row per invoice item.
        if (r.text.includes('Never issued') || r.text.includes('Next month')) {
          throw new Error(`a draft or out-of-range invoice leaked into the CSV:\n${r.text}`);
        }
        if (rows.length !== 4) throw new Error(`expected 1 (E) + 1 (D) + 2 (A) rows, got ${rows.length}:\n${r.text}`);

        const id = (u) => u.slice(-8);
        const customer = `"O""Neil, Bob"`;
        const expected = [
          `"8/1/2025",${customer},"b.oboneil@example.com","INV-${id(api.fx.invoiceE)}","Boundary check",1,0,0,N,0,0,"USD"`,
          `"8/2/2025",${customer},"b.oboneil@example.com","INV-${id(api.fx.invoiceD)}","Dressing change",3,2.5,7.5,N,0,7.5,"USD"`,
          // the S6 neutralisation lands inside the quoted description cell
          `"8/5/2025",${customer},"b.oboneil@example.com","INV-${id(api.fx.invoiceA)}","'=cmd|' /C calc'!A0",2,10,20,Y,2,22,"USD"`,
          `"8/5/2025",${customer},"b.oboneil@example.com","INV-${id(api.fx.invoiceA)}","Consultation",1,5,5,N,0,5,"USD"`,
        ];
        if (rows.join('\n') !== expected.join('\n')) {
          throw new Error(`CSV rows differ:\n got:\n${rows.join('\n')}\n want:\n${expected.join('\n')}`);
        }
        // the Date cell for created_at 2025-08-05T14:30:00Z reads exactly 8/5/2025
        if (!rows[2].startsWith('"8/5/2025",') || !rows[3].startsWith('"8/5/2025",')) {
          throw new Error(`Date cell is not exactly 8/5/2025: ${rows[2]} | ${rows[3]}`);
        }
      });
    },
  },
  {
    name: 'W43/W44: quote doubling, formula neutralisation, unquoted Y/N and numerics, per-line tax and total',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { nurse: 'moderator' }, fixture: invoiceFixture }, async (api) => {
        const r = await api.export({ exportType: 'invoices', ...RANGE }, api.tokenFor(api.users.nurse));
        if (r.status !== 200) throw new Error(`staff token -> ${r.status}: ${r.text}`);
        const rows = body(r);

        // W43: the patient name `O"Neil, Bob` is emitted as "O""Neil, Bob"
        if (!rows.every((row) => row.includes('"O""Neil, Bob"'))) throw new Error(`quote not doubled:\n${rows.join('\n')}`);
        // ...and the formula cell as "'=cmd|' /C calc'!A0" — prefixed, quoted
        const formula = rows.find((row) => row.includes('cmd'));
        if (!formula || !formula.includes(`"'=cmd|' /C calc'!A0"`)) {
          throw new Error(`formula cell wrong: ${formula}`);
        }
        if (formula.includes(',=cmd')) throw new Error(`the formula was NOT neutralised: ${formula}`);
        // the + - @ prefixes are covered by the unit suite on csvCell; here,
        // prove it end to end for a '-' description the clinic could store
        const minus = await api.db.query(
          `insert into public.invoice_items (invoice_id, description, quantity, unit_price, taxable)
           values ($1,'-discount',1,1,false)`,
          [api.fx.invoiceE]
        );
        if (minus.rowCount !== 1) throw new Error('fixture item not inserted');
        const r2 = await api.export({ exportType: 'invoices', ...RANGE }, api.tokenFor(api.users.nurse));
        const minusRow = body(r2).find((row) => row.includes('discount'));
        if (!minusRow.includes(`"'-discount"`)) throw new Error(`'-' cell not prefixed: ${minusRow}`);

        // W43: the numeric and Taxable cells stay unquoted — the rows END with
        // the raw Y/N token followed by the quoted currency the legacy wrote.
        if (!/,\s*Y,2,22,"USD"$/.test(formula)) throw new Error(`taxable row must end ,Y,2,22,"USD": ${formula}`);
        const consult = rows.find((row) => row.includes('Consultation'));
        if (!/,\s*N,0,5,"USD"$/.test(consult)) throw new Error(`non-taxable row must end ,N,0,5,"USD": ${consult}`);
        for (const row of rows) {
          if (row.includes('"Y"') || row.includes('"N"')) throw new Error(`Taxable cell was quoted: ${row}`);
        }

        // W44: per-line tax/total. Invoice A is at tax_rate 10 with items
        // 2×10.00 taxable and 1×5.00 non-taxable, so the recalc trigger put
        // tax_amount 2.00 / total 27.00 ON THE INVOICE — and neither 27 nor a
        // repeated 2 may appear on the non-taxable line.
        if (api.fx.invoiceA) {
          const inv = await api.db.query('select tax_amount::text t, total::text tt from public.invoices where id = $1', [api.fx.invoiceA]);
          if (inv.rows[0].t !== '2.00' || inv.rows[0].tt !== '27.00') {
            throw new Error(`fixture invoice-level totals wrong (${inv.rows[0].t}/${inv.rows[0].tt}) — the test assumes 2.00/27.00`);
          }
        }
        if (!formula.includes(',Y,2,22,"USD"')) throw new Error(`taxable line must carry its own 2/22: ${formula}`);
        if (consult.includes(',27') || consult.includes(',2,27')) throw new Error(`invoice-level figures repeated on a line: ${consult}`);
        if (!consult.includes(',N,0,5,"USD"')) throw new Error(`non-taxable line must carry 0/5: ${consult}`);

        // numeric cells print like PostgREST JSON: 10.00 renders as 10
        if (!formula.includes(',2,10,20,')) throw new Error(`numerics not rendered as JSON numbers: ${formula}`);
      });
    },
  },
  {
    name: 'W40: payments export — exact header, received_at order, INV-/PAY- last eight, blank Customer',
    async fn({ root, testUrl }) {
      await withApi(
        {
          root,
          testUrl,
          seed: { nurse: 'moderator' },
          fixture: async (db) => {
            const patient = await insertPatient(db);
            const appointment = await insertAppointment(db, patient);
            // invoice with the patient behind it; paid only partially so the
            // payment triggers leave it 'issued'
            const invoiceA = await insertInvoice(db, { appointment_id: appointment, created_at: '2025-08-05T14:30:00Z', tax_rate: 10 });
            await insertItem(db, invoiceA, { description: 'Treatment', quantity: 2, unit_price: 20, taxable: false });
            // invoice with NO appointment at all
            const invoiceB = await insertInvoice(db, { appointment_id: null, created_at: '2025-08-09T10:00:00Z' });
            await insertItem(db, invoiceB, { description: 'Private room', quantity: 1, unit_price: 30, taxable: false });

            const payA = await insertPayment(db, invoiceA, { amount: 20, method: 'cash', reference: 'R-1', received_at: '2025-08-05T14:30:00Z' });
            const payB = await insertPayment(db, invoiceB, { amount: 10, method: 'card', reference: null, received_at: '2025-08-10T09:00:00Z' });
            const payOut = await insertPayment(db, invoiceA, { amount: 5, method: 'transfer', reference: 'later', received_at: '2025-09-15T09:00:00Z' });
            return { patient, appointment, invoiceA, invoiceB, payA, payB, payOut };
          },
        },
        async (api) => {
          const r = await api.export({ exportType: 'payments', ...RANGE }, api.tokenFor(api.users.nurse));
          if (r.status !== 200) throw new Error(`staff token -> ${r.status}: ${r.text}`);
          if (r.headers['content-type'] !== 'text/csv') throw new Error(`content-type is ${JSON.stringify(r.headers['content-type'])}`);
          if (r.headers['content-disposition'] !== 'attachment; filename="quickbooks-payments-2025-08-01T00:00:00-to-2025-08-31T23:59:59.csv"') {
            throw new Error(`content-disposition is ${JSON.stringify(r.headers['content-disposition'])}`);
          }
          if (lines(r.text)[0] !== PAYMENT_HEADER) throw new Error(`header line is ${JSON.stringify(lines(r.text)[0])}`);

          const rows = body(r);
          if (rows.length !== 2) throw new Error(`expected exactly the 2 in-range payments, got ${rows.length}:\n${r.text}`);
          const id = (u) => u.slice(-8);
          const expected = [
            `"8/5/2025","O""Neil, Bob","INV-${id(api.fx.invoiceA)}","cash",20,"R-1","PAY-${id(api.fx.payA)}"`,
            // the blank Customer cell: invoice B has no appointment patient
            `"8/10/2025","","INV-${id(api.fx.invoiceB)}","card",10,"","PAY-${id(api.fx.payB)}"`,
          ];
          if (rows.join('\n') !== expected.join('\n')) {
            throw new Error(`rows differ:\n got:\n${rows.join('\n')}\n want:\n${expected.join('\n')}`);
          }
          if (r.text.includes('PAY-' + id(api.fx.payOut))) throw new Error('an out-of-range payment was exported');
        }
      );
    },
  },
  {
    name: 'W41: nonsense/missing exportType is 500 Invalid export type; an inverted range is 400 and creates nothing',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin' }, fixture: invoiceFixture }, async (api) => {
        const token = api.tokenFor(api.users.boss);

        const counts = async () => {
          const out = {};
          for (const t of ['patients', 'appointments', 'invoices', 'invoice_items', 'payments']) {
            const c = await api.db.query(`select count(*)::int n from public.${t}`);
            out[t] = c.rows[0].n;
          }
          return JSON.stringify(out);
        };
        const before = await counts();

        for (const body of [{ ...RANGE }, { exportType: 'nonsense', ...RANGE }, { exportType: 42, ...RANGE }, {}]) {
          const r = await api.export(body, token);
          if (r.status !== 500) throw new Error(`${JSON.stringify(body)} -> ${r.status}: ${r.text}`);
          if (r.headers['content-type'] !== 'application/json; charset=utf-8') {
            throw new Error(`content-type is ${JSON.stringify(r.headers['content-type'])}, want application/json`);
          }
          if (r.json?.error !== 'Invalid export type') throw new Error(`body is ${r.text}, want {"error":"Invalid export type"}`);
        }

        // inverted range: 400, same flat legacy error JSON, and the query never runs
        const inverted = await api.export({ exportType: 'invoices', startDate: '2025-08-31T00:00:00', endDate: '2025-08-01T00:00:00' }, token);
        if (inverted.status !== 400) throw new Error(`inverted range -> ${inverted.status}: ${inverted.text}`);
        if (inverted.headers['content-type'] !== 'application/json; charset=utf-8') throw new Error(`content-type is ${JSON.stringify(inverted.headers['content-type'])}`);
        if (inverted.json?.error !== 'Invalid date range') throw new Error(`body is ${inverted.text}, want {"error":"Invalid date range"}`);

        const invertedPayments = await api.export({ exportType: 'payments', startDate: '2025-12-01T00:00:00', endDate: '2025-11-01T00:00:00' }, token);
        if (invertedPayments.status !== 400 || invertedPayments.json?.error !== 'Invalid date range') {
          throw new Error(`payments inverted -> ${invertedPayments.status}: ${invertedPayments.text}`);
        }

        // unparsable bounds are a bad range too, not a 500 or a crash
        const garbage = await api.export({ exportType: 'invoices', startDate: 'yesterday', endDate: 'today' }, token);
        if (garbage.status !== 400 || garbage.json?.error !== 'Invalid date range') {
          throw new Error(`garbage bounds -> ${garbage.status}: ${garbage.text}`);
        }

        // and none of that wrote anything: the endpoint only reads
        if ((await counts()) !== before) throw new Error('the rejected requests changed rows');
      });
    },
  },
  {
    name: 'an empty result is still 200 with just the header line (and the range is inclusive at both ends)',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: { boss: 'admin' }, fixture: invoiceFixture }, async (api) => {
        const token = api.tokenFor(api.users.boss);

        const empty = await api.export({ exportType: 'invoices', startDate: '2025-10-01T00:00:00', endDate: '2025-10-31T23:59:59' }, token);
        if (empty.status !== 200) throw new Error(`empty range -> ${empty.status}: ${empty.text}`);
        if (empty.text !== `${INVOICE_HEADER}\n`) throw new Error(`empty export body is ${JSON.stringify(empty.text)}`);

        // boundary-inclusive on BOTH ends: exactly startDate pulls in invoice E,
        // exactly endDate is past everything (A is Aug 5) — widen to Sep 15 and
        // invoice F (created_at exactly 2025-09-15T10:00:00Z) must appear when
        // the end bound equals it.
        const toF = await api.export({ exportType: 'invoices', startDate: '2025-08-01T00:00:00', endDate: '2025-09-15T10:00:00' }, token);
        if (toF.status !== 200 || !toF.text.includes('Next month')) throw new Error(`endDate exactly on created_at excluded the row: ${toF.status}`);
        const justBeforeF = await api.export({ exportType: 'invoices', startDate: '2025-08-01T00:00:00', endDate: '2025-09-15T09:59:59' }, token);
        if (justBeforeF.text.includes('Next month')) throw new Error('a row one second past endDate was exported');

        const oneDay = await api.export({ exportType: 'invoices', startDate: '2025-08-05T00:00:00', endDate: '2025-08-05T23:59:59' }, token);
        if (body(oneDay).length !== 2) throw new Error(`the single day Aug 5 should have exactly invoice A's 2 rows, got ${body(oneDay).length}`);
      });
    },
  },
];
