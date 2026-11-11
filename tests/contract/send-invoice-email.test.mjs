// tests/contract/send-invoice-email.test.mjs — old-vs-new e-mail contract for
// /api/send-invoice-email (task t14; the W56 half of the S29 suite).
//
// The reference is tests/legacy/send-invoice-email.legacy.mjs — proven by
// tests/contract/legacy-source.test.mjs to be the shipped function's HTML
// template and subject verbatim, with no escaping (the shipped code
// interpolated patient data raw). The new side is the endpoint, driven over
// real HTTP on a scratch database seeded from tests/fixtures/invoices-*.json
// and invoice-orphan.json, with the endpoint's provider pointed at the local
// Resend stub (RESEND_API_BASE): the assertions read the {from,to,subject,html}
// the API actually put on a socket.
//
// Pinned:
//   W56  for the fixtures with no special characters (tax-free and taxed),
//        the recorded HTML is BYTE-IDENTICAL to buildInvoiceHtml over the
//        fixture's legacy_inputs, and the subject equals
//        invoiceEmailSubject(...) — same markup, same totals block (the taxed
//        letter still carries the INVOICE-LEVEL Tax 2.00 / Total 27.00 rows:
//        the S8 per-line fix is CSV-only);
//   W56  for the special-character fixture the ONLY differences are the
//        escaped values — the raw <script>/<img onerror> payloads must be
//        absent from what the endpoint sends (S10);
//   W46  the orphan invoice (appointment_id null): the legacy builder DOES
//        produce a letter addressed "undefined undefined", and the endpoint
//        instead answers exactly {"success":false,"error":"Invoice not found"}
//        as a 500 and contacts no provider — the port's one recorded
//        behavioural deviation;
//   W48  the sender is the RESEND_FROM_INVOICE value from the environment,
//        never a hardcoded address, and the success body carries
//        emailId re_stub_1 — the id the stub returned.

import assert from 'node:assert/strict';

import { buildInvoiceHtml as legacyInvoiceHtml, invoiceEmailSubject as legacyInvoiceSubject } from '../legacy/send-invoice-email.legacy.mjs';
import { rebrand } from '../helpers/brand.mjs';

// The legacy letter with the clinic's new name, the one sanctioned difference.
const buildInvoiceHtml = (input) => rebrand(legacyInvoiceHtml(input));
const invoiceEmailSubject = (input) => rebrand(legacyInvoiceSubject(input));
import { createScratch, dropScratch, connectDb, loadFixtures, seedFixtures } from '../helpers/db.mjs';
import { startTestApp, makeTokens, CONTRACT_SENDERS } from '../helpers/http.mjs';
import { ensureTestSessions } from '../helpers/session.mjs';

const SCRATCH = '_c14inv';
const JWT_SECRET = 'c14-contract-invoice-email-secret-0123';
const PATH = '/api/send-invoice-email';

async function withContractApp({ root, testUrl }, fn) {
  const dsn = await createScratch(testUrl, SCRATCH);
  const app = await startTestApp({ root, databaseUrl: dsn, jwtSecret: JWT_SECRET });
  const db = await connectDb(dsn);
  try {
    const fixtures = loadFixtures(root, 'invoices-tax-free', 'invoices-taxed', 'invoices-hostile', 'invoice-orphan');
    await seedFixtures(db, fixtures, 'invoices-tax-free', 'invoices-taxed', 'invoices-hostile', 'invoice-orphan');
    await db.query(
      `insert into public.app_users (id, email, password_hash)
       values ('00000000-0000-4000-e000-000000000002', 'admin@c14.test', 'scrypt$c14$fixture$not-a-real-hash')`
    );
    await db.query(
      `insert into public.user_roles (user_id, role)
       values ('00000000-0000-4000-e000-000000000002', 'admin')`
    );
    await ensureTestSessions(db);
    const tokens = makeTokens(JWT_SECRET, [{ key: 'admin', id: '00000000-0000-4000-e000-000000000002', email: 'admin@c14.test' }]);
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

// send: drive the endpoint, require the legacy success envelope, and return
// the single stub record it produced (this helper resets the recorder first).
async function send(app, admin, body) {
  app.resend.reset();
  const res = await app.api(PATH, body, admin);
  return { res, records: app.resend.requests };
}

function assertPostedOnce(records, { to, subject, html }) {
  assert.equal(records.length, 1, `exactly one POST to the provider, got ${records.length}`);
  const rec = records[0];
  assert.equal(rec.method, 'POST');
  assert.equal(rec.url, '/emails');
  assert.equal(rec.json.to.join(','), to.join(','));
  assert.equal(rec.json.subject, subject);
  assert.equal(rec.json.html, html);
}

export default [
  {
    name: 'W56: the tax-free letters are byte-identical to the legacy builder — HTML, subject, sender, success body',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures['invoices-tax-free'];
      for (let i = 0; i < fixture.requests.length; i++) {
        const input = fixture.legacy_inputs.invoice_emails[i];
        const reference = buildInvoiceHtml(input);
        const subject = invoiceEmailSubject(input);
        const { res, records } = await send(app, admin, fixture.requests[i]);

        assert.equal(res.status, 200, `invoice ${i}: ${res.status} ${res.text.slice(0, 200)}`);
        assert.deepEqual(res.json, {
          success: true,
          message: 'Invoice email sent successfully',
          emailId: 're_stub_1',
        });
        assert.equal(records[0].json.from, CONTRACT_SENDERS.RESEND_FROM_INVOICE, 'the sender must come from RESEND_FROM_INVOICE');
        assertPostedOnce(records, { to: [fixture.requests[i].recipientEmail], subject, html: reference });

        // shape sanity so a byte-diff failure names the region
        assert.ok(reference.includes(`<h2>Invoice #${input.id.slice(-8)}</h2>`), 'subject-block sanity');
        assert.ok(reference.includes('USD $250.00') || reference.includes('USD $110.00'), 'totals-block sanity');
      }
    }),
  },
  {
    name: 'W56: the taxed letter is byte-identical — the INVOICE-LEVEL Tax 2.00 / Total 27.00 rows in both',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures['invoices-taxed'];
      const input = fixture.legacy_inputs.invoice_emails[0];
      const reference = buildInvoiceHtml(input);
      // The S8 fix is CSV-only: the shipped totals block reads the invoice
      // columns, and so does the port — the letter keeps 2.00 / 27.00.
      assert.ok(reference.includes('<td>Tax (10%):</td>'), 'legacy with-tax row sanity');
      assert.ok(reference.includes('USD $2.00'), 'legacy tax cell sanity');
      assert.ok(reference.includes('USD $27.00'), 'legacy total cell sanity');

      const { res, records } = await send(app, admin, fixture.requests[0]);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.deepEqual(res.json, { success: true, message: 'Invoice email sent successfully', emailId: 're_stub_1' });
      assertPostedOnce(records, {
        to: [fixture.requests[0].recipientEmail],
        subject: invoiceEmailSubject(input),
        html: reference,
      });
    }),
  },
  {
    name: 'W56/S10: the special-character letter differs from the legacy one only in the escaped values; the raw payloads are absent',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures['invoices-hostile'];
      const input = fixture.legacy_inputs.invoice_emails[0];
      const reference = buildInvoiceHtml(input);

      // The legacy reference is the vulnerability: raw markup interpolated.
      for (const raw of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', "'=SUM(1,2)*cmd"]) {
        assert.ok(reference.includes(raw.replace(/^'/, '')), `the legacy builder must contain the raw payload (sanity): ${raw}`);
      }

      // The endpoint's letter is the legacy one with exactly the five
      // interpolations' escaping applied — any other difference fails here.
      let expected = reference;
      for (const [raw, escaped] of [
        ['<script>alert(1)</script>', '&lt;script&gt;alert(1)&lt;/script&gt;'],
        ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
        ["=SUM(1,2)*cmd|' /C calc'!A0", '=SUM(1,2)*cmd|&#39; /C calc&#39;!A0'],
        ["=cmd|' /C calc'!A0", '=cmd|&#39; /C calc&#39;!A0'],
        ['O"Neil,', 'O&quot;Neil,'],
      ]) {
        assert.ok(expected.includes(raw), `escape fixture sanity: ${raw} missing from the legacy HTML`);
        expected = expected.split(raw).join(escaped);
      }

      const { res, records } = await send(app, admin, fixture.requests[0]);
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.equal(records.length, 1);
      const html = records[0].json.html;
      assert.equal(html, expected);
      // the payloads, in raw form, never reach the provider
      for (const raw of ['<script>alert(1)</script>', '<img src=x onerror', 'O"Neil,', "=cmd|' /C calc'!A0"]) {
        assert.ok(!html.includes(raw), `the raw payload ${JSON.stringify(raw)} must not appear in the endpoint's HTML`);
      }
      // the subject is unaffected (no patient data in it)
      assert.equal(records[0].json.subject, invoiceEmailSubject(input));
    }),
  },
  {
    name: 'W46: the orphan invoice — the legacy builder mails "undefined undefined"; the endpoint refuses with the legacy error JSON and mails nothing',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures['invoice-orphan'];
      // the recorded deviation, pinned from the shipped side too: the shipped
      // optional chaining did build a letter addressed to undefined undefined.
      const legacyLetter = buildInvoiceHtml(fixture.legacy_inputs.invoice_orphan);
      assert.ok(legacyLetter.includes('Name:</strong> undefined undefined'), 'the shipped builder interpolated the missing appointment as "undefined undefined"');

      app.resend.reset();
      const res = await app.api(PATH, fixture.requests[0], admin);
      assert.equal(res.status, 500, `the orphan must answer the legacy 500 envelope: ${res.text.slice(0, 200)}`);
      assert.deepEqual(res.json, { success: false, error: 'Invoice not found' });
      assert.equal(app.resend.requests.length, 0, 'a refused invoice must contact no provider');
    }),
  },
];
