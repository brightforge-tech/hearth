// tests/parity/authorization-matrix.test.mjs — the 9-table x verb x caller
// matrix, end-to-end over HTTP (task t14, milestone 5, W59).
//
// tests/unit/authorization-matrix.test.mjs pins the ported POLICIES table as
// data; this suite pins what the *route* actually answers when the browser
// issues the request: 9 tables x {select, insert, update, delete} x
// {anonymous, staff, admin} -> the exact status code. The expected codes are
// read off api/lib/authorization.mjs one by one (they are the live hosted
// policies re-expressed):
//
//   anonymous  401 everywhere except the two-entry allow-list:
//              services.select (show_on_landing rows only) and patients.insert;
//   staff      the ANY and role:'any'+predicate rows are 200; every ADMIN-only
//              verb (services writes, payments delete, invoices delete,
//              patients/visit_notes delete, user_roles writes) is 403, and
//              clinic_settings insert/delete are 403 because no policy ever
//              granted them (the singleton is UPDATE-only, per the seed);
//   admin      200 everywhere a policy exists — clinic_settings insert/delete
//              stay 403 for the same singleton reason, admin included.
//
// A second case pins that the allowed-but-predicated verbs also carry their
// rows: an anonymous services select never sees an off-landing service, a
// staff patients select sees only patients with an appointment, and a staff
// user_roles select is self-scoped. A third case fires the SQL-injection
// attempts at the filter/order/table surfaces and asserts they die at 400
// with the schema and the user table intact.
//
// Every write targets its own throwaway row so the 108 cells cannot interfere
// with each other; all run against a scratch database.

import assert from 'node:assert/strict';

import { connectDb, createScratch, dropScratch, seedUsers } from '../helpers/db.mjs';
import { makeTokens, startTestApp } from '../helpers/http.mjs';

const SCRATCH = '_cauth';
const JWT_SECRET = 'authz-matrix-parity-secret-32-ch!';

const ID = {
  admin: 'c0000000-0000-4000-8000-000000000001',
  staff: 'c0000000-0000-4000-8000-000000000002',
  doctor: 'c0000000-0000-4000-8000-000000000003',
  patient: 'd0000000-0000-4000-8000-000000000001',
  appt: 'd0000000-0000-4000-8000-000000000002', // the matrix patient's visit (cascades with it)
  apptThrow: 'd0000000-0000-4000-8000-00000000000a',
  apptStaffNote: 'd0000000-0000-4000-8000-000000000004',
  apptAdminNote: 'd0000000-0000-4000-8000-00000000000b',
  apptNoteTarget: 'd0000000-0000-4000-8000-00000000000c',
  lonely: 'd0000000-0000-4000-8000-000000000005', // patient with no appointment
  throwNote: 'd0000000-0000-4000-8000-000000000006',
  throwInvoice: 'd0000000-0000-4000-8000-000000000007',
  childInvoice: 'd0000000-0000-4000-8000-00000000000d',
  throwItem: 'd0000000-0000-4000-8000-000000000008',
  throwPayment: 'd0000000-0000-4000-8000-000000000009',
};

// The row graph is built so the matrix's destructive cells (staff's
// appointments delete, admin's patients/invoices deletes) can never reach the
// rows a *later table block* still needs: every write target hangs off one of
// the lonely patient's appointments, and that patient is never deleted. The
// matrix patient (and its visit, cascading with it) exists to be deleted by
// the admin patients.delete cell.
const FIXTURE = [
  `insert into public.patients (id, first_name, last_name, phone)
   values ($1, 'Matrix', 'Patient', '+1-555-0200'), ($2, 'Lonely', 'NoVisit', '+1-555-0201')`,
  [ID.patient, ID.lonely],
  `insert into public.appointments (id, patient_id, scheduled_start, status)
   values ($1, $2, '2025-08-05T09:00:00Z', 'completed'),
          ($3, $4, '2025-08-06T09:00:00Z', 'scheduled'),
          ($5, $4, '2025-08-07T09:00:00Z', 'scheduled'),
          ($6, $4, '2025-08-08T09:00:00Z', 'scheduled'),
          ($7, $4, '2025-08-09T09:00:00Z', 'scheduled')`,
  [ID.appt, ID.patient, ID.apptThrow, ID.lonely, ID.apptStaffNote, ID.apptAdminNote, ID.apptNoteTarget],
  `insert into public.visit_notes (id, appointment_id, notes)
   values ($1, $2, 'existing note')`, [ID.throwNote, ID.apptNoteTarget],
  `insert into public.invoices (id, appointment_id, status)
   values ($1, $2, 'issued'), ($3, $2, 'draft')`, [ID.throwInvoice, ID.apptNoteTarget, ID.childInvoice],
  `insert into public.invoice_items (id, invoice_id, description, quantity, unit_price, taxable)
   values ($1, $2, 'Line', 1, 10.00, true)`, [ID.throwItem, ID.childInvoice],
  `insert into public.payments (id, invoice_id, amount, method)
   values ($1, $2, 5.00, 'cash')`, [ID.throwPayment, ID.childInvoice],
  // the off-landing service: anon must not see it, staff/admin must
  `insert into public.services (code, name, description, price, taxable, active, show_on_landing)
   values ('ZZ-HIDDEN', 'Hidden Service', 'not on the landing page', 999.00, false, true, false)`, [],
];

async function withMatrixApp({ root, testUrl }, fn) {
  const dsn = await createScratch(testUrl, SCRATCH);
  const app = await startTestApp({ root, databaseUrl: dsn, jwtSecret: JWT_SECRET, resend: false });
  const db = await connectDb(dsn);
  try {
    await seedUsers(db, [
      { id: ID.admin, email: 'admin@authz14.test', roles: ['admin'] },
      { id: ID.staff, email: 'staff@authz14.test', roles: ['user'] },
      { id: ID.doctor, email: 'doctor@authz14.test', roles: ['user'] },
    ]);
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);
    const tokens = makeTokens(JWT_SECRET, [
      { key: 'admin', id: ID.admin, email: 'admin@authz14.test' },
      { key: 'staff', id: ID.staff, email: 'staff@authz14.test' },
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

// --- the matrix ----------------------------------------------------------------
// For each table and verb: the body (minus table/verb), and the expected status
// per caller. `note` quotes the policy the row encodes (api/lib/authorization.mjs).

const VERB_ORDER = ['select', 'insert', 'update', 'delete'];
const CALLERS = ['anonymous', 'staff', 'admin'];

const MATRIX = {
  clinic_settings: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } }, // "Settings readable by authenticated"
    insert: { body: { payload: { singleton: true } }, expect: { anonymous: 401, staff: 403, admin: 403 } }, // no policy ever -> nobody, admin included
    update: { body: { payload: { tax_name: 'Sales Tax' }, filters: { singleton: true }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } }, // "Settings updatable by admin"
    delete: { body: { filters: { singleton: true } }, expect: { anonymous: 401, staff: 403, admin: 403 } }, // singleton: no delete policy
  },
  patients: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } }, // 20250812125955 (staff scoped to with-appointment)
    insert: { body: { payload: { first_name: 'Drop', last_name: 'In', phone: '+1-555-0299' }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } }, // Hearth: no anonymous patient insert (public booking requests instead)
    update: { body: { payload: { phone: '+1-555-0211' }, filters: { id: ID.patient }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } }, // staff: has an appointment -> in scope
    delete: { body: { filters: { id: ID.patient }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } }, // admin-only
  },
  appointments: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } },
    insert: { body: { payload: { patient_id: ID.lonely, scheduled_start: '2025-09-01T10:00:00Z' }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } }, // core "by authenticated"
    update: { body: { payload: { reason: 'edited' }, filters: { id: ID.apptThrow }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } },
    delete: { body: { filters: { id: ID.apptThrow }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } },
  },
  visit_notes: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } },
    insert: {
      body: null, // appointment differs per caller (unique appointment_id): see bodyFor below
      bodyFor: {
        staff: { payload: { appointment_id: ID.apptStaffNote, notes: 'staff note' }, select: 'id' },
        admin: { payload: { appointment_id: ID.apptAdminNote, notes: 'admin note' }, select: 'id' },
      },
      expect: { anonymous: 401, staff: 200, admin: 200 },
    },
    update: { body: { payload: { notes: 'edited' }, filters: { id: ID.throwNote }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } },
    delete: { body: { filters: { id: ID.throwNote }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } }, // 20250812130142: admin-only delete
  },
  services: {
    select: { body: {}, expect: { anonymous: 200, staff: 200, admin: 200 } }, // allow-list entry, landing rows only for anon
    insert: { body: { payload: { code: 'ZZ-PARITY', name: 'Parity Service', price: 1.00, taxable: false }, select: 'code' }, expect: { anonymous: 401, staff: 403, admin: 200 } }, // "Services insert by admin"
    update: { body: { payload: { price: 9.00 }, filters: { code: 'ZZ-PARITY' }, select: 'code' }, expect: { anonymous: 401, staff: 403, admin: 200 } },
    delete: { body: { filters: { code: 'ZZ-PARITY' }, select: 'code' }, expect: { anonymous: 401, staff: 403, admin: 200 } },
  },
  invoices: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } },
    insert: {
      // staff runs before admin deletes its patient, so staff may use the
      // seeded appointment; admin must use one that survives (the delete of
      // the matrix patient cascades to its appointments).
      body: null,
      bodyFor: {
        staff: { payload: { appointment_id: ID.apptNoteTarget }, select: 'id' },
        admin: { payload: { appointment_id: ID.apptNoteTarget }, select: 'id' },
      },
      expect: { anonymous: 401, staff: 200, admin: 200 }, // WITH CHECK: appointment exists-or-absent
    },
    update: { body: { payload: { status: 'issued' }, filters: { id: ID.throwInvoice }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } },
    delete: { body: { filters: { id: ID.throwInvoice }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } }, // 20250812130321
  },
  invoice_items: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } },
    insert: { body: { payload: { invoice_id: ID.childInvoice, description: 'Extra line', quantity: 1, unit_price: 2.00 }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } }, // core "by authenticated"
    update: { body: { payload: { quantity: 2 }, filters: { id: ID.throwItem }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } },
    delete: { body: { filters: { id: ID.throwItem }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } },
  },
  payments: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } },
    insert: { body: { payload: { invoice_id: ID.childInvoice, amount: 1.00, method: 'cash' }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } }, // USING/WITH CHECK: invoice keeps its appointment
    update: { body: { payload: { reference: 'matrix-ref' }, filters: { id: ID.throwPayment }, select: 'id' }, expect: { anonymous: 401, staff: 200, admin: 200 } },
    delete: { body: { filters: { id: ID.throwPayment }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } }, // audit-trail rule (W27)
  },
  user_roles: {
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } }, // "Read own roles" — self-scoped for everyone
    insert: { body: { payload: { user_id: ID.doctor, role: 'moderator' }, select: 'role' }, expect: { anonymous: 401, staff: 403, admin: 200 } }, // 20250812203349
    update: { body: { payload: { role: 'admin' }, filters: { user_id: ID.doctor, role: 'moderator' }, select: 'role' }, expect: { anonymous: 401, staff: 403, admin: 200 } },
    delete: { body: { filters: { user_id: ID.doctor }, select: 'role' }, expect: { anonymous: 401, staff: 403, admin: 200 } },
  },
  expenses: {
    // Hearth: finance roles only (clinical staff are denied); delete admin-only
    select: { body: {}, expect: { anonymous: 401, staff: 403, admin: 200 } },
    insert: { body: { payload: { description: 'Matrix gloves', amount: 12.5, category: 'Medical Equipment' }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } },
    update: { body: { payload: { notes: 'edited' }, filters: { description: 'Matrix gloves' }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } },
    delete: { body: { filters: { description: 'Matrix gloves' }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 200 } },
  },
  booking_requests: {
    // readable by staff; every write goes through the dedicated endpoints
    select: { body: {}, expect: { anonymous: 401, staff: 200, admin: 200 } },
    insert: { body: { payload: { first_name: 'X', last_name: 'Y', reason: 'z', preferred_date: '2030-01-01', preferred_time: '09:00' }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 403 } },
    update: { body: { payload: { status: 'approved' }, filters: { status: 'pending' }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 403 } },
    delete: { body: { filters: { status: 'pending' }, select: 'id' }, expect: { anonymous: 401, staff: 403, admin: 403 } },
  },
};

export default [
  {
    name: 'the 11 tables x 4 verbs x 3 callers answer the exact status codes of the ported policies',
    fn: async (ctx) => withMatrixApp(ctx, async ({ app, tokens }) => {
      const problems = [];
      for (const [table, verbs] of Object.entries(MATRIX)) {
        for (const verb of VERB_ORDER) {
          const cell = verbs[verb];
          for (const caller of CALLERS) {
            const body = { table, verb, ...(cell.bodyFor?.[caller] ?? cell.body ?? {}) };
            const res = await app.api('/api/query', body, tokens[caller]);
            const want = cell.expect[caller];
            const where = `${table}.${verb} [${caller}]`;
            if (res.status !== want) {
              problems.push(`${where}: got ${res.status} ${res.text.slice(0, 140)}, expected ${want}`);
              continue;
            }
            // a 200 select must answer with the envelope; a 403 with the
            // standard {"error":{...}} shape, never an empty 200 pretending
            // success or a bare-text answer.
            if (res.status === 200 && verb === 'select') {
              if (!Array.isArray(res.json.data) && res.json.data === undefined) problems.push(`${where}: 200 without a data array`);
            }
            if (res.status === 403 && !(res.json?.error?.message)) {
              problems.push(`${where}: 403 without the error envelope: ${res.text.slice(0, 120)}`);
            }
            if (res.status === 401 && res.json?.error?.code !== 'UNAUTHORIZED') {
              problems.push(`${where}: 401 without the UNAUTHORIZED code: ${res.text.slice(0, 120)}`);
            }
          }
        }
      }
      assert.deepEqual(problems, [], `authorization matrix drift:\n${problems.join('\n')}`);
    }),
  },

  {
    name: 'the allowed-but-predicated verbs keep their row scopes (landing-only anon, with-appointment staff, self user_roles)',
    fn: async (ctx) => withMatrixApp(ctx, async ({ app, db, tokens }) => {
      // a patient nobody has ever booked — invisible to staff, visible to admin
      await db.query(
        `insert into public.patients (id, first_name, last_name, phone)
         values ('d0000000-0000-4000-8000-00000000000e', 'Zero', 'Visits', '+1-555-0202')`);
      const NOVISIT = 'd0000000-0000-4000-8000-00000000000e';

      // anon sees the landing services and NOT the off-landing one...
      const anon = await app.api('/api/query', { table: 'services', verb: 'select', select: 'code,show_on_landing' }, null);
      assert.equal(anon.status, 200, anon.text);
      const anonCodes = anon.json.data.map((r) => r.code);
      assert.ok(anonCodes.length >= 5, `anon should see the five seeded landing services, got ${anonCodes.length}`);
      assert.ok(!anonCodes.includes('ZZ-HIDDEN'), 'the off-landing service leaked to anon');
      assert.ok(anon.json.data.every((r) => r.show_on_landing === true));

      // ...while a staff session sees all of them (20250812182051).
      const staff = await app.api('/api/query', { table: 'services', verb: 'select', select: 'code' }, tokens.staff);
      assert.equal(staff.status, 200, staff.text);
      assert.ok(staff.json.data.map((r) => r.code).includes('ZZ-HIDDEN'), 'staff must see every service');

      // staff patients select is scoped to patients that have an appointment...
      const pats = await app.api('/api/query', { table: 'patients', verb: 'select', select: 'id' }, tokens.staff);
      assert.equal(pats.status, 200, pats.text);
      const ids = pats.json.data.map((r) => r.id);
      assert.ok(ids.includes(ID.patient), 'the with-appointment patient must be visible to staff');
      assert.ok(!ids.includes(NOVISIT), 'the appointment-less patient leaked to staff');

      // ...while admin sees the whole table (no staff predicate).
      const all = await app.api('/api/query', { table: 'patients', verb: 'select', select: 'id' }, tokens.admin);
      assert.ok(all.json.data.map((r) => r.id).includes(NOVISIT), 'admin must see every patient');

      // user_roles reads are self-scoped for staff and admin alike.
      const mine = await app.api('/api/query', { table: 'user_roles', verb: 'select', select: 'user_id,role' }, tokens.staff);
      assert.equal(mine.status, 200, mine.text);
      assert.deepEqual(mine.json.data, [{ user_id: ID.staff, role: 'user' }]);
    }),
  },

  {
    name: 'SQL-injection attempts in filters/order/table are 400s, and the schema is intact afterwards',
    fn: async (ctx) => withMatrixApp(ctx, async ({ app, db, tokens }) => {
      const before = await db.query(
        `select (select count(*) from public.app_users) as users,
                (select count(*) from public.payments) as payments`);

      const attempts = [
        // a filter value that is not the column's type once quoted/bound — the
        // classic quote-breaking payload against a uuid column
        { table: 'invoices', verb: 'select', filters: { id: "'); delete from app_users;--" } },
        // same against a numeric column
        { table: 'payments', verb: 'select', filters: { amount: '1; drop table payments--' } },
        // an or() expression smuggling a statement
        { table: 'invoices', verb: 'select', or: "total.eq.1; drop table payments--" },
        // a bogus column name
        { table: 'invoices', verb: 'select', filters: { 'id; delete from app_users': '1' } },
        // a smuggled identifier in the order clause
        { table: 'invoices', verb: 'select', order: [{ column: 'id; drop table payments' }] },
        // a table name that is really a statement
        { table: 'invoices; drop table payments', verb: 'select' },
        // the same payloads on a WRITE surface (update) as well
        { table: 'invoices', verb: 'update', payload: { status: 'paid' }, filters: { id: "1' or 1=1 --" }, select: 'id' },
      ];
      for (const attempt of attempts) {
        const res = await app.api('/api/query', attempt, tokens.staff);
        assert.ok(res.status === 400 || res.status === 403,
          `injection attempt ${JSON.stringify(attempt)}: got ${res.status} ${res.text.slice(0, 140)}, expected a refusal`);
      }

      // Nothing ran: every user and every payment row is still there, and the
      // tables still exist to be counted at all.
      const after = await db.query(
        `select (select count(*) from public.app_users) as users,
                (select count(*) from public.payments) as payments`);
      assert.deepEqual(after.rows[0], before.rows[0], 'an injection attempt changed data');
    }),
  },
];
