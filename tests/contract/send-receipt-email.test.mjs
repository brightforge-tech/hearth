// tests/contract/send-receipt-email.test.mjs — old-vs-new e-mail contract for
// /api/send-receipt-email (task t14; the W57 receipt half of the S29 suite).
//
// Same harness as its invoice sibling: the shipped-template reference from
// tests/legacy/send-receipt-email.legacy.mjs, the real endpoint on a scratch
// database seeded from tests/fixtures/receipt.json and payment-orphan.json,
// the provider replaced by the local Resend stub so every byte the endpoint
// would have mailed is recorded.
//
// Pinned:
//   W57  for the fixture with no special characters the recorded receipt HTML
//        is BYTE-IDENTICAL to buildReceiptHtml and the subject to
//        receiptEmailSubject — same markup, same Receipt R00000002 header,
//        same Date 8/8/2025 / Time 2:30:00 PM rows (TZ=UTC pinned by the
//        runner), same USD $20.00 cells — and the success body carries
//        emailId re_stub_1 from the stub;
//   W46  the orphan payment (its invoice has appointment_id null): old and
//        new AGREE — the shipped select used invoices!inner/appointments!inner,
//        so the shipped .single() also found no row and threw 'Payment not
//        found'. The endpoint answers exactly {"success":false,"error":
//        "Payment not found"} as a 500 and contacts no provider;
//   W48  the sender is RESEND_FROM_RECEIPT from the environment.

import assert from 'node:assert/strict';

import { buildReceiptHtml, receiptEmailSubject } from '../legacy/send-receipt-email.legacy.mjs';
import { createScratch, dropScratch, connectDb, loadFixtures, seedFixtures } from '../helpers/db.mjs';
import { startTestApp, makeTokens, CONTRACT_SENDERS } from '../helpers/http.mjs';
import { ensureTestSessions } from '../helpers/session.mjs';

const SCRATCH = '_c14rcpt';
const JWT_SECRET = 'c14-contract-receipt-email-secret-01';
const PATH = '/api/send-receipt-email';

async function withContractApp({ root, testUrl }, fn) {
  const dsn = await createScratch(testUrl, SCRATCH);
  const app = await startTestApp({ root, databaseUrl: dsn, jwtSecret: JWT_SECRET });
  const db = await connectDb(dsn);
  try {
    const fixtures = loadFixtures(root, 'receipt', 'payment-orphan');
    await seedFixtures(db, fixtures, 'receipt', 'payment-orphan');
    await db.query(
      `insert into public.app_users (id, email, password_hash)
       values ('00000000-0000-4000-e000-000000000003', 'admin@c14.test', 'scrypt$c14$fixture$not-a-real-hash')`
    );
    await db.query(
      `insert into public.user_roles (user_id, role)
       values ('00000000-0000-4000-e000-000000000003', 'admin')`
    );
    await ensureTestSessions(db);
    const tokens = makeTokens(JWT_SECRET, [{ key: 'admin', id: '00000000-0000-4000-e000-000000000003', email: 'admin@c14.test' }]);
    try {
      return await fn({ app, db, fixtures, admin: tokens.admin });
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
    name: 'W57: the receipt letter is byte-identical to the legacy builder — HTML, subject, sender, success body',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures.receipt;
      const input = fixture.legacy_inputs.receipts[0];
      const reference = buildReceiptHtml(input);
      const subject = receiptEmailSubject(input);

      // the milestone's receipt landmarks, so a byte-diff failure names them
      assert.ok(reference.includes('Receipt R00000002'), 'legacy Receipt-number sanity');
      assert.ok(reference.includes('>8/8/2025</span>'), 'legacy pinned Date sanity');
      assert.ok(reference.includes('>2:30:00 PM</span>'), 'legacy pinned Time sanity');
      assert.ok(reference.includes('USD $20.00'), 'legacy currency-cell sanity');

      app.resend.reset();
      const res = await app.api(PATH, fixture.requests[0], admin);
      assert.equal(res.status, 200, res.text.slice(0, 300));
      assert.deepEqual(res.json, { success: true, message: 'Receipt email sent successfully', emailId: 're_stub_1' });

      assert.equal(app.resend.requests.length, 1, 'exactly one POST to the provider');
      const rec = app.resend.requests[0];
      assert.equal(rec.method, 'POST');
      assert.equal(rec.url, '/emails');
      assert.equal(rec.json.from, CONTRACT_SENDERS.RESEND_FROM_RECEIPT, 'the sender must come from RESEND_FROM_RECEIPT');
      assert.deepEqual(rec.json.to, [fixture.requests[0].recipientEmail]);
      assert.equal(rec.json.subject, subject, 'the subject must equal the legacy subject template');
      assert.equal(rec.json.html, reference, 'the receipt HTML must be byte-identical to the legacy builder');
      // the same letters from the endpoint's own view (its Date comes from a
      // pg Date object, not the fixture string — same pinned characters)
      assert.ok(rec.json.html.includes('>8/8/2025</span>') && rec.json.html.includes('>2:30:00 PM</span>'));
    }),
  },
  {
    name: 'W46: the orphan payment — old and new agree: 500 {"success":false,"error":"Payment not found"}, no provider contacted',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      app.resend.reset();
      const res = await app.api(PATH, fixtures['payment-orphan'].requests[0], admin);
      assert.equal(res.status, 500, `the orphan must answer the legacy 500 envelope: ${res.text.slice(0, 200)}`);
      assert.deepEqual(res.json, { success: false, error: 'Payment not found' });
      assert.equal(app.resend.requests.length, 0, 'a refused payment must contact no provider');
    }),
  },
];
