// tests/parity/query-shape.test.mjs — every consumer query, replayed against
// the new API, with the response shape checked against what
// src/integrations/supabase/types.ts declares (task t14; milestone-5 parity).
//
// The twelve consumer files (LandingPage, Billing, Exports, Queue, Visit,
// Intake, AdminSettings, useAuth and the three report components) were written
// against the hosted PostgREST contract: each page dereferences fixed keys and
// trusts fixed nesting (payment.invoice.appointment.patient.first_name,
// invoice.appointment?.patient, appointment.patients.phone). types.ts is the
// machine-readable statement of that contract, generated from the hosted
// schema. This suite replays every one of those selects through the new API
// — as admin, as 'user'-role staff, and, for the two landing-page queries,
// anonymously — and for every returned row asserts:
//
//   * the key set is EXACTLY the selected columns plus the embed aliases
//     (PostgREST returned nothing else, and a page iterating Object.keys
//     would notice if we did),
//   * every plain key and every nested key occurs in the types.ts Row block
//     of the table that owns it — the same field names, declared, for that
//     query,
//   * each value is of the kind types.ts declares (numbers as JSON numbers
//     for the .toFixed(2) calls, strings, booleans), and each to-one embed is
//     an object or a deliberate null, a to-many embed an array.
//
// The RPC the AdminSettings Users panel makes (get_users_with_roles) is
// replayed here too — it is the "users" query of that page's four.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createScratch, dropScratch, connectDb, seedUsers } from '../helpers/db.mjs';
import { startTestApp, makeTokens } from '../helpers/http.mjs';

const SCRATCH = '_pshape';
const JWT_SECRET = 'p14-parity-query-shape-secret-012345678';

const ID = {
  ada: '00000000-0000-4000-f000-000000000001',
  aliki: '00000000-0000-4000-f000-000000000002',
  appt1: '00000000-0000-4000-f000-000000000003',
  appt2: '00000000-0000-4000-f000-000000000004',
  inv1: '00000000-0000-4000-f000-000000000005',
  inv2: '00000000-0000-4000-f000-000000000006',
  inv3: '00000000-0000-4000-f000-000000000007',
  hidden: '00000000-0000-4000-f000-000000000008',
  admin: '00000000-0000-4000-f000-0000000000d1',
  staff: '00000000-0000-4000-f000-0000000000d2',
};

// One clinic: a booked patient (Ada: waiting + in-progress appointments, an
// invoice that still owes, a fully-paid invoice), a patient nobody has booked
// (Aliki — invisible to staff under the ported patients policy, visible to
// admin, findable by Intake's ilike search), an appointment-less invoice with
// a payment on it, a hidden service the landing page must never see.
const FIXTURE = [
  `insert into public.patients (id, first_name, last_name, sex, phone, email, address, national_id) values
     ($1, 'Ada', 'Example', 'f', '+1-555-0100', 'ada@p14.test', '1 Rose Crescent', 'NID-000'),
     ($2, 'Aliki', 'Notreal', null, '+1-555-0102', 'aliki@p14.test', '2 Laurel Lane', 'NID-ALIA')`,
  [ID.ada, ID.aliki],

  `insert into public.appointments (id, patient_id, scheduled_start, scheduled_end, duration_minutes, status, reason) values
     ($1, $2, '2026-03-01T10:00:00Z', '2026-03-01T10:30:00Z', 30, 'waiting', 'annual checkup'),
     ($3, $2, '2026-03-01T11:00:00Z', '2026-03-01T11:20:00Z', 20, 'in_progress', 'dressing change')`,
  [ID.appt1, ID.ada, ID.appt2],

  `insert into public.visit_notes (appointment_id, notes) values ($1, 'first pass')`, [ID.appt1],

  `insert into public.services (id, code, name, description, price, taxable, show_on_landing)
   values ($1, 'P14_HIDDEN', 'Hidden Panel', 'not on the landing page', 99.00, true, false)`,
  [ID.hidden],

  `insert into public.invoices (id, appointment_id, tax_enabled, tax_rate, status) values
     ($1, $2, true, 10.00, 'issued'),
     ($3, null, false, 0.00, 'draft'),
     ($4, $5, false, 0.00, 'draft')`,
  [ID.inv1, ID.appt1, ID.inv2, ID.inv3, ID.appt2],

  `insert into public.invoice_items (invoice_id, service_id, description, quantity, unit_price, taxable) values
     ($1, (select id from public.services where code = 'CONSULT_INIT'), 'Initial Consultation x2', 2, 10.00, true),
     ($2, null, 'Bandage', 1, 5.00, false),
     ($3, null, 'Quick check', 1, 5.00, false)`,
  [ID.inv1, ID.inv2, ID.inv3],

  `insert into public.payments (invoice_id, amount, method, reference) values
     ($1, 12.50, 'cash', 'p14-counter'),
     ($2, 5.00, 'card', 'p14-terminal'),
     ($3, 2.00, 'transfer', 'p14-bank')`,
  [ID.inv1, ID.inv3, ID.inv2],
];

// --- the shipped consumer selects, as their pages write them ------------------

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
  'id, scheduled_start, created_at, reason, intake_notes, patient_id, status, patient:patients(first_name,last_name)';

const VISIT_APPOINTMENT = 'id, status, scheduled_start, reason, intake_notes, patient:patients(first_name,last_name)';
const VISIT_SERVICES = 'id, code, name, price, taxable, active';

const TODAYS_SCHEDULE =
  'id, scheduled_start, scheduled_end, duration_minutes, reason, status, customer_type, ' +
  'patients ( first_name, last_name, phone )';

const UNPAID_AGING =
  'id, created_at, total, paid_amount, status, currency_code, ' +
  'appointments ( patients ( first_name, last_name, phone ) )';

const ADMIN_PATIENTS = '*, appointments( id, reason, status, scheduled_start, visit_notes(notes) )';

const INTAKE_SEARCH = 'id, first_name, last_name, national_id, drivers_permit';

const LANDING_SERVICES = 'id, name, description';

// --- the shape grammar ---------------------------------------------------------
//
// A spec says, per level: which plain columns (with the JSON kind types.ts
// implies) and which embeds (with the relation table they read, one or many,
// whether null is legal, and their own nested spec).

const n = 'number';
const s = 'string';
const b = 'boolean';

const PATIENT_MIN = { columns: { first_name: s, last_name: s }, rel: 'patients' };
// Billing's Recent Payments third-level embed asks for five patient columns.
const PATIENT_FULL = {
  rel: 'patients',
  columns: { first_name: s, last_name: s, email: s, phone: s, address: s },
};

const QUERIES = [
  {
    name: 'LandingPage public services select',
    table: 'services',
    select: LANDING_SERVICES,
    body: { filters: { active: true, show_on_landing: true }, order: [{ column: 'name' }] },
    callers: ['anonymous', 'staff', 'admin'],
    minRows: { anonymous: 5, staff: 5, admin: 5 }, // every seeded service is active+show_on_landing
    spec: { columns: { id: s, name: s, description: s } },
  },
  {
    name: 'Billing invoices select (appointment -> patient, invoice_items -> service)',
    table: 'invoices',
    select: BILLING_INVOICES,
    body: { order: [{ column: 'created_at', ascending: false }] },
    callers: ['staff', 'admin'],
    minRows: { staff: 2, admin: 3 }, // staff: the policy hides the appointment-less draft
    spec: {
      columns: { id: s, status: s, total: n, paid_amount: n, currency_code: s, created_at: s, subtotal: n, tax_amount: n, tax_enabled: b, tax_rate: n },
      embeds: {
        appointment: {
          rel: 'appointments',
          nullable: true,
          columns: { scheduled_start: s, reason: s },
          embeds: { patient: { ...PATIENT_MIN, columns: { ...PATIENT_MIN.columns, email: s, phone: s, address: s } } },
        },
        invoice_items: {
          rel: 'invoice_items',
          many: true,
          columns: { description: s, quantity: n, unit_price: n, line_total: n },
          embeds: { service: { rel: 'services', nullable: true, columns: { name: s } } },
        },
      },
    },
  },
  {
    name: 'Billing Recent Payments select (three embed levels, incl. the third-level null)',
    table: 'payments',
    select: BILLING_PAYMENTS,
    body: { order: [{ column: 'received_at', ascending: false }], limit: 50 },
    callers: ['staff', 'admin'],
    minRows: { staff: 2, admin: 3 },
    spec: {
      columns: { id: s, amount: n, method: s, reference: s, received_at: s, invoice_id: s },
      embeds: {
        invoice: {
          rel: 'invoices',
          columns: { id: s, total: n, currency_code: s },
          embeds: { appointment: { rel: 'appointments', nullable: true, embeds: { patient: PATIENT_FULL } } },
        },
      },
    },
  },
  {
    name: 'Exports stats selects (invoices id,total,status; payments id,amount)',
    table: 'invoices',
    select: 'id, total, status',
    callers: ['staff', 'admin'],
    minRows: { admin: 3, staff: 2 },
    spec: { columns: { id: s, total: n, status: s } },
  },
  {
    name: 'Exports payments stats',
    table: 'payments',
    select: 'id, amount',
    callers: ['staff', 'admin'],
    minRows: { admin: 3, staff: 2 },
    spec: { columns: { id: s, amount: n } },
  },
  {
    name: 'Queue waiting select',
    table: 'appointments',
    select: QUEUE_APPOINTMENTS,
    body: { filters: { status: 'waiting' }, order: [{ column: 'created_at', ascending: true }] },
    callers: ['staff', 'admin'],
    minRows: { staff: 1, admin: 1 },
    spec: {
      columns: { id: s, scheduled_start: s, created_at: s, reason: s, intake_notes: s, patient_id: s, status: s },
      embeds: { patient: PATIENT_MIN },
    },
  },
  {
    name: 'Queue in-progress select',
    table: 'appointments',
    select: QUEUE_APPOINTMENTS,
    body: { filters: { status: 'in_progress' }, order: [{ column: 'created_at', ascending: true }] },
    callers: ['staff', 'admin'],
    minRows: { staff: 1, admin: 1 },
    spec: {
      columns: { id: s, scheduled_start: s, created_at: s, reason: s, intake_notes: s, patient_id: s, status: s },
      embeds: { patient: PATIENT_MIN },
    },
  },
  {
    name: 'Visit appointment select (maybeSingle)',
    table: 'appointments',
    select: VISIT_APPOINTMENT,
    body: { filters: { id: ID.appt1 }, maybeSingle: true },
    callers: ['staff', 'admin'],
    single: true,
    spec: { columns: { id: s, status: s, scheduled_start: s, reason: s, intake_notes: s }, embeds: { patient: PATIENT_MIN } },
  },
  {
    name: 'Visit service-by-code select (maybeSingle)',
    table: 'services',
    select: VISIT_SERVICES,
    body: { filters: { code: 'CONSULT_INIT' }, maybeSingle: true },
    callers: ['staff', 'admin'],
    single: true,
    spec: { columns: { id: s, code: s, name: s, price: n, taxable: b, active: b } },
  },
  {
    name: 'Intake patient search (or(ilike) across two columns)',
    table: 'patients',
    select: INTAKE_SEARCH,
    body: { or: 'first_name.ilike.%ali%,national_id.ilike.%ali%' },
    callers: ['staff', 'admin'],
    minRows: { admin: 1, staff: 0 }, // Aliki is unbooked — invisible to staff, still 200
    spec: { columns: { id: s, first_name: s, last_name: s, national_id: s, drivers_permit: s } },
  },
  {
    name: 'AdminSettings settings select (*)',
    table: 'clinic_settings',
    select: '*',
    callers: ['staff', 'admin'],
    minRows: { staff: 1, admin: 1 },
    spec: { columns: { id: s, singleton: b, currency_code: s, tax_enabled: b, tax_name: s, tax_rate: n }, wild: true },
  },
  {
    name: 'AdminSettings services select (*)',
    table: 'services',
    select: '*',
    callers: ['staff', 'admin'],
    minRows: { staff: 6, admin: 6 },
    spec: { columns: { id: s, code: s, name: s, price: n, taxable: b, active: b }, wild: true },
  },
  {
    name: 'AdminSettings patients select (* with two-level embed incl. visit_notes)',
    table: 'patients',
    select: ADMIN_PATIENTS,
    body: { order: [{ column: 'created_at', ascending: false }] },
    callers: ['staff', 'admin'],
    minRows: { admin: 2, staff: 1 }, // the ported patients policy hides Aliki from staff
    spec: {
      columns: { id: s, first_name: s, last_name: s, email: s, phone: s, address: s, created_at: s },
      wild: true,
      embeds: {
        appointments: {
          rel: 'appointments',
          many: true,
          columns: { id: s, reason: s, status: s, scheduled_start: s },
          embeds: { visit_notes: { rel: 'visit_notes', many: true, columns: { notes: s } } },
        },
      },
    },
  },
  {
    name: 'useAuth roles select (each caller sees only their own user_roles rows)',
    table: 'user_roles',
    select: 'role',
    bodyFor: (caller) => ({ filters: { user_id: caller === 'staff' ? ID.staff : ID.admin } }),
    callers: ['staff', 'admin'],
    minRows: { staff: 1, admin: 1 },
    spec: { columns: { role: s } },
  },
  {
    name: 'Reports RevenueSummary select',
    table: 'invoices',
    select: 'total, paid_amount, status, created_at',
    callers: ['staff', 'admin'],
    minRows: { staff: 2, admin: 3 },
    spec: { columns: { total: n, paid_amount: n, status: s, created_at: s } },
  },
  {
    name: 'Reports TodaysSchedule select (patients embed with spaces)',
    table: 'appointments',
    select: TODAYS_SCHEDULE,
    callers: ['staff', 'admin'],
    minRows: { staff: 2, admin: 2 },
    spec: {
      columns: { id: s, scheduled_start: s, scheduled_end: s, duration_minutes: n, reason: s, status: s, customer_type: s },
      embeds: { patients: { ...PATIENT_MIN, columns: { ...PATIENT_MIN.columns, phone: s } } },
    },
  },
  {
    name: 'Reports UnpaidAging select',
    table: 'invoices',
    select: UNPAID_AGING,
    callers: ['staff', 'admin'],
    minRows: { staff: 2, admin: 3 },
    spec: {
      columns: { id: s, created_at: s, total: n, paid_amount: n, status: s, currency_code: s },
      embeds: {
        appointments: {
          rel: 'appointments',
          nullable: true,
          embeds: { patients: { ...PATIENT_MIN, columns: { ...PATIENT_MIN.columns, phone: s } } },
        },
      },
    },
  },
  {
    name: "Reports UnpaidAging full request: or('status.eq.issued,status.eq.overdue') with gt('total','paid_amount')",
    table: 'invoices',
    select: UNPAID_AGING,
    body: {
      filters: { total: { op: 'gt', value: 'paid_amount' } },
      or: 'status.eq.issued,status.eq.overdue',
      order: [{ column: 'created_at', ascending: false }],
    },
    callers: ['staff', 'admin'],
    minRows: { staff: 1, admin: 1 },
    expectIds: [ID.inv1], // only the issued invoice that still owes
    spec: {
      columns: { id: s, created_at: s, total: n, paid_amount: n, status: s, currency_code: s },
      embeds: {
        appointments: {
          rel: 'appointments',
          nullable: true,
          embeds: { patients: { ...PATIENT_MIN, columns: { ...PATIENT_MIN.columns, phone: s } } },
        },
      },
    },
  },
];

// --- types.ts -------------------------------------------------------------------

// parseTypesColumns(src): each table's Row-block column names, exactly as the
// generated client declares them (the block sits between `Row: {` and
// `Insert: {` at the same indent).
function parseTypesColumns(src) {
  const tables = {};
  const tableRe = /^      (\w+): \{\r?\n        Row: \{([\s\S]*?)\r?\n        Insert: \{/gm;
  for (const m of src.matchAll(tableRe)) {
    const cols = new Set();
    for (const line of m[2].split(/\r?\n/)) {
      const key = /^\s+(\w+):/.exec(line);
      if (key) cols.add(key[1]);
    }
    tables[m[1]] = cols;
  }
  return tables;
}

// --- the shape checker -----------------------------------------------------------

function checkShape(row, spec, path, tables, table, errors) {
  const declared = tables[table];
  const embedKeys = Object.keys(spec.embeds ?? {});
  const expectedKeys = [...Object.keys(spec.columns ?? {}), ...embedKeys];

  for (const key of Object.keys(row)) {
    // `select: '*'` returns every physical column, so the spec lists the
    // interesting ones; a wild row may legitimately carry more.
    if (!spec.wild && !expectedKeys.includes(key)) errors.push(`${path}: unexpected key ${JSON.stringify(key)} (PostgREST returned only ${expectedKeys.join(', ')})`);
  }
  for (const key of expectedKeys) {
    if (!(key in row)) errors.push(`${path}: missing key ${JSON.stringify(key)}`);
  }
  for (const [key, kind] of Object.entries(spec.columns ?? {})) {
    if (!(key in row)) continue;
    if (key !== 'id' && !declared.has(key)) errors.push(`${path}.${key}: not declared in types.ts Table ${table} Row`);
    const value = row[key];
    if (value === null) {
      if (key !== 'reference' && key !== 'description' && key !== 'reason' && key !== 'drivers_permit' && key !== 'notes' && key !== 'intake_notes') {
        // every column this suite seeds carries a value; a null here means a
        // real type/serialization drift
        errors.push(`${path}.${key}: null where the fixture seeded a ${kind}`);
      }
      continue;
    }
    if (typeof value !== kind) errors.push(`${path}.${key}: expected a JSON ${kind}, got ${typeof value} (${JSON.stringify(value)})`);
  }
  for (const [key, embed] of Object.entries(spec.embeds ?? {})) {
    if (!(key in row)) continue;
    const value = row[key];
    if (value === null) {
      if (!embed.nullable) errors.push(`${path}.${key}: null where a ${embed.rel} object was required`);
      continue;
    }
    if (embed.many) {
      if (!Array.isArray(value)) errors.push(`${path}.${key}: expected an array of ${embed.rel}, got ${typeof value}`);
      else value.forEach((entry, i) => checkShape(entry, embed, `${path}.${key}[${i}]`, tables, embed.rel, errors));
    } else {
      if (typeof value !== 'object') errors.push(`${path}.${key}: expected a ${embed.rel} object, got ${typeof value}`);
      else checkShape(value, embed, `${path}.${key}`, tables, embed.rel, errors);
    }
  }
}

// --- harness -----------------------------------------------------------------------

async function withParityApp({ root, testUrl }, fn) {
  const dsn = await createScratch(testUrl, SCRATCH);
  const app = await startTestApp({ root, databaseUrl: dsn, jwtSecret: JWT_SECRET, resend: false });
  const db = await connectDb(dsn);
  try {
    await seedUsers(db, [
      { id: ID.admin, email: 'admin@p14.test', roles: ['admin'] },
      { id: ID.staff, email: 'staff@p14.test', roles: ['user'] },
    ]);
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);
    const tokens = makeTokens(JWT_SECRET, [
      { key: 'admin', id: ID.admin, email: 'admin@p14.test' },
      { key: 'staff', id: ID.staff, email: 'staff@p14.test' },
    ]);
    try {
      return await fn({ app, db, tokens });
    } catch (e) {
      e.message = `${e.message}\n--- server log ---\n${app.log()}`;
      throw e;
    }
  } finally {
    try { await db.end(); } catch { /* already gone */ }
    await app.stop();
    await dropScratch(testUrl, SCRATCH);
  }
}

export default [
  {
    name: 'types.ts declares a Row block with the columns the consumer queries read',
    fn: async ({ root }) => {
      const tables = parseTypesColumns(readFileSync(join(root, 'src', 'integrations', 'supabase', 'types.ts'), 'utf8'));
      for (const table of ['appointments', 'clinic_settings', 'invoice_items', 'invoices', 'patients', 'payments', 'services', 'visit_notes']) {
        assert.ok(tables[table]?.size > 0, `types.ts has no Row columns for ${table}`);
      }
      for (const [table, cols] of [
        ['invoices', ['total', 'paid_amount', 'subtotal', 'tax_amount', 'currency_code', 'status']],
        ['payments', ['amount', 'method', 'reference', 'received_at', 'invoice_id']],
        ['patients', ['first_name', 'last_name', 'email', 'phone', 'address', 'national_id', 'drivers_permit']],
        ['appointments', ['scheduled_start', 'scheduled_end', 'duration_minutes', 'customer_type', 'reason']],
        ['services', ['code', 'name', 'description', 'price', 'taxable', 'active', 'show_on_landing']],
        ['user_roles', ['role']],
      ]) {
        for (const col of cols) assert.ok(tables[table].has(col), `types.ts Table ${table} Row is missing ${col}`);
      }
    },
  },
  {
    name: 'every consumer query runs as admin, as staff and (landing) anonymously, and its rows carry the types.ts field names and nesting keys',
    fn: async (ctx) => withParityApp(ctx, async ({ app, tokens }) => {
      const tables = parseTypesColumns(readFileSync(join(ctx.root, 'src', 'integrations', 'supabase', 'types.ts'), 'utf8'));
      const problems = [];
      for (const query of QUERIES) {
        for (const caller of query.callers) {
          const body = {
            table: query.table,
            verb: 'select',
            select: query.select,
            ...((query.bodyFor ? query.bodyFor(caller) : query.body) ?? {}),
          };
          const res = await app.api('/api/query', body, tokens[caller]);
          const where = `${query.name} [${caller}]`;
          if (res.status !== 200) {
            problems.push(`${where}: ${res.status} ${res.text.slice(0, 120)}`);
            continue;
          }
          if (res.json.error !== null) {
            problems.push(`${where}: error envelope ${JSON.stringify(res.json.error)}`);
            continue;
          }
          const rows = query.single ? [res.json.data] : res.json.data;
          if (query.single && res.json.data === null) {
            problems.push(`${where}: maybeSingle found nothing`);
            continue;
          }
          const min = query.minRows?.[caller] ?? 1;
          if (rows.length < min) problems.push(`${where}: ${rows.length} rows, expected at least ${min}`);
          if (query.expectIds) assert.deepEqual(rows.map((r) => r.id), query.expectIds, `${where}: row set drifted`);
          const errors = [];
          rows.forEach((row, i) => checkShape(row, query.spec, `${where}#${i}`, tables, query.table, errors));
          problems.push(...errors);
        }
      }
      assert.deepEqual(problems, [], `consumer query shape drift:\n${problems.join('\n')}`);
    }),
  },
  {
    name: 'the landing page can no longer insert a patient anonymously; its booking form posts a request that returns no data',
    fn: async (ctx) => withParityApp(ctx, async ({ app }) => {
      const res = await app.api(
        '/api/query',
        {
          table: 'patients',
          verb: 'insert',
          payload: { first_name: 'Rowan', last_name: 'Fields', email: 'rowan@p14.test', phone: '+1-555-0177', date_of_birth: null },
          select: '*',
          single: true,
        },
        null
      );
      assert.equal(res.status, 401, res.text.slice(0, 300));
      const day = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const booked = await app.api(
        '/api/public/booking-requests',
        { first_name: 'Rowan', last_name: 'Fields', email: 'rowan@p14.test', phone: '+1 555 0177', reason: 'Check-up', preferred_date: day, preferred_time: '10:00', website: '' },
        null
      );
      assert.equal(booked.status, 202, booked.text.slice(0, 300));
      assert.deepEqual(booked.json, { ok: true });
    }),
  },
  {
    name: "the AdminSettings Users panel's rpc (get_users_with_roles) returns the declared user_id/email/created_at/role keys",
    fn: async (ctx) => withParityApp(ctx, async ({ app, tokens }) => {
      const res = await app.api('/api/rpc/get_users_with_roles', {}, tokens.admin);
      assert.equal(res.status, 200, res.text.slice(0, 300));
      assert.ok(Array.isArray(res.json), JSON.stringify(res.json).slice(0, 200));
      assert.ok(res.json.length >= 2, 'both seeded users appear');
      for (const row of res.json) {
        assert.deepEqual(Object.keys(row).sort(), ['created_at', 'email', 'is_doctor', 'last_login_at', 'must_change_password', 'role', 'user_id']);
        assert.equal(typeof row.user_id, 'string');
        assert.equal(typeof row.email, 'string');
        assert.equal(typeof row.role, 'string');
      }
      const adminRow = res.json.find((r) => r.email === 'admin@p14.test');
      assert.ok(adminRow && adminRow.role === 'admin');
    }),
  },
];
