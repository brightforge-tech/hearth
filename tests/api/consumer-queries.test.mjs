// tests/api/consumer-queries.test.mjs — every shipped consumer's literal
// select string, replayed through POST /api/query (milestone 3 acceptance).
//
// The query API exists for exactly twelve importing files (Billing, Exports,
// Queue, Visit, Intake, AdminSettings, Auth/useAuth, LandingPage and the three
// report components), and each one sends one or more fixed select strings from
// its own source file. This suite pins those strings, copied from the shipped
// sources (a case below asserts they still occur there verbatim), and replays
// each against a running API so a change to the parser, the catalog or the
// projection that breaks a page fails HERE before it breaks /billing.
//
// The headliner is Billing.tsx's Recent Payments select: payments -> invoices
// -> appointments -> patients, THREE embed levels. The first cut of the parser
// capped embeds at two, and every load of the payments tab answered 400
// BAD_SELECT; that regression is what this file exists to prevent.
//
// Shape is asserted, not just status: the nested keys the pages dereference
// (payment.invoice.appointment.patient.first_name, item.service?.name,
// appointment?.patient, row.patients.phone) must exist with the right JSON
// kinds — objects for to-one embeds, null when the link points nowhere,
// arrays for to-many, numbers for numerics.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import pg from 'pg';

import { signToken } from '../../api/lib/tokens.mjs';
import { request, startServer } from '../helpers/server.mjs';

const SCRATCH = '_cq';
const JWT_SECRET = 'cq-consumer-suite-secret-0123456789abcdef';
const PATH = '/api/query';

const ID = {
  ada: '00000000-0000-4000-9000-000000000001',
  lonely: '00000000-0000-4000-9000-000000000002',
  appt1: '00000000-0000-4000-9000-000000000003',
  inv1: '00000000-0000-4000-9000-000000000004',
  inv2: '00000000-0000-4000-9000-000000000005',
  inv3: '00000000-0000-4000-9000-000000000006',
  item1: '00000000-0000-4000-9000-000000000007',
  item2: '00000000-0000-4000-9000-000000000008',
  item3: '00000000-0000-4000-9000-000000000009',
  pay1: '00000000-0000-4000-9000-00000000000a',
  pay2: '00000000-0000-4000-9000-00000000000b',
  pay3: '00000000-0000-4000-9000-00000000000c',
  hiddenService: '00000000-0000-4000-9000-00000000000d',
  admin: '00000000-0000-4000-9000-0000000000d1',
  staff: '00000000-0000-4000-9000-0000000000d2',
};

// One clinic's worth of fixture, shaped so every consumer select finds its
// rows: a booked patient (appt1, status waiting for Queue's filter), an
// invoice with a service-backed line and one without, an invoice with NO
// appointment (the `appointment: null` chains), and a payment on that
// appointment-less invoice (the `invoice.appointment: null` chain three
// levels down in the payments select).
const FIXTURE = [
  `insert into public.app_users (id, email, password_hash) values
     ($1, 'admin@cq.test', 'scrypt$cq$fixture$not-a-real-hash'),
     ($2, 'staff@cq.test', 'scrypt$cq$fixture$not-a-real-hash')`,
  [ID.admin, ID.staff],

  `insert into public.user_roles (user_id, role) values ($1, 'admin'), ($2, 'user')`,
  [ID.admin, ID.staff],

  `insert into public.services (id, code, name, description, price, taxable, show_on_landing)
   values ($1, 'CQ_HIDDEN', 'Hidden Lab Panel', 'not on the landing page', 99.00, true, false)`,
  [ID.hiddenService],

  `insert into public.patients (id, first_name, last_name, date_of_birth, sex, phone, email, address, national_id) values
     ($1, 'Ada', 'Example', '1980-02-02', 'f', '+1-555-0100', 'ada@cq.test', '1 Rose Crescent', 'NID-000'),
     ($2, 'Aliki', 'Notreal', null, 'f', '+1-555-0102', 'aliki@cq.test', '2 Laurel Lane', 'NID-ALIA')`,
  [ID.ada, ID.lonely],

  `insert into public.appointments (id, patient_id, scheduled_start, scheduled_end, duration_minutes, status, customer_type, reason)
   values ($1, $2, '2026-03-01T10:00:00Z', '2026-03-01T10:30:00Z', 30, 'waiting', 'appointment', 'annual checkup')`,
  [ID.appt1, ID.ada],

  `insert into public.visit_notes (appointment_id, notes) values ($1, 'first pass')`,
  [ID.appt1],

  // inv1: tax on, taxable 2x10.00 -> total 22.00 (recalc trigger), issued.
  // inv2: NO appointment, one non-service item. inv3: fully paid -> paid.
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

  // pay3 rides on inv2 — the invoice with no appointment, which is what
  // exercises the null at the third level of the payments select.
  `insert into public.payments (id, invoice_id, amount, method, reference) values
     ($1, $2, 12.50, 'cash', 'cq-counter'),
     ($3, $4, 5.00, 'card', 'cq-terminal'),
     ($5, $6, 2.00, 'transfer', 'cq-bank')`,
  [ID.pay1, ID.inv1, ID.pay2, ID.inv3, ID.pay3, ID.inv2],
];

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

// withApi: a freshly migrated scratch database, a running API, the fixture
// committed. Same harness as tests/api/query.test.mjs, own scratch name.
async function withApi({ root, testUrl }, fn) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const dsn = swapDb(testUrl, `${base}${SCRATCH}`);
  const scratch = `${base}${SCRATCH}`;
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

    const tokenFor = (which) =>
      signToken({ sub: ID[which], email: `${which}@cq.test` }, { secret: JWT_SECRET });
    const tokens = { admin: tokenFor('admin'), staff: tokenFor('staff') };

    const api = {
      db,
      tokens,
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

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// --- the shipped consumer selects, copied from src/ (drift-pinned below) -----

const BILLING_INVOICES =
  'id, status, total, paid_amount, currency_code, created_at, subtotal, tax_amount, tax_enabled, tax_rate, ' +
  'appointment:appointments( scheduled_start, reason, ' +
  'patient:patients(first_name, last_name, email, phone, address) ), ' +
  'invoice_items( description, quantity, unit_price, line_total, service:services(name) )';

const BILLING_PAYMENTS =
  'id, amount, method, reference, received_at, invoice_id, ' +
  'invoice:invoices( id, total, currency_code, ' +
  'appointment:appointments( patient:patients(first_name, last_name, email, phone, address) ) )';

const QUEUE_APPOINTMENTS =
  'id, scheduled_start, created_at, reason, patient_id, status, patient:patients(first_name,last_name)';

const VISIT_APPOINTMENT = 'id, status, scheduled_start, patient:patients(first_name,last_name)';
const VISIT_SERVICES = 'id, code, name, price, taxable, active';

const TODAYS_SCHEDULE =
  'id, scheduled_start, scheduled_end, duration_minutes, reason, status, customer_type, ' +
  'patients ( first_name, last_name, phone )';

const UNPAID_AGING =
  'id, created_at, total, paid_amount, status, currency_code, ' +
  'appointments ( patients ( first_name, last_name, phone ) )';

const ADMIN_PATIENTS =
  '*, appointments( id, reason, status, scheduled_start, visit_notes(notes) )';

const INTAKE_SEARCH = 'id, first_name, last_name, national_id, drivers_permit';

const LANDING_SERVICES = 'id, name, description';

// Every entry: the page's file (for the drift pin), the table, the literal
// select, who calls it, optional request extras, and the shape assertion.
const CONSUMERS = [
  {
    file: 'src/pages/Billing.tsx',
    table: 'invoices',
    select: BILLING_INVOICES,
    body: { order: [{ column: 'created_at', ascending: false }] },
    check(rows, { tokens }) {
      assert.ok(rows.length >= 3, `Billing invoices select found ${rows.length} rows`);
      const inv1 = rows.find((r) => r.id === ID.inv1);
      const inv2 = rows.find((r) => r.id === ID.inv2);
      assert.ok(inv1 && inv2);
      for (const key of ['total', 'paid_amount', 'subtotal', 'tax_amount']) {
        assert.equal(typeof inv1[key], 'number', `${key} must be a JSON number for .toFixed(2)`);
      }
      assert.equal(typeof inv1.tax_enabled, 'boolean');
      assert.equal(typeof inv1.tax_rate, 'number');
      // appointment -> patient (two levels), the page's invoice.appointment?.patient... chain
      assert.equal(inv1.appointment.patient.first_name, 'Ada');
      assert.equal(inv1.invoice_items[0].service.name, 'Initial Consultation');
      // the nulls the optional chains guard: no appointment, no service
      assert.equal(inv2.appointment, null);
      assert.equal(inv2.invoice_items[0].service, null);
      assert.ok(Array.isArray(inv1.invoice_items));
    },
  },
  {
    file: 'src/pages/Billing.tsx',
    table: 'payments',
    select: BILLING_PAYMENTS, // THREE embed levels: invoices -> appointments -> patients
    body: { order: [{ column: 'received_at', ascending: false }], limit: 50 },
    check(rows) {
      assert.equal(rows.length, 3, `Recent Payments must list every payment row: ${JSON.stringify(rows.map((r) => r.id))}`);
      const onAppt = rows.find((r) => r.id === ID.pay1);
      const orphan = rows.find((r) => r.id === ID.pay3);
      // the exact keys Billing.tsx's Recent Payments table dereferences
      for (const key of ['id', 'amount', 'method', 'reference', 'received_at', 'invoice_id']) {
        assert.ok(key in onAppt, `payments row is missing ${key}`);
      }
      assert.equal(typeof onAppt.amount, 'number');
      assert.equal(onAppt.invoice.id, ID.inv1);
      assert.equal(typeof onAppt.invoice.total, 'number');
      assert.equal(onAppt.invoice.currency_code, 'USD');
      // third level: payment -> invoice -> appointment -> patient
      assert.equal(onAppt.invoice.appointment.patient.first_name, 'Ada');
      assert.equal(onAppt.invoice.appointment.patient.email, 'ada@cq.test');
      // and the null at the third level when the invoice has no appointment
      assert.equal(orphan.invoice.id, ID.inv2);
      assert.equal(orphan.invoice.appointment, null);
    },
  },
  {
    file: 'src/pages/Queue.tsx',
    table: 'appointments',
    select: QUEUE_APPOINTMENTS,
    body: { filters: { status: 'waiting' }, order: [{ column: 'created_at', ascending: true }] },
    check(rows) {
      assert.deepEqual(rows.map((r) => r.id), [ID.appt1]);
      assert.deepEqual(rows[0].patient, { first_name: 'Ada', last_name: 'Example' });
    },
  },
  {
    file: 'src/pages/Visit.tsx',
    table: 'appointments',
    select: VISIT_APPOINTMENT,
    body: { filters: { id: ID.appt1 }, maybeSingle: true },
    check(row) {
      assert.equal(row.id, ID.appt1);
      assert.equal(row.status, 'waiting');
      assert.deepEqual(row.patient, { first_name: 'Ada', last_name: 'Example' });
    },
  },
  {
    file: 'src/pages/Visit.tsx',
    table: 'services',
    select: VISIT_SERVICES,
    body: { filters: { code: 'CONSULT_INIT' }, maybeSingle: true },
    check(row) {
      assert.equal(row.name, 'Initial Consultation');
      assert.equal(typeof row.price, 'number');
      assert.equal(typeof row.taxable, 'boolean');
      assert.equal(typeof row.active, 'boolean');
    },
  },
  {
    file: 'src/components/reports/TodaysSchedule.tsx',
    table: 'appointments',
    select: TODAYS_SCHEDULE, // note the space before each "(" — PostgREST tolerates it, so must we
    check(rows) {
      const appt = rows.find((r) => r.id === ID.appt1);
      assert.ok(appt, 'TodaysSchedule found no appointments');
      assert.equal(appt.patients.first_name, 'Ada');
      assert.equal(appt.patients.phone, '+1-555-0100');
      assert.equal(appt.customer_type, 'appointment');
      assert.equal(typeof appt.duration_minutes, 'number');
      // the timestamptz comes back as an ISO string whose spelled-out offset
      // depends on the server's TimeZone, so compare the instant, not the text
      assert.equal(new Date(appt.scheduled_end).toISOString(), '2026-03-01T10:30:00.000Z');
    },
  },
  {
    file: 'src/components/reports/UnpaidAging.tsx',
    table: 'invoices',
    select: UNPAID_AGING,
    check(rows) {
      const inv1 = rows.find((r) => r.id === ID.inv1);
      const inv2 = rows.find((r) => r.id === ID.inv2);
      assert.equal(inv1.appointments.patients.last_name, 'Example');
      assert.equal(typeof inv1.total, 'number');
      assert.equal(typeof inv1.paid_amount, 'number');
      // inv2 (no appointment) must be appointments: null, not missing — the
      // report does invoice.appointments?.patients?.first_name
      assert.equal(inv2.appointments, null);
    },
  },
  {
    file: 'src/components/reports/UnpaidAging.tsx',
    table: 'invoices',
    select: UNPAID_AGING,
    // the report's FULL request: 'overdue' is not an invoice_status label, so
    // that or() term must simply never match — not 400 the whole request (W30)
    body: {
      filters: { total: { op: 'gt', value: 'paid_amount' } },
      or: 'status.eq.issued,status.eq.overdue',
      order: [{ column: 'created_at', ascending: false }],
    },
    check(rows) {
      // only the issued invoice that still owes money (22.00 paid 12.50);
      // the drafts are not issued, and the fully-paid one does not owe
      assert.deepEqual(rows.map((r) => r.id), [ID.inv1]);
      assert.equal(typeof rows[0].paid_amount, 'number');
    },
  },
  {
    file: 'src/pages/AdminSettings.tsx',
    table: 'clinic_settings',
    select: '*',
    check(rows) {
      assert.equal(rows.length, 1);
      assert.equal(typeof rows[0].tax_rate, 'number'); // the singleton carries the clinic's tax fields
    },
  },
  {
    file: 'src/pages/AdminSettings.tsx',
    table: 'services',
    select: '*',
    check(rows) {
      assert.equal(rows.length, 6); // five seeded + the hidden fixture service
      assert.ok(rows.some((s) => s.code === 'CQ_HIDDEN')); // the admin page sees hidden rows
    },
  },
  {
    file: 'src/pages/AdminSettings.tsx',
    table: 'patients',
    select: ADMIN_PATIENTS, // '*' mixed with a two-level embed
    body: { order: [{ column: 'created_at', ascending: false }] },
    check(rows) {
      const ada = rows.find((r) => r.id === ID.ada);
      assert.ok(ada, 'AdminSettings patients list lost a row');
      for (const key of ['id', 'first_name', 'last_name', 'email', 'phone', 'address']) {
        assert.ok(key in ada, `select * is missing ${key}`);
      }
      assert.equal(ada.appointments.length, 1);
      assert.equal(ada.appointments[0].reason, 'annual checkup');
      assert.deepEqual(ada.appointments[0].visit_notes, [{ notes: 'first pass' }]);
    },
  },
  {
    file: 'src/pages/Intake.tsx',
    table: 'patients',
    select: INTAKE_SEARCH,
    body: { or: 'first_name.ilike.%ali%,national_id.ilike.%ali%' },
    check(rows) {
      assert.deepEqual(rows.map((r) => r.id), [ID.lonely]);
      assert.equal(rows[0].national_id, 'NID-ALIA');
    },
  },
  {
    file: 'src/pages/Exports.tsx',
    table: 'invoices',
    select: 'id, total, status',
    check(rows) {
      assert.equal(rows.length, 3);
      assert.ok(rows.every((r) => typeof r.total === 'number' && typeof r.status === 'string' && typeof r.id === 'string'));
    },
  },
  {
    file: 'src/pages/Exports.tsx',
    table: 'payments',
    select: 'id, amount',
    check(rows) {
      assert.equal(rows.length, 3);
      assert.ok(rows.every((r) => typeof r.amount === 'number'));
    },
  },
  {
    file: 'src/components/reports/RevenueSummary.tsx',
    table: 'invoices',
    select: 'total, paid_amount, status, created_at',
    check(rows) {
      assert.ok(rows.length >= 3);
      const r = rows[0];
      for (const key of ['total', 'paid_amount']) assert.equal(typeof r[key], 'number');
      assert.equal(typeof r.status, 'string');
      assert.equal(typeof r.created_at, 'string');
    },
  },
  {
    file: 'src/hooks/useAuth.tsx',
    table: 'user_roles',
    select: 'role',
    caller: 'staff',
    body: { filters: { user_id: ID.staff } },
    check(rows) {
      assert.deepEqual(rows, [{ role: 'user' }]);
    },
  },
  {
    file: 'src/pages/LandingPage.tsx',
    table: 'services',
    select: LANDING_SERVICES,
    caller: 'anon',
    body: { filters: { active: true, show_on_landing: true }, order: [{ column: 'name' }] },
    check(rows) {
      assert.equal(rows.length, 5, 'the landing page sees exactly the seeded landing services');
      assert.ok(!rows.some((s) => s.code === 'CQ_HIDDEN'));
      for (const key of ['id', 'name', 'description']) assert.ok(key in rows[0]);
    },
  },
];

const byId = (rows, id) => rows.find((r) => r.id === id);

export default [
  {
    name: 'every shipped consumer select replays through /api/query with the page-ready shape (incl. Billing payments, 3 embed levels)',
    fn: async (ctx) => withApi(ctx, async ({ q, tokens }) => {
      for (const c of CONSUMERS) {
        const token = c.caller === 'anon' ? null : tokens[c.caller ?? 'admin'];
        const res = await q({ table: c.table, verb: 'select', select: c.select, ...(c.body ?? {}) }, token);
        assert.equal(
          res.status, 200,
          `${c.file}: ${c.table} select answered ${res.status}: ${res.text.slice(0, 300)}`
        );
        assert.equal(res.json.error, null, `${c.file}: ${c.table} select errored: ${JSON.stringify(res.json.error)}`);
        try {
          c.check(res.json.data, { tokens, byId });
        } catch (e) {
          e.message = `${c.file} (${c.table}): ${e.message}`;
          throw e;
        }
      }
    }),
  },
  {
    name: 'each consumer select string in this suite still occurs verbatim in the shipped page source',
    fn: async (ctx) => {
      for (const c of CONSUMERS) {
        const src = readFileSync(join(ctx.root, c.file), 'utf8');
        if (c.select === '*') continue; // `.select("*")` / no-arg selects are trivial
        assert.ok(
          norm(src).includes(norm(c.select)),
          `${c.file} no longer contains the select string this suite replays:\n  ${norm(c.select)}`
        );
      }
    },
  },
];
