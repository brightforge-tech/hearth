// tests/contract/quickbooks-export.test.mjs — old-vs-new CSV contract for
// /api/quickbooks-export (task t14, criterion W54/W55; the S29 suite).
//
// The reference side is tests/legacy/quickbooks-export.legacy.mjs — proven by
// tests/contract/legacy-source.test.mjs to be the shipped supabase/functions/
// quickbooks-export body verbatim. The new side is the real endpoint, driven
// over real HTTP against its own scratch database seeded from
// tests/fixtures/invoices-*.json and payments.json, with the trigger-computed
// totals (not hand-written numbers) feeding the row builders. The legacy
// builders are handed the fixtures' legacy_inputs — the PostgREST-shaped rows
// the shipped .select() returned — never anything from api/.
//
// Pinned here, exactly as the milestone words them:
//   W54  tax-free single-item fixture (clinic_settings.tax_enabled false, one
//        invoice_item per invoice, nothing needing escaping): the invoices CSV
//        the endpoint returns is BYTE-IDENTICAL to buildInvoicesCsv over the
//        same fixture; the payments CSV is byte-identical over payments.json;
//   W55  taxed fixture (2x10.00 taxable + 1x5.00 non-taxable at tax_rate 10):
//        the two CSVs differ in the Tax Amount / Total cells ONLY — endpoint
//        2,22 and 0,5 where the legacy builder writes 2,27 twice;
//        hostile fixture: the only differences are the quote doubling and the
//        formula-injection prefix, and the Taxable cell is the unquoted Y/N in
//        both builders;
//   the pinned Date cell — 8/5/2025 for the 2025-08-05T14:30:00Z invoice — is
//        asserted byte-for-byte on both sides (tests/run.mjs pins TZ=UTC);
//   the Content-Disposition filename equals the legacy template's output for
//        the same raw request strings.

import assert from 'node:assert/strict';

import { buildInvoicesCsv, buildPaymentsCsv, invoicesDisposition, paymentsDisposition } from '../legacy/quickbooks-export.legacy.mjs';
import { createScratch, dropScratch, connectDb, loadFixtures, seedFixtures } from '../helpers/db.mjs';
import { startTestApp, makeTokens } from '../helpers/http.mjs';

const SCRATCH = '_c14qbo';
const JWT_SECRET = 'c14-contract-quickbooks-secret-0123456789';
const PATH = '/api/quickbooks-export';

// One clinic, all four CSV fixtures side by side. Their windows are disjoint
// by construction (the fixtures say so), so each request answers exactly its
// own fixture's rows even on this shared scratch database.
async function withContractApp({ root, testUrl }, fn) {
  const dsn = await createScratch(testUrl, SCRATCH);
  const app = await startTestApp({ root, databaseUrl: dsn, jwtSecret: JWT_SECRET, resend: false });
  const db = await connectDb(dsn);
  try {
    const fixtures = loadFixtures(root, 'clinic-settings', 'invoices-tax-free', 'invoices-taxed', 'invoices-hostile', 'payments');
    await seedFixtures(db, fixtures, 'invoices-tax-free', 'invoices-taxed', 'invoices-hostile', 'payments');
    // The seeded clinic keeps the 0004 singleton (tax disabled) — the tax-free
    // fixture's claim of "clinic_settings.tax_enabled false" is the seed value;
    // confirm it, so a drift in 0004_seed.sql fails here, loudly.
    const { rows } = await db.query('select tax_enabled from public.clinic_settings where singleton = true');
    assert.equal(rows.length, 1, 'the clinic_settings singleton row is missing');
    assert.equal(rows[0].tax_enabled, false, 'W54 requires the fixture clinic to have tax disabled');

    // The session gate itself is tests/api/'s; this suite needs one valid
    // admin session to reach the endpoint at all.
    await db.query(
      `insert into public.app_users (id, email, password_hash)
       values ('00000000-0000-4000-e000-000000000001', 'admin@c14.test', 'scrypt$c14$fixture$not-a-real-hash')`
    );
    await db.query(
      `insert into public.user_roles (user_id, role)
       values ('00000000-0000-4000-e000-000000000001', 'admin')`
    );
    const tokens = makeTokens(JWT_SECRET, [{ key: 'admin', id: '00000000-0000-4000-e000-000000000001', email: 'admin@c14.test' }]);

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

// exportCsv: drive the endpoint and hand back its raw bytes + headers.
async function exportCsv(app, admin, body) {
  const res = await app.api(PATH, body, admin);
  assert.equal(res.status, 200, `${PATH} answered ${res.status}: ${res.text.slice(0, 300)}`);
  assert.match(String(res.headers['content-type']), /^text\/csv/, 'the endpoint must answer text/csv');
  return { bytes: res.body, text: res.body.toString('utf8'), headers: res.headers };
}

// splitCsvDataLines: header + data rows as raw lines (the fixtures that get
// field-diffed carry no embedded newlines).
function dataLines(csv) {
  const lines = csv.split('\n');
  return { header: lines[0], rows: lines.slice(1, lines.length - 1) };
}

export default [
  {
    name: 'W54: the tax-free invoices CSV is byte-identical to the legacy reference builder',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures['invoices-tax-free'];
      const reference = buildInvoicesCsv(fixture.legacy_inputs.export_invoices, fixture.request);
      const { bytes, text, headers } = await exportCsv(app, admin, fixture.request);
      assert.equal(Buffer.compare(Buffer.from(reference, 'utf8'), bytes), 0, 'invoices CSV bytes differ from the legacy reference');
      // the same content again, spelled out for the human reading the diff
      assert.equal(text, reference);
      assert.equal(
        headers['content-disposition'],
        invoicesDisposition(fixture.request),
        'the attachment filename must match the legacy Content-Disposition template'
      );
      // the pinned, environment-independent shape of the fixture
      assert.ok(text.startsWith('Date,Customer,Customer Email,Invoice Number,Item Description,Quantity,Rate,Amount,Taxable,Tax Amount,Total,Currency\n'));
      assert.ok(text.includes('"8/1/2025"'), 'the Date cell must be the pinned 8/1/2025');
      assert.ok(!/,"Y",/.test(text) && !/,"N",/.test(text), 'Taxable must never be quoted, but the fixture rows are N');
    }),
  },
  {
    name: 'W54: the payments CSV is byte-identical to the legacy reference builder',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures.payments;
      const reference = buildPaymentsCsv(fixture.legacy_inputs.export_payments, fixture.request);
      const { bytes, headers } = await exportCsv(app, admin, fixture.request);
      assert.equal(Buffer.compare(Buffer.from(reference, 'utf8'), bytes), 0, 'payments CSV bytes differ from the legacy reference');
      assert.equal(headers['content-disposition'], paymentsDisposition(fixture.request));
    }),
  },
  {
    name: 'W55 taxed: the CSVs differ in the Tax Amount/Total cells only — endpoint 2,22 and 0,5 vs legacy 2,27 twice',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures['invoices-taxed'];
      const reference = buildInvoicesCsv(fixture.legacy_inputs.export_invoices, fixture.request);
      const { text } = await exportCsv(app, admin, fixture.request);

      const legacy = dataLines(reference);
      const now = dataLines(text);
      assert.equal(now.header, legacy.header, 'the header line must be byte-identical');
      assert.equal(now.rows.length, legacy.rows.length, 'the row count must be identical (one CSV row per invoice item)');

      // Legacy: the shipped template repeats the INVOICE-level tax/total on
      // both lines (the S8 bug); the port writes per-line figures (S8 fix).
      assert.ok(legacy.rows[0].endsWith(',Y,2,27,"USD"'), `legacy line 1 must end ,Y,2,27 — got ${JSON.stringify(legacy.rows[0])}`);
      assert.ok(legacy.rows[1].endsWith(',N,2,27,"USD"'), `legacy line 2 must end ,N,2,27 — got ${JSON.stringify(legacy.rows[1])}`);
      assert.ok(now.rows[0].endsWith(',Y,2,22,"USD"'), `endpoint line 1 must end ,Y,2,22 — got ${JSON.stringify(now.rows[0])}`);
      assert.ok(now.rows[1].endsWith(',N,0,5,"USD"'), `endpoint line 2 must end ,N,0,5 — got ${JSON.stringify(now.rows[1])}`);

      // And the difference really is ONLY those cells: compare every CSV
      // field of every pair of lines; only indices 9 (Tax Amount) and
      // 10 (Total) may differ.
      for (let i = 0; i < legacy.rows.length; i++) {
        const a = legacy.rows[i].split(',');
        const b = now.rows[i].split(',');
        assert.equal(a.length, b.length, `line ${i + 1} field count differs — the diff escaped the two tax cells`);
        for (let f = 0; f < a.length; f++) {
          if (f === 9 || f === 10) continue;
          assert.equal(b[f], a[f], `line ${i + 1}: field ${f} (${JSON.stringify(a[f])}) must be byte-identical, endpoint wrote ${JSON.stringify(b[f])}`);
        }
      }
      // the pinned Date cell, both sides, byte for byte
      assert.ok(now.rows[0].startsWith('"8/5/2025"'), 'the endpoint Date cell must be the pinned 8/5/2025');
      assert.ok(legacy.rows[0].startsWith('"8/5/2025"'), 'the legacy Date cell must be the pinned 8/5/2025');
    }),
  },
  {
    name: 'W55 hostile: the only diffs are quote doubling and the formula-injection prefix; Taxable is unquoted Y/N in both',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const fixture = fixtures['invoices-hostile'];
      const reference = buildInvoicesCsv(fixture.legacy_inputs.export_invoices, fixture.request);
      const { text } = await exportCsv(app, admin, fixture.request);

      // The legacy side reproduces the S6 breakage: an unescaped quote and
      // comma in the name, and = / + cells that open as formulas.
      assert.ok(reference.includes(',"O"Neil, Bob",'), `the legacy builder must emit the broken cell (sanity): ${JSON.stringify(reference.split('\n')[1])}`);
      assert.ok(reference.includes('"+15550100@example.com"'), 'the legacy builder emits the unescaped + cell');
      assert.ok(reference.includes('"=cmd|\' /C calc\'!A0"'), 'the legacy builder emits the unescaped = cell');

      // The new side is EXACTLY the legacy CSV with the three sanctioned
      // escapes applied — any further difference fails the equality.
      const expected = reference
        .replace('"O"Neil, Bob"', '"O""Neil, Bob"')
        .replace('"+15550100@example.com"', '"\'+15550100@example.com"')
        .replace('"=cmd|\' /C calc\'!A0"', '"\'=cmd|\' /C calc\'!A0"');
      assert.equal(
        text,
        expected,
        'the hostile CSV must differ from the legacy CSV ONLY by quote doubling and the formula prefix'
      );

      // Taxable: the unquoted Y token in BOTH builders; the legacy wrote the
      // Currency cell quoted, so the port keeps it quoted.
      assert.ok(reference.includes(',Y,'), 'the legacy Taxable cell is the unquoted Y');
      assert.ok(text.includes(',Y,'), 'the endpoint Taxable cell stays the unquoted Y');
      assert.ok(!text.includes(',"Y"') && !text.includes(',"N"'), 'Taxable must never be quoted on either side');

      // every line of both CSVs carries exactly 12 cells once quoting is
      // respected — the hostile fixture is the layout-breaker and must not
      // break the endpoint's layout.
      for (const line of dataLines(text).rows) {
        const cells = line.match(/("(?:[^"]|"")*"|[^,]*)/g).filter((c) => c !== '');
        assert.equal(cells.length, 12, `endpoint hostile row must stay a 12-cell line: ${JSON.stringify(line)}`);
      }
    }),
  },
  {
    name: 'both CSVs pin the 8/5/2025 Date cell and the legacy INV-/PAY- id cells under TZ=UTC',
    fn: async (ctx) => withContractApp(ctx, async ({ app, admin, fixtures }) => {
      const taxed = fixtures['invoices-taxed'];
      assert.equal(process.env.TZ, 'UTC', 'the runner must pin TZ=UTC before the suites load');
      const legacyCsv = buildInvoicesCsv(taxed.legacy_inputs.export_invoices, taxed.request);
      const { text } = await exportCsv(app, admin, taxed.request);
      for (const [label, csv] of [['legacy', legacyCsv], ['endpoint', text]]) {
        assert.ok(csv.includes('"8/5/2025","Priya Testcase"'), `${label}: pinned 8/5/2025 Date cell missing`);
        assert.ok(csv.includes('"INV-00000003"'), `${label}: the quoted INV- id cell must be byte-identical`);
      }
      const payments = fixtures.payments;
      const legacyPay = buildPaymentsCsv(payments.legacy_inputs.export_payments, payments.request);
      const pay = await exportCsv(app, admin, payments.request);
      assert.ok(legacyPay.includes('"PAY-00000010"') && pay.text.includes('"PAY-00000010"'), 'the quoted PAY- id cell must be byte-identical');
    }),
  },
];
