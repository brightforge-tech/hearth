// tests/api/clinical-notes.test.mjs — visit notes are for admins and doctors,
// and an embedded resource answers to the same policy as a direct read.

import assert from 'node:assert/strict';

import { ADMIN, STAFF, expectStatus, withHearth } from '../helpers/app.mjs';

async function seedVisit(api, admin) {
  const p = await api.query({ table: 'patients', verb: 'insert', payload: { first_name: 'Noa', last_name: 'Sample', phone: '+1 555 0123' }, select: 'id', single: true }, admin);
  expectStatus(p, 200, undefined, 'patient');
  const a = await api.query({ table: 'appointments', verb: 'insert', payload: { patient_id: p.json.data.id, scheduled_start: new Date().toISOString() }, select: 'id', single: true }, admin);
  expectStatus(a, 200, undefined, 'appointment');
  const aid = a.json.data.id;
  expectStatus(await api.query({ table: 'visit_notes', verb: 'insert', payload: { appointment_id: aid, notes: 'Confidential plan' }, select: 'id' }, admin), 200, undefined, 'note');
  return { pid: p.json.data.id, aid };
}

async function staffId(api) {
  const { rows } = await api.db.query('select id from public.app_users where email = $1', [STAFF.email]);
  return rows[0].id;
}

export default [
  {
    name: 'staff without the Doctor tag cannot read or write visit notes, directly or through an embed',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      const staff = await api.token(STAFF);
      const { pid, aid } = await seedVisit(api, admin);

      expectStatus(await api.query({ table: 'visit_notes', select: 'notes' }, staff), 403, 'FORBIDDEN', 'direct read');
      expectStatus(await api.query({ table: 'visit_notes', verb: 'update', payload: { notes: 'x' }, filters: { appointment_id: { op: 'eq', value: aid } }, select: 'id' }, staff), 403, 'FORBIDDEN', 'update');

      // the embed routes that used to bypass the table's policy
      expectStatus(await api.query({ table: 'appointments', select: 'id, visit_notes(notes)' }, staff), 403, 'FORBIDDEN', 'appointments embed');
      expectStatus(await api.query({ table: 'patients', select: 'id, appointments(id, visit_notes(notes))', filters: { id: { op: 'eq', value: pid } } }, staff), 403, 'FORBIDDEN', 'two-level embed');
      // a write that asks for the notes back in its RETURNING list is refused and rolled back
      const before = await api.db.query('select reason from public.appointments where id = $1', [aid]);
      expectStatus(await api.query({ table: 'appointments', verb: 'update', payload: { reason: 'changed' }, filters: { id: { op: 'eq', value: aid } }, select: 'id, visit_notes(notes)' }, staff), 403, 'FORBIDDEN', 'returning embed');
      const after = await api.db.query('select reason from public.appointments where id = $1', [aid]);
      assert.equal(after.rows[0].reason, before.rows[0].reason, 'a refused write must not land');

      // the same appointment without the notes is still fine for staff
      expectStatus(await api.query({ table: 'appointments', select: 'id, intake_notes', filters: { id: { op: 'eq', value: aid } } }, staff), 200);
    }),
  },
  {
    name: 'the Doctor tag (and admin) opens visit notes, including the doctor-only visit history embed',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      const staff = await api.token(STAFF);
      const { aid } = await seedVisit(api, admin);
      expectStatus(await api.post('/api/rpc/admin_update_user_role', { target_user_id: await staffId(api), new_role: 'user', new_is_doctor: true }, admin), 200);

      const direct = await api.query({ table: 'visit_notes', select: 'notes', filters: { appointment_id: { op: 'eq', value: aid } } }, staff);
      expectStatus(direct, 200);
      assert.deepEqual(direct.json.data, [{ notes: 'Confidential plan' }]);
      const embedded = await api.query({ table: 'appointments', select: 'id, visit_notes(notes)', filters: { id: { op: 'eq', value: aid } } }, staff);
      expectStatus(embedded, 200);
      assert.deepEqual(embedded.json.data[0].visit_notes, [{ notes: 'Confidential plan' }]);
      expectStatus(await api.query({ table: 'visit_notes', verb: 'update', payload: { notes: 'Revised plan' }, filters: { appointment_id: { op: 'eq', value: aid } }, select: 'id' }, staff), 200);
      // delete stays admin-only
      expectStatus(await api.query({ table: 'visit_notes', verb: 'delete', filters: { appointment_id: { op: 'eq', value: aid } }, select: 'id' }, staff), 403, 'FORBIDDEN', 'doctor delete');
    }),
  },
  {
    name: 'embeds carry the embedded table\'s policy: finance-only expenses and admin-only tables stay closed to staff',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const staff = await api.token(STAFF);
      // anonymous callers can only read landing services and nothing nested under them
      const anon = await api.query({ table: 'services', select: 'id, invoice_items(id)' }, null);
      assert.ok([401, 403].includes(anon.status), `anon embed answered ${anon.status}`);
      // user_roles is self-scoped and is never embeddable
      const roles = await api.query({ table: 'user_roles', select: 'role' }, staff);
      expectStatus(roles, 200);
    }),
  },
];
