// tests/api/audit-booking.test.mjs — the audit trail, safe public booking,
// expenses (with and without receipt scanning), optional e-mail, and a sweep
// proving every /api route enforces a session or is on the short public list.

import assert from 'node:assert/strict';
import http from 'node:http';

import { ADMIN, STAFF, expectStatus, withHearth } from '../helpers/app.mjs';

const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

const BOOKING = () => ({
  first_name: 'Ada',
  last_name: 'Example',
  email: 'ada.example@example.test',
  phone: '+1 555 0100',
  reason: 'Annual check-up',
  preferred_date: day(3),
  preferred_time: '10:30',
  website: '',
});

async function createPatient(api, token, extra = {}) {
  const r = await api.query({ table: 'patients', verb: 'insert', payload: { first_name: 'Ben', last_name: 'Sample', phone: '+1 555 0101', ...extra }, select: 'id', single: true }, token);
  expectStatus(r, 200, undefined, 'create patient');
  return r.json.data.id;
}

export default [
  {
    name: 'patient create/update/delete are audited in the same transaction, with field names only (never values)',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      const id = await createPatient(api, admin, { address: '1 Secret Lane' });
      expectStatus(await api.query({ table: 'patients', verb: 'update', payload: { phone: '+1 555 0199' }, filters: { id: { op: 'eq', value: id } }, select: 'id' }, admin), 200);
      expectStatus(await api.query({ table: 'patients', verb: 'delete', filters: { id: { op: 'eq', value: id } }, select: 'id' }, admin), 200);
      const rows = await api.audit("entity_type = 'patient' and entity_id = $1", [id]);
      assert.deepEqual(rows.map((r) => r.action), ['create', 'update', 'delete']);
      assert.equal(rows[0].actor_email, ADMIN.email);
      assert.equal(rows[0].actor_role, 'admin');
      assert.ok(rows[0].ip);
      assert.deepEqual(rows[1].summary, { fields: ['phone'] });
      const text = JSON.stringify(rows);
      for (const secret of ['Secret Lane', '0199', 'Sample']) assert.ok(!text.includes(secret), `audit leaked ${secret}`);
    }),
  },
  {
    name: 'opening one patient record, a visit note or intake notes is a view entry; a plain name list is not',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      const pid = await createPatient(api, admin);
      const appt = await api.query({ table: 'appointments', verb: 'insert', payload: { patient_id: pid, scheduled_start: new Date().toISOString(), intake_notes: 'Mild fever' }, select: 'id', single: true }, admin);
      const aid = appt.json.data.id;
      await api.query({ table: 'visit_notes', verb: 'insert', payload: { appointment_id: aid, notes: 'Rest and fluids' }, select: 'id' }, admin);
      await api.db.query("select 1"); // writes above produced create rows only
      const before = (await api.audit("action = 'view'")).length;
      expectStatus(await api.query({ table: 'patients', select: 'id, first_name' }, admin), 200);
      assert.equal((await api.audit("action = 'view'")).length, before, 'a list read is not a view');
      expectStatus(await api.query({ table: 'patients', select: '*', filters: { id: { op: 'eq', value: pid } }, maybeSingle: true }, admin), 200);
      expectStatus(await api.query({ table: 'visit_notes', select: 'notes', filters: { appointment_id: { op: 'eq', value: aid } } }, admin), 200);
      expectStatus(await api.query({ table: 'appointments', select: 'id, intake_notes', filters: { id: { op: 'eq', value: aid } }, single: true }, admin), 200);
      const views = await api.audit("action = 'view'");
      const kinds = views.map((v) => `${v.entity_type}:${v.entity_id}`);
      assert.ok(kinds.includes(`patient:${pid}`), kinds.join());
      assert.ok(views.some((v) => v.entity_type === 'visit_note'), kinds.join());
      assert.ok(kinds.includes(`intake_note:${aid}`), kinds.join());
      assert.ok(!JSON.stringify(views).includes('Rest and fluids'));
    }),
  },
  {
    name: 'the audit log is admin-only, filterable, exportable as CSV (itself audited) and cannot be changed through any API path',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      const staff = await api.token(STAFF);
      await createPatient(api, admin);
      expectStatus(await api.call('/api/audit', { token: staff }), 403, 'FORBIDDEN', 'staff list');
      expectStatus(await api.call('/api/audit/export', { token: staff }), 403, 'FORBIDDEN', 'staff export');
      expectStatus(await api.call('/api/audit'), 401, undefined, 'anonymous');
      const list = await api.call('/api/audit?action=create&entity_type=patient&limit=10', { token: admin });
      expectStatus(list, 200);
      assert.equal(list.json.total, 1);
      assert.equal(list.json.rows[0].action, 'create');
      const byActor = await api.call(`/api/audit?actor=${encodeURIComponent('admin@')}&from=${day(-1)}&to=${day(0)}`, { token: admin });
      assert.ok(byActor.json.total >= 2); // login + create
      expectStatus(await api.call('/api/audit?from=yesterday', { token: admin }), 400, 'BAD_FILTER');
      expectStatus(await api.call('/api/audit?action=drop', { token: admin }), 400, 'BAD_FILTER');
      const csv = await api.call('/api/audit/export?action=create', { token: admin });
      expectStatus(csv, 200);
      assert.match(csv.headers['content-type'], /text\/csv/);
      assert.match(csv.headers['content-disposition'], /audit-log-\d{4}-\d{2}-\d{2}\.csv/);
      assert.ok(csv.text.startsWith('id,at,actor_id,actor_email,actor_role,action,entity_type,entity_id,ip,summary\n'));
      assert.equal((await api.audit("action = 'export' and entity_type = 'audit_log'")).length, 1);
      // no write path: the generic route has no policy, and the router has no verbs
      for (const verb of ['select', 'insert', 'update', 'delete']) {
        const r = await api.query({ table: 'audit_log', verb, payload: verb === 'insert' || verb === 'update' ? { action: 'view' } : undefined, select: 'id' }, admin);
        assert.equal(r.status, 403, `${verb}: ${r.text}`);
      }
      for (const method of ['DELETE', 'PUT', 'PATCH', 'POST']) {
        const r = await api.call('/api/audit', { method, token: admin, body: method === 'DELETE' ? undefined : {} });
        assert.equal(r.status, 404, `${method} /api/audit -> ${r.status}`);
      }
      // and the database itself refuses
      await assert.rejects(api.db.query('update public.audit_log set action = $1', ['view']), /append-only/);
      await assert.rejects(api.db.query('delete from public.audit_log'), /append-only/);
      await assert.rejects(api.db.query('truncate public.audit_log'), /append-only/);
    }),
  },
  {
    name: 'public booking: valid request is stored as a pending request (no patient) and answers 202 with no data; honeypot and bad input',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const patientsBefore = (await api.db.query('select count(*)::int n from public.patients')).rows[0].n;
      const ok = await api.post('/api/public/booking-requests', BOOKING());
      expectStatus(ok, 202);
      assert.deepEqual(ok.json, { ok: true });
      const rows = (await api.db.query('select * from public.booking_requests')).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'pending');
      assert.match(rows[0].source_ip_hash, /^[0-9a-f]{64}$/);
      assert.equal((await api.db.query('select count(*)::int n from public.patients')).rows[0].n, patientsBefore);
      // honeypot filled: accepted silently, nothing stored
      expectStatus(await api.post('/api/public/booking-requests', { ...BOOKING(), website: 'http://spam.example' }), 202);
      assert.equal((await api.db.query('select count(*)::int n from public.booking_requests')).rows[0].n, 1);
      // validation
      const bad = [
        [{ ...BOOKING(), first_name: 'x'.repeat(101) }, 'long name'],
        [{ ...BOOKING(), email: undefined, phone: undefined }, 'no contact'],
        [{ ...BOOKING(), email: 'not-an-email' }, 'bad email'],
        [{ ...BOOKING(), preferred_date: day(-10) }, 'past date'],
        [{ ...BOOKING(), preferred_date: day(400) }, 'far future'],
        [{ ...BOOKING(), preferred_time: '25:00' }, 'bad time'],
        [{ ...BOOKING(), reason: 'r'.repeat(1001) }, 'long reason'],
        [{ ...BOOKING(), status: 'approved' }, 'extra field'],
      ];
      for (const [body, label] of bad) expectStatus(await api.post('/api/public/booking-requests', body), 400, 'INVALID_INPUT', label);
      // anonymous cannot read requests back
      expectStatus(await api.query({ table: 'booking_requests', select: 'id' }), 401, undefined, 'anon read');
    }),
  },
  {
    name: 'public booking is rate-limited per IP',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl, env: { BOOKING_RATE_LIMIT_PER_HOUR: '2' } }, async (api) => {
      expectStatus(await api.post('/api/public/booking-requests', BOOKING()), 202);
      expectStatus(await api.post('/api/public/booking-requests', BOOKING()), 202);
      expectStatus(await api.post('/api/public/booking-requests', BOOKING()), 429, 'RATE_LIMITED');
    }),
  },
  {
    name: 'staff approve a request (patient + appointment created, audited) or decline it; a decided request cannot be decided again',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const staff = await api.token(STAFF);
      await api.post('/api/public/booking-requests', BOOKING());
      await api.post('/api/public/booking-requests', { ...BOOKING(), first_name: 'Cora' });
      const list = await api.query({ table: 'booking_requests', select: 'id, first_name, status', order: [{ column: 'created_at' }] }, staff);
      expectStatus(list, 200);
      const [first, second] = list.json.data;
      expectStatus(await api.post(`/api/booking-requests/${first.id}/approve`, {}), 401, undefined, 'anonymous approve');
      expectStatus(await api.query({ table: 'booking_requests', verb: 'update', payload: { status: 'approved' }, filters: { id: { op: 'eq', value: first.id } } }, staff), 403, undefined, 'generic update');
      const approved = await api.post(`/api/booking-requests/${first.id}/approve`, {}, staff);
      expectStatus(approved, 200);
      const appt = (await api.db.query('select a.*, p.first_name from public.appointments a join public.patients p on p.id = a.patient_id where a.id = $1', [approved.json.appointment_id])).rows[0];
      assert.equal(appt.first_name, 'Ada');
      assert.equal(appt.status, 'scheduled');
      assert.equal(appt.customer_type, 'appointment');
      assert.equal(appt.patient_id, approved.json.patient_id);
      expectStatus(await api.post(`/api/booking-requests/${first.id}/approve`, {}, staff), 409, 'NOT_PENDING');
      // link to an existing patient instead of creating one
      const linked = await api.post(`/api/booking-requests/${second.id}/approve`, { patient_id: approved.json.patient_id, scheduled_start: `${day(5)}T14:00:00Z` }, staff);
      expectStatus(linked, 200);
      assert.equal(linked.json.patient_id, approved.json.patient_id);
      await api.post('/api/public/booking-requests', { ...BOOKING(), first_name: 'Dev' });
      const third = (await api.db.query("select id from public.booking_requests where status = 'pending'")).rows[0];
      expectStatus(await api.post(`/api/booking-requests/${third.id}/decline`, { reason: 'Duplicate' }, staff), 200);
      expectStatus(await api.post(`/api/booking-requests/${third.id}/decline`, {}, staff), 409, 'NOT_PENDING');
      const audit = await api.audit("entity_type = 'booking_request'");
      assert.deepEqual(audit.map((a) => a.summary.status), ['approved', 'approved', 'declined']);
    }),
  },
  {
    name: 'expenses: finance roles only; receipt scanning is off by default and, when on, talks to the configured OpenAI-compatible endpoint',
    fn: async ({ root, testUrl }) => {
      const hits = [];
      const ai = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          hits.push({ url: req.url, auth: req.headers.authorization, json: JSON.parse(body) });
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ choices: [{ message: { content: '```json\n{"description":"Gloves","amount":"$42.50","category":"medical equipment","expense_date":"2026-01-15","reference":"R-1","notes":"Example Supplies"}\n```' } }] }));
        });
      });
      await new Promise((r) => ai.listen(0, '127.0.0.1', r));
      const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      try {
        await withHearth({ root, testUrl }, async (api) => {
          const admin = await api.token(ADMIN);
          const staff = await api.token(STAFF);
          const mod = await api.createUser(admin, 'frontdesk@example.test', 'moderator');
          const modToken = await api.token(mod);
          expectStatus(await api.query({ table: 'expenses', select: 'id' }, staff), 403, 'FORBIDDEN', 'clinical staff');
          const created = await api.query({ table: 'expenses', verb: 'insert', payload: { description: 'Paper', amount: 12.5, category: 'Office Supplies', expense_date: day(0) }, select: 'id', single: true }, modToken);
          expectStatus(created, 200);
          expectStatus(await api.query({ table: 'expenses', verb: 'delete', filters: { id: { op: 'eq', value: created.json.data.id } } }, modToken), 403, 'FORBIDDEN', 'moderator delete');
          assert.equal((await api.audit("entity_type = 'expense'")).length, 1);
          expectStatus(await api.post('/api/expenses/analyze-receipt', { image: IMAGE }, modToken), 404, 'FEATURE_DISABLED');
          assert.equal(hits.length, 0);
          // the expenses export
          const csv = await api.post('/api/quickbooks-export', { exportType: 'expenses', startDate: day(-1), endDate: day(1) }, admin);
          expectStatus(csv, 200);
          assert.ok(csv.text.startsWith('Date,Category,Description,Amount,Reference,Notes\n'), csv.text);
          assert.ok(csv.text.includes('"Paper",12.5'), csv.text);
        });
        await withHearth({ root, testUrl, env: { RECEIPT_AI_API_KEY: 'sk-test-local', RECEIPT_AI_BASE_URL: `http://127.0.0.1:${ai.address().port}/v1`, RECEIPT_AI_MODEL: 'local-vision' } }, async (api) => {
          const admin = await api.token(ADMIN);
          const staff = await api.token(STAFF);
          assert.equal((await api.call('/api/auth/features')).json.receipt_scanning, true);
          expectStatus(await api.post('/api/expenses/analyze-receipt', { image: IMAGE }, staff), 403, 'FORBIDDEN', 'clinical staff scan');
          expectStatus(await api.post('/api/expenses/analyze-receipt', { image: 'https://example.test/x.png' }, admin), 400, 'INVALID_INPUT');
          const r = await api.post('/api/expenses/analyze-receipt', { image: IMAGE }, admin);
          expectStatus(r, 200);
          assert.deepEqual(r.json, { description: 'Gloves', amount: 42.5, category: 'Medical Equipment', expense_date: '2026-01-15', reference: 'R-1', notes: 'Example Supplies' });
          assert.equal(hits.length, 1);
          assert.equal(hits[0].url, '/v1/chat/completions');
          assert.equal(hits[0].auth, 'Bearer sk-test-local');
          assert.equal(hits[0].json.model, 'local-vision');
          assert.equal((await api.audit("entity_type = 'receipt_scan'")).length, 1);
        });
      } finally {
        await new Promise((r) => ai.close(r));
      }
    },
  },
  {
    name: 'e-mail endpoints answer 503 EMAIL_DISABLED and contact nobody when e-mail is not configured',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      expectStatus(await api.post('/api/send-invoice-email', { invoiceId: '00000000-0000-4000-8000-000000000000', recipientEmail: 'p@example.test' }, admin), 503, 'EMAIL_DISABLED');
      expectStatus(await api.post('/api/send-receipt-email', { paymentId: '00000000-0000-4000-8000-000000000000', recipientEmail: 'p@example.test' }, admin), 503, 'EMAIL_DISABLED');
    }),
  },
  {
    name: 'doctor tag and role changes go through the admin-only rpc and are audited; an admin cannot demote themselves',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const admin = await api.token(ADMIN);
      const staff = await api.token(STAFF);
      const { rows } = await api.db.query('select id, email from public.app_users order by email');
      const adminId = rows.find((r) => r.email === ADMIN.email).id;
      const staffId = rows.find((r) => r.email === STAFF.email).id;
      expectStatus(await api.post('/api/rpc/admin_update_user_role', { target_user_id: staffId, new_role: 'admin', new_is_doctor: true }, staff), 403, 'FORBIDDEN', 'staff');
      expectStatus(await api.post('/api/rpc/admin_update_user_role', { target_user_id: staffId, new_role: 'user', new_is_doctor: true }, admin), 200);
      const session = await api.call('/api/auth/session', { token: staff });
      assert.equal(session.json.user.is_doctor, true);
      expectStatus(await api.post('/api/rpc/admin_update_user_role', { target_user_id: adminId, new_role: 'user' }, admin), 403, 'FORBIDDEN', 'self-demotion');
      expectStatus(await api.post('/api/rpc/admin_update_user_role', { target_user_id: 'x', new_role: 'user' }, admin), 400);
      const audit = await api.audit("entity_type = 'user' and entity_id = $1", [staffId]);
      assert.deepEqual(audit.map((a) => a.summary), [{ role: 'user', is_doctor: true }]);
      const users = await api.post('/api/rpc/get_users_with_roles', {}, admin);
      assert.equal(users.json.find((u) => u.user_id === staffId).is_doctor, true);
    }),
  },
  {
    name: 'route sweep: every mounted /api route refuses an anonymous caller unless it is on the documented public list',
    fn: ({ root, testUrl }) => withHearth({ root, testUrl }, async (api) => {
      const { createApp } = await import('../../api/routes/index.mjs');
      const app = await createApp({ log: () => {} });
      // collect every concrete route (method + path) from the mounted routers
      const routes = [];
      const walk = (stack, prefix) => {
        for (const layer of stack) {
          if (layer.route) {
            for (const m of Object.keys(layer.route.methods)) routes.push({ method: m.toUpperCase(), path: prefix + layer.route.path });
          } else if (layer.name === 'router' && layer.handle?.stack) {
            const src = layer.regexp.source.replace('^\\/', '/').replace('\\/?(?=\\/|$)', '').replace(/\\\//g, '/');
            walk(layer.handle.stack, prefix + src.replace(/\/$/, ''));
          }
        }
      };
      walk(app._router.stack, '');
      const apiRoutes = routes.filter((r) => r.path.startsWith('/api/') && !r.path.startsWith('/api/__probe'));
      assert.ok(apiRoutes.length >= 20, `found only ${apiRoutes.length} routes: ${JSON.stringify(apiRoutes)}`);
      const PUBLIC = new Set([
        'GET /api/auth/login', 'POST /api/auth/login', 'POST /api/auth/signup', 'POST /api/auth/logout', 'GET /api/auth/features',
        'POST /api/auth/password-reset/request', 'POST /api/auth/password-reset/confirm', 'POST /api/public/booking-requests',
        'POST /api/query/', // anonymous: only the landing services read (asserted elsewhere)
      ]);
      const UUID = '00000000-0000-4000-8000-000000000000';
      const problems = [];
      for (const r of apiRoutes) {
        const key = `${r.method} ${r.path}`;
        if (PUBLIC.has(key)) continue;
        const path = r.path.replace(/:[A-Za-z_]+/g, (m) => (m === ':name' ? 'get_users_with_roles' : m === ':bucket' ? 'signatures' : UUID)).replace(/\*$/, 'x.png');
        const res = await api.call(path, { method: r.method, body: ['GET', 'HEAD', 'DELETE'].includes(r.method) ? undefined : {} });
        if (res.status !== 401) problems.push(`${key} -> ${res.status} ${res.text.slice(0, 80)}`);
      }
      assert.deepEqual(problems, [], problems.join('\n'));
      // and the anonymous query path only serves the landing services
      for (const table of ['patients', 'appointments', 'visit_notes', 'invoices', 'payments', 'expenses', 'booking_requests', 'user_roles', 'clinic_settings', 'audit_log', 'app_users']) {
        const res = await api.query({ table, select: 'id' });
        assert.equal(res.status, 401, `anonymous ${table}: ${res.status}`);
      }
    }),
  },
];
