// tests/parity/recalc-rpc.test.mjs — the recalc/trigger parity path (task t14,
// milestone 5, W58).
//
// Visit.tsx drives the money side of a visit entirely through supabase-js:
// insert an invoice for the appointment, insert its invoice_items line by line,
// flip the invoice to issued, mark the appointment completed, and Billing.tsx
// records payments — every one of which depended on a hosted trigger or the
// RPC the trigger chain called (recalc_invoice_totals / recalc_invoice_payments)
// to move subtotal/tax_amount/total/paid_amount/status. This suite replays
// exactly that call sequence against /api/query on a scratch database, so the
// trigger arithmetic is pinned against the Supabase functions it was ported
// from — including the two behaviours the pages rely on that are NOT in any
// SQL the pages issue themselves:
//
//   * the page sends its clinic's tax flag and rate on the invoice row
//     (the shipped app and every contract fixture do exactly this), while
//     currency stays at its schema default USD, and line_total is computed,
//     not sent (set_invoice_item_line_total);
//   * tax applies to the taxable subtotal only (2x10.00 taxable + 1x5.00
//     non-taxable at 10% -> subtotal 25.00, tax 2.00, total 27.00 — the same
//     number the taxed contract fixture pins on the CSV side);
//   * paying to the total flips status draft->paid, and deleting that payment
//     flips it back paid->issued (recalc_invoice_payments);
//   * get_users_with_roles answers the seeded email/role pairs for an admin
//     and refuses everyone else (parity with the hosted SECURITY DEFINER RPC).
//
// Everything runs through the real HTTP endpoint (staff Bearer token) so the
// `set local app.uid` identity path is exercised too — the triggers and
// policies see the caller exactly as the hosted RLS did.

import assert from 'node:assert/strict';

import { connectDb, createScratch, dropScratch, seedUsers } from '../helpers/db.mjs';
import { makeTokens, startTestApp } from '../helpers/http.mjs';

const SCRATCH = '_c14rpc';
const JWT_SECRET = 'recalc-rpc-parity-secret-32-chars!!';

const ID = {
  admin: 'a0000000-0000-4000-8000-000000000001',
  staff: 'a0000000-0000-4000-8000-000000000002',
  doctor: 'a0000000-0000-4000-8000-000000000003',
};

// The clinic the page opens the invoice against: tax on, 10% — the same
// setting the taxed contract fixture pins.
const FIXTURE = [
  `update public.clinic_settings set tax_enabled = true, tax_rate = 10.00`, [],
  `insert into public.patients (id, first_name, last_name, phone)
   values ('b0000000-0000-4000-8000-000000000001', 'Rita', 'Parity', '+1-555-0100')`, [],
  `insert into public.appointments (id, patient_id, scheduled_start, status, reason)
   values ('b0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001',
           '2025-08-05T09:00:00Z', 'scheduled', 'Knee pain')`, [],
];

async function withRecalcApp({ root, testUrl }, fn) {
  const dsn = await createScratch(testUrl, SCRATCH);
  const app = await startTestApp({ root, databaseUrl: dsn, jwtSecret: JWT_SECRET, resend: false });
  const db = await connectDb(dsn);
  try {
    await seedUsers(db, [
      { id: ID.admin, email: 'admin@rpc14.test', roles: ['admin'] },
      { id: ID.staff, email: 'staff@rpc14.test', roles: ['user'] },
      { id: ID.doctor, email: 'doctor@rpc14.test', roles: ['user'] },
    ]);
    for (let i = 0; i < FIXTURE.length; i += 2) await db.query(FIXTURE[i], FIXTURE[i + 1]);
    const tokens = makeTokens(JWT_SECRET, [
      { key: 'admin', id: ID.admin, email: 'admin@rpc14.test' },
      { key: 'staff', id: ID.staff, email: 'staff@rpc14.test' },
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

// POST /api/query and fail loudly (with the server log) unless 200 + no error.
async function ok(app, tokens, who, body) {
  const res = await app.api('/api/query', body, tokens[who]);
  assert.equal(res.status, 200, `/api/query ${body.table}.${body.verb ?? 'select'} as ${who}: ${res.status} ${res.text}`);
  assert.equal(res.json.error, null, `/api/query ${body.table}.${body.verb ?? 'select'} as ${who}: ${JSON.stringify(res.json.error)}`);
  return res.json.data;
}

export default [
  {
    name: 'the Visit.tsx invoice sequence: inserts alone drive subtotal/tax/total through the triggers',
    fn: async (ctx) => withRecalcApp(ctx, async ({ app, tokens }) => {
      // 1. Visit.tsx `createInvoice`: insert the invoice row for the visit.
      //    The page passes its clinic tax settings on the row (exactly what
      //    the shipped app and every contract fixture do — the column
      //    defaults leave currency 'USD' and tax on); money columns stay at
      //    0 until the line items arrive.
      const [invoice] = await ok(app, tokens, 'staff', {
        table: 'invoices',
        verb: 'insert',
        payload: { appointment_id: 'b0000000-0000-4000-8000-000000000002', tax_enabled: true, tax_rate: 10.0 },
        select: '*',
      });
      assert.equal(invoice.status, 'draft');
      assert.equal(invoice.currency_code, 'USD');
      assert.equal(invoice.tax_enabled, true);
      assert.equal(Number(invoice.tax_rate), 10);
      assert.equal(Number(invoice.total), 0);

      // 2. the item rows: 2x10.00 taxable + 1x5.00 non-taxable, sent one
      //    insert at a time exactly as the page does. line_total is never
      //    sent — the trigger computes it.
      const items = [
        { description: 'Initial Consultation', quantity: 1, unit_price: 10.0, taxable: true },
        { description: 'Follow-up Visit', quantity: 1, unit_price: 10.0, taxable: true },
        { description: 'Bandage', quantity: 1, unit_price: 5.0, taxable: false },
      ];
      for (const item of items) {
        const [row] = await ok(app, tokens, 'staff', {
          table: 'invoice_items', verb: 'insert', payload: { invoice_id: invoice.id, ...item }, select: '*',
        });
        assert.equal(Number(row.line_total), item.quantity * item.unit_price,
          `set_invoice_item_line_total must compute ${item.description}`);
      }

      // 3. every item write cascaded through the after_invoice_item_* trigger
      //    into recalc_invoice_totals: subtotal is every line, tax is computed
      //    on the TAXABLE subtotal only (20.00 * 10% = 2.00), total = both.
      const inv = await ok(app, tokens, 'staff', {
        table: 'invoices', select: 'subtotal, tax_amount, total, paid_amount, status',
        filters: { id: invoice.id }, single: true,
      });
      assert.equal(Number(inv.subtotal), 25.0);
      assert.equal(Number(inv.tax_amount), 2.0);
      assert.equal(Number(inv.total), 27.0);
      assert.equal(Number(inv.paid_amount), 0);
      assert.equal(inv.status, 'draft');

      // 4. the page flips the invoice to issued and completes the appointment;
      //    neither write may disturb the computed totals (the update trigger
      //    chain keeps updated_at moving but the money columns intact).
      await ok(app, tokens, 'staff', {
        table: 'invoices', verb: 'update', payload: { status: 'issued' }, filters: { id: invoice.id }, select: 'id',
      });
      await ok(app, tokens, 'staff', {
        table: 'appointments', verb: 'update', payload: { status: 'completed' },
        filters: { id: 'b0000000-0000-4000-8000-000000000002' }, select: 'id',
      });
      const after = await ok(app, tokens, 'staff', {
        table: 'invoices', select: 'subtotal, tax_amount, total, paid_amount, status',
        filters: { id: invoice.id }, single: true,
      });
      assert.deepEqual(
        { ...after, subtotal: Number(after.subtotal), tax_amount: Number(after.tax_amount), total: Number(after.total), paid_amount: Number(after.paid_amount) },
        { subtotal: 25, tax_amount: 2, total: 27, paid_amount: 0, status: 'issued' });
    }),
  },

  {
    name: 'the Billing.tsx payment path: pay to the total -> paid, delete the payment -> issued again',
    fn: async (ctx) => withRecalcApp(ctx, async ({ app, tokens }) => {
      const [invoice] = await ok(app, tokens, 'staff', {
        table: 'invoices', verb: 'insert',
        payload: { appointment_id: 'b0000000-0000-4000-8000-000000000002', tax_enabled: true, tax_rate: 10.0 }, select: 'id',
      });
      await ok(app, tokens, 'staff', {
        table: 'invoice_items', verb: 'insert',
        payload: { invoice_id: invoice.id, description: 'Initial Consultation', quantity: 2, unit_price: 10.0, taxable: true },
        select: 'id',
      });
      await ok(app, tokens, 'staff', {
        table: 'invoice_items', verb: 'insert',
        payload: { invoice_id: invoice.id, description: 'Bandage', quantity: 1, unit_price: 7.0, taxable: false },
        select: 'id',
      });
      await ok(app, tokens, 'staff', {
        table: 'invoices', verb: 'update', payload: { status: 'issued' }, filters: { id: invoice.id }, select: 'id',
      });
      // totals: 2x10.00 taxable + 7.00 non-taxable at 10% -> 27.00 + 2.00 = 29.00
      const issued = await ok(app, tokens, 'staff', {
        table: 'invoices', select: 'total, status', filters: { id: invoice.id }, single: true,
      });
      assert.equal(Number(issued.total), 29.0);
      assert.equal(issued.status, 'issued');

      // a partial payment: paid_amount moves, status must NOT flip
      await ok(app, tokens, 'staff', {
        table: 'payments', verb: 'insert',
        payload: { invoice_id: invoice.id, amount: 10.0, method: 'cash', reference: 'recalc-partial' }, select: 'id',
      });
      const partial = await ok(app, tokens, 'staff', {
        table: 'invoices', select: 'paid_amount, status', filters: { id: invoice.id }, single: true,
      });
      assert.equal(Number(partial.paid_amount), 10.0);
      assert.equal(partial.status, 'issued');

      // paying the remainder: recalc_invoice_payments flips draft/issued -> paid
      await ok(app, tokens, 'staff', {
        table: 'payments', verb: 'insert',
        payload: { invoice_id: invoice.id, amount: 19.00, method: 'card', reference: 'recalc-rest' }, select: 'id',
      });
      const paid = await ok(app, tokens, 'staff', {
        table: 'invoices', select: 'paid_amount, status', filters: { id: invoice.id }, single: true,
      });
      assert.equal(Number(paid.paid_amount), 29.0);
      assert.equal(paid.status, 'paid');

      // Billing's W27 case: an admin voids the second payment (staff cannot,
      // 403) and the invoice falls back to issued — the reverse status flip
      // the hosted function implemented.
      const denied = await app.api('/api/query', {
        table: 'payments', verb: 'delete', filters: { reference: 'recalc-rest' },
      }, tokens.staff);
      assert.equal(denied.status, 403, `staff payment delete must stay denied: ${denied.text}`);
      await ok(app, tokens, 'admin', {
        table: 'payments', verb: 'delete', filters: { reference: 'recalc-rest' }, select: 'id',
      });
      const back = await ok(app, tokens, 'staff', {
        table: 'invoices', select: 'paid_amount, status', filters: { id: invoice.id }, single: true,
      });
      assert.equal(Number(back.paid_amount), 10.0);
      assert.equal(back.status, 'issued', 'paid -> issued when payments fall below the total');
    }),
  },

  {
    name: 'get_users_with_roles parity: the admin sees the seeded email/role pairs, everyone else is refused',
    fn: async (ctx) => withRecalcApp(ctx, async ({ app, tokens }) => {
      const res = await app.api('/api/rpc/get_users_with_roles', {}, tokens.admin);
      assert.equal(res.status, 200, res.text);
      const rows = res.json;
      // three seeded users, four role rows (admin@ is admin; staff/doctor are
      // user) — the function returns one row per (user, role) pair exactly as
      // the hosted SECURITY DEFINER function did.
      const pairs = rows.map((r) => `${r.email}:${r.role}`).sort();
      assert.deepEqual(pairs, [
        'admin@rpc14.test:admin',
        'doctor@rpc14.test:user',
        'staff@rpc14.test:user',
      ]);
      assert.ok(rows.every((r) => typeof r.user_id === 'string' && typeof r.created_at === 'string'));

      // staff hits the function's own raise -> 403 with the standard envelope,
      // the same "Access denied. Admin role required." the hosted RPC raised.
      const staff = await app.api('/api/rpc/get_users_with_roles', {}, tokens.staff);
      assert.equal(staff.status, 403, staff.text);
      assert.match(String(staff.json.error.message), /access denied/i);

      // anonymous never reaches the database at all (requireAuth in front).
      const anon = await app.api('/api/rpc/get_users_with_roles', {}, null);
      assert.equal(anon.status, 401, anon.text);

      // and the allow-list: an unlisted function name is a 404 even for an admin.
      const unknown = await app.api('/api/rpc/recalc_invoice_totals', {}, tokens.admin);
      assert.equal(unknown.status, 404, unknown.text);
    }),
  },
];
