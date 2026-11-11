// tests/api/query.test.mjs — POST /api/query: the supabase-shaped Query API
// (task t7, milestone 3). Acceptance items W25-W32.
//
// Like the RPC suite, every case runs the way the operator runs it: a real
// `node api/server.mjs` against a real PostgreSQL scratch database (created by
// the suite, migrated by the server's own start-up, dropped afterwards),
// driven over real HTTP. The fixture is one clinic's worth of rows — a booked
// patient with an appointment, invoice, items and payments, plus the negative
// cases the policy matrix distinguishes: a patient with no appointment, an
// invoice with no appointment, a fully-paid invoice, a service hidden from the
// landing page.
//
// What is pinned, case by case:
//   W25  the Billing page's nested embed: to-one objects, `appointment: null`,
//        to-many arrays, and the JSON value types (numeric -> number,
//        timestamptz -> string, boolean -> boolean);
//   W26  unknown table / column / order column: 400 BAD_COLUMN, nothing executed;
//        and an anonymous caller is answered 401 before the schema is consulted;
//   W27  staff cannot delete payments, cannot update the rows the policy hides
//        (403, not a silent no-op), and cannot update clinic_settings;
//   W28  limit / order / offset, maybeSingle (null, no error), single (PGRST116);
//   W30  column-vs-column comparisons, including inside or() groups;
//   W31  or() across two columns with ilike and a limit;
//   W32  upsert with on_conflict on a unique non-PK column;
//   S32  the whole authorization matrix as the HTTP surface sees it.

import pg from 'pg';

import { signTestToken as signToken, ensureTestSessions } from '../helpers/session.mjs';
import { request, startServer } from '../helpers/server.mjs';

const SCRATCH = '_t7';
const JWT_SECRET = 't7-query-suite-secret-0123456789abcdef';
const PATH = '/api/query';

// Fixed ids so every case can name the rows it means.
const ID = {
  ada: '00000000-0000-4000-8000-000000000001',
  lonely: '00000000-0000-4000-8000-000000000002',
  appt1: '00000000-0000-4000-8000-000000000003',
  inv1: '00000000-0000-4000-8000-000000000004',
  inv2: '00000000-0000-4000-8000-000000000005',
  inv3: '00000000-0000-4000-8000-000000000006',
  item1: '00000000-0000-4000-8000-000000000007',
  item2: '00000000-0000-4000-8000-000000000008',
  item3: '00000000-0000-4000-8000-000000000009',
  pay1: '00000000-0000-4000-8000-00000000000a',
  pay3: '00000000-0000-4000-8000-00000000000b',
  hiddenService: '00000000-0000-4000-8000-00000000000c',
  admin: '00000000-0000-4000-8000-0000000000d1',
  staff: '00000000-0000-4000-8000-0000000000d2',
  roleless: '00000000-0000-4000-8000-0000000000d3',
};

const FIXTURE = [
  `insert into public.app_users (id, email, password_hash) values
     ($1, 'admin@t7.test', 'scrypt$t7$fixture$not-a-real-hash'),
     ($2, 'staff@t7.test', 'scrypt$t7$fixture$not-a-real-hash'),
     ($3, 'roleless@t7.test', 'scrypt$t7$fixture$not-a-real-hash')`,
  [ID.admin, ID.staff, ID.roleless],

  `insert into public.user_roles (user_id, role) values ($1, 'admin'), ($2, 'user')`,
  [ID.admin, ID.staff],

  // a service the landing page must not show (the seeded five are all shown)
  `insert into public.services (id, code, name, description, price, taxable, show_on_landing)
   values ($1, 'T7_HIDDEN', 'Hidden Lab Panel', 'not on the landing page', 99.00, true, false)`,
  [ID.hiddenService],

  `insert into public.patients (id, first_name, last_name, date_of_birth, sex, phone, email, address, national_id) values
     ($1, 'Ada', 'Example', '1980-02-02', 'f', '+1-555-0100', 'ada@t7.test', '1 Rose Crescent', 'NID-000'),
     ($2, 'Aliki', 'Notreal', null, 'f', '+1-555-0102', 'aliki@t7.test', '2 Laurel Lane', 'NID-ALIA')`,
  [ID.ada, ID.lonely],

  `insert into public.appointments (id, patient_id, scheduled_start, scheduled_end, duration_minutes, status, reason)
   values ($1, $2, '2026-03-01T10:00:00Z', '2026-03-01T10:30:00Z', 30, 'scheduled', 'annual checkup')`,
  [ID.appt1, ID.ada],

  // inv1: tax on, one taxable item 2x10.00 -> subtotal 20.00 tax 2.00 total 22.00 (recalc trigger),
  //      partially paid 12.50, status issued.  inv2: no appointment at all.
  //      inv3: appointment, fully paid -> the trigger flips status to paid.
  `insert into public.invoices (id, appointment_id, tax_enabled, tax_rate, status) values
     ($1, $2, true, 10.00, 'issued'),
     ($3, null, false, 0.00, 'draft'),
     ($4, $2, false, 0.00, 'draft')`,
  [ID.inv1, ID.appt1, ID.inv2, ID.inv3],

  `insert into public.invoice_items (id, invoice_id, service_id, description, quantity, unit_price, taxable) values
     ($1, $2, (select id from public.services where code = 'CONSULT_INIT'), 'Initial Consultation x2', 2, 10.00, true),
     ($3, $4, null, 'Bandage', 1, 5.00, false),
     ($5, $6, null, 'Quick check', 1, 5.00, false)`,
  [ID.item1, ID.inv1, ID.item2, ID.inv2, ID.item3, ID.inv3],

  `insert into public.payments (id, invoice_id, amount, method, reference) values
     ($1, $2, 12.50, 'cash', 't7-counter'),
     ($3, $4, 5.00, 'card', 't7-terminal')`,
  [ID.pay1, ID.inv1, ID.pay3, ID.inv3],
];

function swapDb(url, database) {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

function scratchDsn(testUrl) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  return swapDb(testUrl, `${base}${SCRATCH}`);
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

// withApi({root, testUrl}, fn): a freshly migrated scratch database, a running
// API against it, and the standard clinic fixture committed. `q(verb, body)`
// speaks the endpoint; `as(token)` binds it. The database is dropped at the end.
async function withApi({ root, testUrl }, fn) {
  const dsn = scratchDsn(testUrl);
  const scratch = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
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

  const handle = startServer({ root, databaseUrl: dsn, env: { JWT_SECRET } });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);
    await ensureTestSessions(db);

    const tokenFor = (which) =>
      signToken({ sub: ID[which], email: `${which}@t7.test` }, { secret: JWT_SECRET });
    const tokens = { admin: tokenFor('admin'), staff: tokenFor('staff'), roleless: tokenFor('roleless') };

    const api = {
      db,
      tokens,
      log: handle.log,
      async q(body, token = tokens.admin) {
        return request(handle.port, PATH, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      },
    };
    try {
      return await fn(api);
    } catch (e) {
      e.message += `\n--- server log ---\n${handle.log()}`;
      throw e;
    }
  } finally {
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

// --- tiny assertion helpers ---------------------------------------------------

import assert from 'node:assert/strict';

function envelope(res) {
  assert.equal(typeof res.json, 'object', `expected JSON, got ${res.status}: ${res.text.slice(0, 200)}`);
  return res.json;
}
function okData(res) {
  const body = envelope(res);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text.slice(0, 300)}`);
  assert.equal(body.error, null, `expected error null, got ${JSON.stringify(body.error)}`);
  return body.data;
}
function errorBody(res, status, code) {
  const body = envelope(res);
  assert.equal(res.status, status, `expected ${status}, got ${res.status}: ${res.text.slice(0, 300)}`);
  assert.equal(typeof body.error, 'object');
  assert.equal(body.error.code, code, `expected code ${code}, got ${JSON.stringify(body.error)}`);
  assert.equal(typeof body.error.message, 'string');
  assert.ok(body.error.message.length > 0);
  return body.error;
}
const ids = (rows) => rows.map((r) => r.id).sort();

// --- the cases -----------------------------------------------------------------

export default [
  {
    name: 'W25 the Billing embed: nested to-one, appointment null, to-many arrays, JSON number/string/boolean types',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      const data = okData(await q({
        table: 'invoices',
        select: 'id, status, total, paid_amount, created_at, tax_enabled, ' +
          'appointment:appointments(scheduled_start, reason, patient:patients(first_name, last_name, email, phone, address)), ' +
          'invoice_items(description, quantity, unit_price, line_total, taxable, service:services(name))',
        order: [{ column: 'id', ascending: true }],
      }, tokens.admin));

      assert.deepEqual(ids(data), [ID.inv1, ID.inv2, ID.inv3].sort());
      const inv1 = data.find((r) => r.id === ID.inv1);
      const inv2 = data.find((r) => r.id === ID.inv2);

      // the numeric columns arrive as JSON numbers, not strings — the Billing page does arithmetic on them
      assert.equal(typeof inv1.total, 'number');
      assert.equal(inv1.total, 22); // 20.00 subtotal + 2.00 tax, computed by the recalc trigger
      assert.equal(inv1.paid_amount, 12.5);
      assert.equal(typeof inv1.created_at, 'string');
      assert.equal(typeof inv1.tax_enabled, 'boolean');
      assert.equal(inv1.tax_enabled, true);

      // the two-level to-one embed: appointment.patient
      assert.equal(inv1.appointment.reason, 'annual checkup');
      assert.equal(inv1.appointment.patient.first_name, 'Ada');
      assert.equal(inv1.appointment.patient.last_name, 'Example');

      // the to-many embed is a real array, with its own nested to-one
      assert.ok(Array.isArray(inv1.invoice_items));
      assert.equal(inv1.invoice_items.length, 1);
      assert.equal(inv1.invoice_items[0].quantity, 2);
      assert.equal(inv1.invoice_items[0].line_total, 20);
      assert.equal(inv1.invoice_items[0].service.name, 'Initial Consultation');

      // an invoice with no appointment answers appointment: null — exactly what
      // Billing.tsx's `invoice.appointment?.patient` chain expects (W25)
      assert.equal(inv2.appointment, null);
      assert.ok(Array.isArray(inv2.invoice_items));
    }),
  },
  {
    name: 'W26 unknown table, column, filter column and order column: 400 BAD_COLUMN, and nothing happened',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      const a = errorBody(await q({ table: 'no_such_table' }, tokens.admin), 400, 'BAD_COLUMN');
      assert.match(a.message, /no_such_table/);
      errorBody(await q({ table: 'invoices', select: 'id, nope' }, tokens.admin), 400, 'BAD_COLUMN');
      errorBody(await q({ table: 'invoices', filters: { nope: 'x' } }, tokens.admin), 400, 'BAD_COLUMN');
      errorBody(await q({ table: 'invoices', order: [{ column: 'nope' }] }, tokens.admin), 400, 'BAD_COLUMN');
      errorBody(await q({ table: 'invoices', payload: { nope: 1 }, verb: 'insert' }, tokens.admin), 400, 'BAD_COLUMN');
      // the select grammar itself: 400 BAD_SELECT, and an embed with no FK: BAD_RELATION
      errorBody(await q({ table: 'invoices', select: 'id,,total' }, tokens.admin), 400, 'BAD_SELECT');
      errorBody(await q({ table: 'invoices', select: 'id, s:services(name)' }, tokens.admin), 400, 'BAD_RELATION');
      // and the catalog was only ever read, never written
      const n = await db.query('select count(*)::int as n from public.invoices');
      assert.equal(n.rows[0].n, 3);
    }),
  },
  {
    name: 'an anonymous caller is answered before the schema is consulted: 401 for anything but the allow-list',
    fn: async (ctx) => withApi(ctx, async ({ q }) => {
      errorBody(await q({ table: 'invoices' }, null), 401, 'UNAUTHORIZED');
      // not even a table-name leak: the 401 comes first, the 400 never happens
      errorBody(await q({ table: 'no_such_table' }, null), 401, 'UNAUTHORIZED');
      // a forged token is simply no caller at all
      errorBody(await q({ table: 'invoices' }, 'not.a.token'), 401, 'UNAUTHORIZED');
      // a token signed with the wrong secret: same answer, by design
      const forged = signToken({ sub: ID.admin, email: 'admin@t7.test' }, { secret: 'a-different-secret-0123456789ab' });
      errorBody(await q({ table: 'invoices' }, forged), 401, 'UNAUTHORIZED');
      // an account with no role is treated as anonymous (the session layer's rule),
      // and invoices is not on the anonymous allow-list
      errorBody(await q({ table: 'invoices' }, null), 401, 'UNAUTHORIZED');
    }),
  },
  {
    name: 'a roleless account sees exactly what the anonymous visitor sees (401 on the gated shapes)',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      errorBody(await q({ table: 'appointments' }, tokens.roleless), 401, 'UNAUTHORIZED');
      // ...but the two allow-listed shapes still work for it, as for `anon`
      const data = okData(await q({ table: 'services', select: 'id, name', filters: { code: 'T7_HIDDEN' } }, tokens.roleless));
      assert.deepEqual(ids(data), []); // hidden from the landing page, so hidden here too
    }),
  },
  {
    name: 'the anonymous allow-list is exactly one shape: the landing services read (no anonymous patient insert)',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      // landing read: the five seeded services, never the hidden one
      const services = okData(await q({ table: 'services', select: 'id, name, show_on_landing' }, null));
      assert.equal(services.length, 5);
      assert.ok(services.every((s) => s.show_on_landing === true));
      assert.ok(!services.some((s) => s.name === 'Hidden Lab Panel'));
      // a signed-in admin, by contrast, sees every row including the hidden one
      const all = okData(await q({ table: 'services', select: 'id, name' }, tokens.admin));
      assert.equal(all.length, 6);
      assert.ok(all.some((s) => s.name === 'Hidden Lab Panel'));

      // the hosted app let anyone insert a patient from the landing page;
      // Hearth does not (public booking requests have their own endpoint)
      errorBody(await q({
        table: 'patients',
        verb: 'insert',
        payload: { first_name: 'Walk', last_name: 'In', national_id: 'NID-WALK-IN' },
      }, null), 401, 'UNAUTHORIZED');
      const inDb = await db.query('select count(*)::int as n from public.patients where national_id = $1', ['NID-WALK-IN']);
      assert.equal(inDb.rows[0].n, 0);

      // everything else is still 401
      errorBody(await q({ table: 'patients', verb: 'update', payload: { first_name: 'x' }, filters: { national_id: 'NID-000' } }, null), 401, 'UNAUTHORIZED');
      errorBody(await q({ table: 'patients', verb: 'delete', filters: { national_id: 'NID-000' } }, null), 401, 'UNAUTHORIZED');
    }),
  },
  {
    name: 'staff patients read is scoped to the patients the clinic has booked; admin sees every row',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      const staffRows = okData(await q({ table: 'patients', select: 'id, first_name' }, tokens.staff));
      assert.deepEqual(ids(staffRows), [ID.ada]); // Aliki has no appointment -> invisible
      const adminRows = okData(await q({ table: 'patients', select: 'id, first_name' }, tokens.admin));
      assert.deepEqual(ids(adminRows), [ID.ada, ID.lonely].sort());
      // and the staff caller cannot widen the scope by asking for the row by id
      const missed = okData(await q({ table: 'patients', select: 'id', filters: { id: ID.lonely } }, tokens.staff));
      assert.deepEqual(missed, []);
    }),
  },
  {
    name: 'W28 limit / order / offset, single() and maybeSingle() keep the PostgREST contract',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      const one = okData(await q({ table: 'patients', select: 'first_name', order: [{ column: 'first_name' }], limit: 1 }, tokens.admin));
      assert.deepEqual(one.map((r) => r.first_name), ['Ada']);
      const second = okData(await q({ table: 'patients', select: 'first_name', order: [{ column: 'first_name' }], limit: 1, offset: 1 }, tokens.admin));
      assert.deepEqual(second.map((r) => r.first_name), ['Aliki']);

      // single(): exactly one row -> the row itself
      const got = okData(await q({ table: 'invoices', select: 'id, status', filters: { id: ID.inv1 }, single: true }, tokens.admin));
      assert.equal(got.id, ID.inv1);
      assert.equal(got.status, 'issued');

      // single() with no row -> PGRST116 inside the envelope, HTTP 200, like the hosted API
      const none = envelope(await q({ table: 'invoices', select: 'id', filters: { id: ID.hiddenService }, single: true }, tokens.admin));
      assert.equal(none.data, null);
      assert.equal(none.error.code, 'PGRST116');

      // maybeSingle() with no row -> null data, no error at all
      const maybeRes = await q({ table: 'invoices', select: 'id', filters: { id: ID.hiddenService }, maybeSingle: true }, tokens.admin);
      assert.equal(maybeRes.status, 200);
      assert.deepEqual(envelope(maybeRes), { data: null, error: null });
    }),
  },
  {
    name: 'W27 a staff write the policy allows is applied, and the response carries the written row',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      const data = okData(await q({
        table: 'invoices',
        verb: 'update',
        select: 'id, status',
        filters: { id: ID.inv1 },
        payload: { status: 'void' },
      }, tokens.staff));
      assert.deepEqual(data, [{ id: ID.inv1, status: 'void' }]); // the written row, projected
      const inDb = await db.query('select status from public.invoices where id = $1', [ID.inv1]);
      assert.equal(inDb.rows[0].status, 'void');
    }),
  },
  {
    name: 'W27 the rows a policy hides answer 403, not a silent no-op; and role-level denials are 403',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      // inv2 has no appointment: staff's invoices USING predicate hides it, so an
      // update filtered to it matched a row the policy refuses to touch -> 403
      const denied = errorBody(await q({
        table: 'invoices',
        verb: 'update',
        filters: { id: ID.inv2 },
        payload: { status: 'void' },
      }, tokens.staff), 403, 'FORBIDDEN');
      assert.match(denied.message, /invoices/);
      const stillThere = await db.query('select status from public.invoices where id = $1', [ID.inv2]);
      assert.equal(stillThere.rows[0].status, 'draft'); // the write did not land

      // role-level: staff has no payments delete policy at all (financial audit trail)
      errorBody(await q({ table: 'payments', verb: 'delete', filters: { id: ID.pay1 } }, tokens.staff), 403, 'FORBIDDEN');
      // ...and no clinic_settings update policy
      errorBody(await q({ table: 'clinic_settings', verb: 'update', payload: { tax_rate: 99.0 } }, tokens.staff), 403, 'FORBIDDEN');
      // staff has no patients delete policy either
      errorBody(await q({ table: 'patients', verb: 'delete', filters: { id: ID.ada } }, tokens.staff), 403, 'FORBIDDEN');

      // admin, by contrast, may do all three
      okData(await q({ table: 'clinic_settings', select: 'id', verb: 'update', payload: { tax_rate: 15.00 } }, tokens.admin));
      okData(await q({ table: 'payments', select: 'id', verb: 'delete', filters: { id: ID.pay3 } }, tokens.admin));
    }),
  },
  {
    name: 'W30 a filter value that names another column compares the columns; quoted values stay literals',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      // admin, so every invoice is visible: what is under test is the
      // column-vs-column comparison itself, not who can see which row
      // (staff visibility is pinned by the policy-matrix cases).
      // total > paid_amount: inv1 (22 > 12.50) and inv2 (5 > 0), never fully-paid inv3
      const aging = okData(await q({ table: 'invoices', select: 'id', filters: { total: { op: 'gt', value: 'paid_amount' } } }, tokens.admin));
      assert.deepEqual(ids(aging), [ID.inv1, ID.inv2].sort());

      // the same comparison inside the or() grammar
      const viaOr = okData(await q({ table: 'invoices', select: 'id', or: 'total.gt.paid_amount,status.eq.void' }, tokens.admin));
      assert.deepEqual(ids(viaOr), [ID.inv1, ID.inv2].sort()); // the second term simply never matches

      // a nested and(...) group, W30's unpaid-aging report made precise:
      // owes money AND more than 10.00 outstanding -> only inv1
      const owed = okData(await q({ table: 'invoices', select: 'id', or: 'and(total.gt.paid_amount,paid_amount.gt.10),status.eq.void' }, tokens.admin));
      assert.deepEqual(ids(owed), [ID.inv1]);
    }),
  },
  {
    name: "W30 the UnpaidAging request answers with rows: or('status.eq.issued,status.eq.overdue') is not a 400",
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      // 'overdue' is not an invoice_status label — it never was, hosted or
      // local — so the enum filter compares on the column's ::text form and
      // the unknown term simply never matches instead of failing the request.
      const res = await q({
        table: 'invoices',
        select: 'id, status, total, paid_amount',
        filters: { total: { op: 'gt', value: 'paid_amount' } },
        or: 'status.eq.issued,status.eq.overdue',
      }, tokens.admin);
      assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.text}`);
      // exactly the issued invoices that still owe: inv1 (22.00/12.50).
      // inv2 is a draft, inv3 is fully paid — neither is issued-and-owing.
      assert.deepEqual(ids(okData(res)), [ID.inv1]);
      // the same layer still reads .eq('status','issued') as a string literal
      const issued = okData(await q({ table: 'invoices', select: 'id', filters: { status: 'issued' } }, tokens.admin));
      assert.deepEqual(ids(issued), [ID.inv1]);
      // and an out-of-enum equality matches nothing rather than erroring
      const none = okData(await q({ table: 'invoices', select: 'id', filters: { status: 'overdue' } }, tokens.admin));
      assert.deepEqual(none, []);
      // in-lists too: an out-of-enum member never matches, valid ones do
      const mixed = okData(await q({ table: 'invoices', select: 'id', filters: { status: { op: 'in', value: ['issued', 'overdue'] } } }, tokens.admin));
      assert.deepEqual(ids(mixed), [ID.inv1]);
      // writes still refuse a bad enum label — the text reading is read-only
      errorBody(await q({ table: 'invoices', verb: 'update', payload: { status: 'overdue' }, filters: { id: ID.inv2 } }, tokens.admin), 400, 'BAD_VALUE');
    }),
  },
  {
    name: 'W31 or() across two ilike columns, with a limit — the patients search box',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      const hits = okData(await q({
        table: 'patients',
        select: 'id, first_name, national_id',
        or: 'first_name.ilike.%ali%,national_id.ilike.%ali%',
      }, tokens.admin));
      assert.deepEqual(ids(hits), [ID.lonely]); // Aliki matches on both columns
      // ...and the same query cut to one row still finds her (limit rides with it)
      const limited = okData(await q({
        table: 'patients',
        select: 'id',
        or: 'first_name.ilike.%ali%,national_id.ilike.%ali%',
        order: [{ column: 'id' }],
        limit: 1,
      }, tokens.admin));
      assert.deepEqual(ids(limited), [ID.lonely]);
      // the two patterns are bound separately, even when identical
      const miss = okData(await q({ table: 'patients', select: 'id', or: 'first_name.ilike.%zz%,national_id.ilike.%zz%' }, tokens.admin));
      assert.deepEqual(miss, []);
    }),
  },
  {
    name: 'W32 upsert with on_conflict on a unique non-pk column (visit_notes.appointment_id)',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      const first = okData(await q({
        table: 'visit_notes',
        verb: 'upsert',
        payload: { appointment_id: ID.appt1, notes: 'first pass' },
        onConflict: 'appointment_id',
      }, tokens.staff));
      assert.equal(first.length, 1);
      assert.equal(first[0].notes, 'first pass');

      const second = okData(await q({
        table: 'visit_notes',
        verb: 'upsert',
        payload: { appointment_id: ID.appt1, notes: 'second pass' },
        onConflict: 'appointment_id',
      }, tokens.staff));
      assert.equal(second[0].id, first[0].id); // same row, updated — not a second row
      assert.equal(second[0].notes, 'second pass');
      const count = await db.query('select count(*)::int as n from public.visit_notes where appointment_id = $1', [ID.appt1]);
      assert.equal(count.rows[0].n, 1);

      // an on_conflict target that has no constraint is a 400, not a Postgres error
      errorBody(await q({
        table: 'visit_notes',
        verb: 'upsert',
        payload: { appointment_id: ID.appt1, notes: 'nope' },
        onConflict: 'notes',
      }, tokens.staff), 400, 'BAD_CONFLICT');
    }),
  },
  {
    name: 'user_roles is read-only and self-scoped: your token gets your rows, nothing else',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      const mine = okData(await q({ table: 'user_roles', select: 'role' }, tokens.staff));
      assert.deepEqual(mine, [{ role: 'user' }]);
      const adminMine = okData(await q({ table: 'user_roles', select: 'role' }, tokens.admin));
      assert.deepEqual(adminMine, [{ role: 'admin' }]); // admin is not above the policy: still only own rows
      // a filter cannot reach sideways: asking for admin rows yields nothing for staff
      const none = okData(await q({ table: 'user_roles', select: 'role', filters: { role: 'admin' } }, tokens.staff));
      assert.deepEqual(none, []);
      // and there is no write path for anyone but admin, who has one
      errorBody(await q({ table: 'user_roles', verb: 'insert', payload: { user_id: ID.ada, role: 'user' } }, tokens.staff), 403, 'FORBIDDEN');
    }),
  },
  {
    name: 'a bad payload is 400 with the reason, before anything is written',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      errorBody(await q({ table: 'patients', verb: 'insert', payload: { first_name: 'x', last_name: 'y', date_of_birth: '31/01/2026' } }, tokens.admin), 400, 'BAD_VALUE');
      errorBody(await q({ table: 'invoices', verb: 'insert', payload: { total: 'plenty' } }, tokens.admin), 400, 'BAD_VALUE');
      errorBody(await q({ table: 'invoices', verb: 'insert', payload: { status: 'underway' } }, tokens.admin), 400, 'BAD_VALUE');
      errorBody(await q({ table: 'invoices', verb: 'update', payload: [{ status: 'void' }, { status: 'paid' }], filters: { id: ID.inv2 } }, tokens.admin), 400, 'BAD_REQUEST');
      errorBody(await q({ table: 'patients', verb: 'insert' }, tokens.admin), 400, 'BAD_REQUEST'); // no payload
      const n = await db.query('select count(*)::int as n from public.patients');
      assert.equal(n.rows[0].n, 2);
    }),
  },
  {
    name: 'a filter value that looks like SQL is a value: it matches nothing and destroys nothing',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      const evil = "x'; drop table payments;--";
      // a text column, so the payload travels all the way to a bound comparison
      // (an enum column would also match nothing: its filter compares ::text)
      const hits = okData(await q({ table: 'patients', select: 'id', filters: { email: { op: 'eq', value: evil } } }, tokens.admin));
      assert.deepEqual(hits, []);
      const n = await db.query('select count(*)::int as n from public.payments');
      assert.equal(n.rows[0].n, 2); // the payments table is still there, with both rows
    }),
  },
  {
    name: 'select * is every column; a cast renames nothing; the projection keys follow the select',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      const row = okData(await q({ table: 'patients', select: '*', filters: { id: ID.ada }, single: true }, tokens.admin));
      for (const key of ['id', 'first_name', 'last_name', 'date_of_birth', 'sex', 'phone', 'email', 'address', 'national_id', 'created_at', 'updated_at']) {
        assert.ok(key in row, `select * is missing ${key}`);
      }
      assert.equal(row.date_of_birth, '1980-02-02'); // date -> string
      const cast = okData(await q({ table: 'invoices', select: 'id, total::text, paid:paid_amount, status:status', filters: { id: ID.inv1 }, single: true }, tokens.admin));
      assert.equal(typeof cast.total, 'string');
      assert.equal(cast.total, '22.00');
      assert.equal(cast.paid, 12.5);
      assert.equal(cast.status, 'issued');
    }),
  },
  {
    name: 'the WITH CHECK shape of the staff invoices insert is honoured: null appointment in, dangling one out, nothing half-written',
    fn: async (ctx) => withApi(ctx, async ({ q, db, tokens }) => {
      // staff invoices insert carries WITH CHECK (appointment exists OR is null)
      // — not the USING clause's stricter "appointment exists". So a new draft
      // with no appointment passes the check...
      const draft = okData(await q({
        table: 'invoices',
        select: 'id, status, appointment_id',
        verb: 'insert',
        payload: { appointment_id: null, tax_enabled: false, tax_rate: 0, status: 'draft' },
      }, tokens.staff));
      assert.equal(draft.length, 1);
      assert.equal(draft[0].appointment_id, null);
      assert.equal(draft[0].status, 'draft');

      // ...while an appointment_id pointing at nothing fails the same invariant
      // the check fragment asserts — the FK holds the line first — as a 400
      // envelope, and the transaction's rollback leaves nothing behind.
      const ghost = '00000000-0000-4000-8000-0000000000ff';
      errorBody(await q({
        table: 'invoices',
        verb: 'insert',
        payload: { appointment_id: ghost, tax_enabled: false, tax_rate: 0, status: 'draft' },
      }, tokens.staff), 400, 'FOREIGN_KEY_VIOLATION');
      const n = await db.query('select count(*)::int as n from public.invoices');
      assert.equal(n.rows[0].n, 4); // exactly the fixture three plus the legitimate draft
    }),
  },
];
