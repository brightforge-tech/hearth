// tests/unit/authorization-matrix.test.mjs — the ported RLS matrix (task t7,
// the S32 surface). No database: the matrix is data + SQL fragments, and the
// questions the route asks of it — may this caller do this verb, and what row
// restriction rides along — are answerable from the module alone.
//
// The expectations are the live policies from supabase/migrations as the
// header of api/lib/authorization.mjs transcribes them; if a policy changes
// there, this file is where the port notices.

import assert from 'node:assert/strict';

import {
  anonAllow,
  anonPredicate,
  can,
  denyReason,
  isAdmin,
  isStaff,
  POLICIES,
  predicate,
  readPredicate,
  renumber,
  streamPredicate,
  TABLES,
  VERBS,
} from '../../api/lib/authorization.mjs';

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', email: 'a@t7.test', roles: ['admin'] };
const STAFF = { id: '22222222-2222-4222-8222-222222222222', email: 's@t7.test', roles: ['user'] };
const MOD = { id: '33333333-3333-4333-8333-333333333333', email: 'm@t7.test', roles: ['moderator'] };
const ROLELESS = { id: '44444444-4444-4444-8444-444444444444', email: 'r@t7.test', roles: [] };

export default [
  {
    name: 'the matrix covers the nine policy-bearing tables x four verbs',
    fn: () => {
      assert.deepEqual(TABLES, ['clinic_settings', 'patients', 'appointments', 'visit_notes', 'services', 'invoices', 'invoice_items', 'payments', 'user_roles']);
      for (const table of TABLES) {
        for (const verb of VERBS) {
          assert.ok(Object.prototype.hasOwnProperty.call(POLICIES[table], verb), `${table}.${verb} is missing from POLICIES`);
        }
      }
    },
  },
  {
    name: 'an admin may do everything the matrix allows, and the core tables are open to any session',
    fn: () => {
      for (const table of ['appointments', 'invoice_items']) {
        for (const verb of VERBS) assert.equal(can(ADMIN, table, verb), true, `${table}.${verb}`);
        for (const verb of VERBS) assert.equal(can(STAFF, table, verb), true, `${table}.${verb}`);
      }
    },
  },
  {
    name: 'admin-only writes: clinic_settings update, services writes, payments delete, patients/visit_notes/invoices delete, user_roles writes',
    fn: () => {
      const adminOnly = [
        ['clinic_settings', 'update'],
        ['services', 'insert'], ['services', 'update'], ['services', 'delete'],
        ['patients', 'delete'], ['visit_notes', 'delete'], ['invoices', 'delete'],
        ['payments', 'delete'],
        ['user_roles', 'insert'], ['user_roles', 'update'], ['user_roles', 'delete'],
      ];
      for (const [table, verb] of adminOnly) {
        assert.equal(can(ADMIN, table, verb), true, `admin ${table}.${verb}`);
        assert.equal(can(STAFF, table, verb), false, `staff ${table}.${verb} must be denied`);
        assert.equal(can(MOD, table, verb), false, `moderator ${table}.${verb} must be denied`);
      }
    },
  },
  {
    name: 'never-allowed verbs answer false for every role, including admin',
    fn: () => {
      for (const user of [ADMIN, STAFF]) {
        assert.equal(can(user, 'clinic_settings', 'insert'), false);
        assert.equal(can(user, 'clinic_settings', 'delete'), false);
      }
    },
  },
  {
    name: 'a caller with no session is always denied by can(); the anon path is anonAllow() alone',
    fn: () => {
      for (const table of TABLES) {
        for (const verb of VERBS) assert.equal(can(null, table, verb), false, `${table}.${verb}`);
      }
    },
  },
  {
    name: 'unknown tables and Object.prototype names are denied, never type errors',
    fn: () => {
      assert.equal(can(ADMIN, 'hh_outbox', 'select'), false);
      assert.equal(can(ADMIN, 'constructor', 'select'), false);
      assert.equal(can(ADMIN, 'appointments', 'constructor'), false);
      assert.equal(can(ADMIN, 'appointments', 'frobnicate'), false);
      assert.match(denyReason(ADMIN, 'hh_outbox', 'select'), /does not allow/);
    },
  },
  {
    name: 'denyReason names the reason: admin role, own rows, or not permitted',
    fn: () => {
      assert.match(denyReason(STAFF, 'payments', 'delete'), /needs the admin role/);
      assert.match(denyReason(STAFF, 'user_roles', 'insert'), /needs the admin role/);
      assert.match(denyReason(STAFF, 'user_roles', 'select'), /limited to your own rows|is not permitted/);
      assert.match(denyReason(ADMIN, 'clinic_settings', 'insert'), /does not allow/);
    },
  },
  {
    name: 'the anonymous allow-list is exactly the landing services read and the intake patient insert',
    fn: () => {
      assert.equal(anonAllow('services', 'select'), true);
      assert.equal(anonAllow('patients', 'insert'), true);
      for (const table of TABLES) {
        for (const verb of VERBS) {
          const allowed = anonAllow(table, verb);
          assert.equal(allowed, table === 'services' ? verb === 'select' : table === 'patients' ? verb === 'insert' : false,
            `anon ${table}.${verb} must be ${table}.${verb} allow-listed`);
        }
      }
    },
  },
  {
    name: 'the anonymous services read carries the show_on_landing predicate; the insert carries none',
    fn: () => {
      assert.match(anonPredicate('services', 'select').sql, /"services"\."show_on_landing" = true/);
      assert.equal(anonPredicate('patients', 'insert'), null);
      assert.equal(anonPredicate('invoices', 'select'), null);
    },
  },
  {
    name: 'staff reads of patients are scoped to patients the clinic has booked; admins see every row',
    fn: () => {
      const p = predicate(STAFF, 'patients', 'select');
      assert.match(p.sql, /exists \(select 1 from "public"\."appointments"/);
      assert.match(p.sql, /"hh_appt"\."patient_id" = "patients"\."id"/);
      assert.deepEqual(p.params, []);
      assert.equal(predicate(ADMIN, 'patients', 'select'), null);
    },
  },
  {
    name: 'invoices for staff carry two different fragments: USING needs the appointment, CHECK allows null too',
    fn: () => {
      const using = predicate(STAFF, 'invoices', 'update', { when: 'using' });
      const check = predicate(STAFF, 'invoices', 'update', { when: 'check' });
      assert.match(using.sql, /where "hh_appt"\."id" = "invoices"\."appointment_id"/);
      assert.doesNotMatch(using.sql, /is null/);
      assert.match(check.sql, /"invoices"\."appointment_id" is null/);
      assert.match(check.sql, /or exists/);
    },
  },
  {
    name: 'payments for staff are scoped through the invoice to an appointment',
    fn: () => {
      const p = predicate(STAFF, 'payments', 'select');
      assert.match(p.sql, /"public"\."invoices" as "hh_inv"/);
      assert.match(p.sql, /join "public"\."appointments" as "hh_appt"/);
      assert.match(p.sql, /"hh_inv"\."id" = "payments"\."invoice_id"/);
    },
  },
  {
    name: 'visit_notes for staff must have an appointment; the alias follows the statement',
    fn: () => {
      const read = predicate(STAFF, 'visit_notes', 'select', { alias: 'visit_notes' });
      const checkOn = predicate(STAFF, 'visit_notes', 'insert', { alias: 'visit_notes', when: 'check' });
      assert.match(read.sql, /"visit_notes"\."appointment_id"/);
      assert.equal(checkOn.sql, read.sql);
      const aliased = predicate(STAFF, 'visit_notes', 'select', { alias: 'vn' });
      assert.match(aliased.sql, /"vn"\."appointment_id"/);
    },
  },
  {
    name: 'user_roles is read-only and self-scoped, with the uid as a bound parameter',
    fn: () => {
      const p = predicate(STAFF, 'user_roles', 'select');
      assert.equal(p.sql, `"user_roles"."user_id" = $1`);
      assert.deepEqual(p.params, [STAFF.id]);
      assert.equal(can(STAFF, 'user_roles', 'select'), true);
    },
  },
  {
    name: 'streamPredicate: user_roles reaches an admin unscoped, staff keep the self-scope',
    fn: () => {
      // The AdminSettings Users panel is admin-only and reads all users via
      // the SECURITY DEFINER rpc, so the realtime feed must not suppress
      // grants of other users from an admin's stream…
      assert.equal(streamPredicate(ADMIN, 'user_roles', 'select', { alias: 'user_roles' }), null);
      // …while staff (and a caller with no id) stay at the "Read own roles"
      // predicate, identical to the plain read predicate.
      const staff = streamPredicate(STAFF, 'user_roles', 'select', { alias: 'user_roles' });
      assert.deepEqual(staff, predicate(STAFF, 'user_roles', 'select', { alias: 'user_roles' }));
      assert.match(staff.sql, /"user_roles"\."user_id" = \$1/);
      assert.equal(streamPredicate(null, 'user_roles', 'select'), null); // anon never reaches this table
      // and the widening is only user_roles: every other table streams under
      // the same scope the query API reads with
      for (const table of ['patients', 'invoices', 'payments', 'visit_notes', 'appointments', 'services', 'clinic_settings']) {
        for (const user of [ADMIN, STAFF]) {
          assert.deepEqual(
            streamPredicate(user, table, 'select', { alias: table }),
            readPredicate(user, table, 'select', { alias: table }),
            `${table} must stream exactly what ${user.roles.join('/')} can read`
          );
        }
      }
    },
  },
  {
    name: 'readPredicate falls through to the anon shape when there is no caller',
    fn: () => {
      const anon = readPredicate(null, 'services', 'select');
      assert.match(anon.sql, /show_on_landing/);
      assert.equal(readPredicate(null, 'invoices', 'select'), null);
      // a session on services sees every row (the anon narrowing does not stick)
      assert.equal(readPredicate(STAFF, 'services', 'select'), null);
    },
  },
  {
    name: 'renumber shifts only the placeholders and leaves params in order',
    fn: () => {
      const f = { sql: `"a"."x" = $1 and "a"."y" = $2`, params: [7, 8] };
      const r = renumber(f, 3);
      assert.equal(r.sql, `"a"."x" = $4 and "a"."y" = $5`);
      assert.deepEqual(r.params, [7, 8]);
      assert.notEqual(renumber(f, 0).params, f.params); // a copy, never the caller's array
      assert.equal(renumber(f, 0).sql, f.sql);
    },
  },
  {
    name: 'isAdmin / isStaff: admin is admin, everyone else with a role is staff, no role is neither',
    fn: () => {
      assert.equal(isAdmin(ADMIN), true);
      assert.equal(isAdmin(STAFF), false);
      assert.equal(isAdmin(null), false);
      assert.equal(isStaff(STAFF), true);
      assert.equal(isStaff(MOD), true); // a moderator is staff, as in the hosted project
      assert.equal(isStaff(ADMIN), false);
      assert.equal(isStaff(ROLELESS), false);
      assert.equal(isStaff(null), false);
    },
  },
];
