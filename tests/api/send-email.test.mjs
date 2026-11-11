// tests/api/send-email.test.mjs — POST /api/send-invoice-email and
// POST /api/send-receipt-email: the ported e-mail endpoints (task t11;
// milestone-4 criteria W42 [their half], W45, W46, W47, W48).
//
// Same honesty as the export suite: a real `node api/server.mjs` against a
// real PostgreSQL on a scratch database, driven over real HTTP. The one
// addition is api/lib/resend.mjs's own seam — the server's RESEND_API_BASE
// points at the in-process stub from tests/helpers/resend-stub.mjs, so every
// assertion about "exactly one POST to $RESEND_API_BASE/emails", the
// Authorization header, the sender, the escaped HTML and "sends nothing" is
// read off bytes the API actually put on a socket.

import { CLINIC_NAME } from '../helpers/brand.mjs';
import pg from 'pg';

import { signToken } from '../../api/lib/tokens.mjs';
import { request, startServer } from '../helpers/server.mjs';
import { startResendStub } from '../helpers/resend-stub.mjs';

const SCRATCH = '_t11';
const JWT_SECRET = 't11-email-suite-secret-0123456789abcdef';
const RESEND_KEY = 'rk_t11_test_key';
const FROM_INVOICE = 'Harbourview Medical Centre <invoices@clinic.example>';
const FROM_RECEIPT = 'Harbourview Medical Centre <receipts@clinic.example>';

const INVOICE_PATH = '/api/send-invoice-email';
const RECEIPT_PATH = '/api/send-receipt-email';

// --- scratch-database plumbing (same shape as the export suite) ---------------
function scratchDsn(testUrl) {
  const base = decodeURIComponent(new URL(testUrl).pathname.replace(/^\//, ''));
  const u = new URL(testUrl);
  u.pathname = `/${base}${SCRATCH}`;
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

async function withAdminDb(testUrl, fn) {
  const admin = new pg.Client(clientParams(testUrl, 'postgres'));
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

// --- fixture helpers -----------------------------------------------------------
async function insertPatient(db, { first = 'Jane', last = 'Doe', email = 'jane@example.com', phone = '+1-555-555-0100', address = '12 Main Street' } = {}) {
  const r = await db.query(
    'insert into public.patients (first_name, last_name, email, phone, address) values ($1,$2,$3,$4,$5) returning id',
    [first, last, email, phone, address]
  );
  return r.rows[0].id;
}

async function insertAppointment(db, patientId, { reason = 'Annual check-up' } = {}) {
  const r = await db.query(
    'insert into public.appointments (patient_id, scheduled_start, reason) values ($1,$2,$3) returning id',
    [patientId, '2025-08-05T14:00:00Z', reason]
  );
  return r.rows[0].id;
}

async function insertInvoice(db, { appointment_id = null, status = 'issued', tax_enabled = true, tax_rate = 10 } = {}) {
  const r = await db.query(
    `insert into public.invoices (appointment_id, status, tax_enabled, tax_rate, created_at)
     values ($1,$2::public.invoice_status,$3,$4,$5) returning id`,
    [appointment_id, status, tax_enabled, tax_rate, '2025-08-05T14:30:00Z']
  );
  return r.rows[0].id;
}

async function insertItems(db, invoiceId) {
  // the milestone's invoice: 2×10.00 taxable and 1×5.00 non-taxable at 10% —
  // the recalc triggers put subtotal 25.00 / tax_amount 2.00 / total 27.00
  // on the invoice; the e-mail's line rows must carry 22.00 and 5.00.
  for (const item of [
    { description: 'Consultation', quantity: 2, unit_price: 10, taxable: true },
    { description: 'Dressing', quantity: 1, unit_price: 5, taxable: false },
  ]) {
    await db.query(
      'insert into public.invoice_items (invoice_id, description, quantity, unit_price, taxable) values ($1,$2,$3,$4,$5)',
      [invoiceId, item.description, item.quantity, item.unit_price, item.taxable]
    );
  }
}

async function insertPayment(db, invoiceId, { amount = 20, reference = 'R-1' } = {}) {
  const r = await db.query(
    `insert into public.payments (invoice_id, amount, method, reference, received_at)
     values ($1,$2,'cash',$3,$4) returning id`,
    [invoiceId, amount, reference, '2025-08-05T14:30:00Z']
  );
  return r.rows[0].id;
}

async function insertUser(db, alias, role) {
  const r = await db.query(
    'insert into public.app_users (email, password_hash) values ($1,$2) returning id, email',
    [`${alias}@t11.test`, 'scrypt$t11$fixture$not-a-real-hash']
  );
  const user = r.rows[0];
  if (role) await db.query('insert into public.user_roles (user_id, role) values ($1,$2::public.app_role)', [user.id, role]);
  return user;
}

// withApi({root, testUrl, env, seed, fixture}, fn): scratch database ->
// running API (its RESEND_API_BASE pointed at a fresh stub) -> fixture rows
// committed -> the case runs -> everything dropped.
async function withApi({ root, testUrl, env = {}, seed = {}, fixture = null }, fn) {
  const dsn = scratchDsn(testUrl);
  const scratch = decodeURIComponent(new URL(dsn).pathname.replace(/^\//, ''));
  await withAdminDb(testUrl, async (admin) => {
    await admin.query(`drop database if exists "${scratch}" with (force)`);
    await admin.query(`create database "${scratch}"`);
  });

  const stub = await startResendStub({ id: 're_t11' });
  const handle = startServer({
    root,
    databaseUrl: dsn,
    env: {
      JWT_SECRET,
      RESEND_API_KEY: RESEND_KEY,
      RESEND_API_BASE: stub.baseUrl,
      RESEND_FROM_INVOICE: FROM_INVOICE,
      RESEND_FROM_RECEIPT: FROM_RECEIPT,
      ...env,
    },
  });
  const db = new pg.Client(clientParams(dsn, scratch));
  try {
    await handle.waitForPort();
    await db.connect();

    const users = {};
    for (const [alias, role] of Object.entries(seed)) users[alias] = await insertUser(db, alias, role);
    const fx = fixture ? await fixture(db) : {};

    const api = {
      db,
      fx,
      users,
      stub,
      port: handle.port,
      log: handle.log,
      tokenFor: (user) => signToken({ sub: user.id, email: user.email }, { secret: JWT_SECRET }),
      mail: (path, body, token = null) =>
        request(handle.port, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        }),
      invoice: (body, token = null) => api.mail(INVOICE_PATH, body, token),
      receipt: (body, token = null) => api.mail(RECEIPT_PATH, body, token),
    };
    await fn(api);
  } finally {
    try {
      await db.end();
    } catch {
      /* the connection may already have gone with the server */
    }
    await handle.stop();
    await stub.close();
    try {
      await withAdminDb(testUrl, (admin) => admin.query(`drop database if exists "${scratch}" with (force)`));
    } catch {
      /* leaving a scratch database behind is not a test failure */
    }
  }
}

function expectError(r, status, code, { label = `${status}` } = {}) {
  if (r.status !== status) throw new Error(`${label}: expected ${status}, got ${r.status}: ${r.text}`);
  if (!/^application\/json/.test(r.headers['content-type'] ?? '')) {
    throw new Error(`${label}: content-type is ${r.headers['content-type']}: ${r.text}`);
  }
  if (typeof r.json?.error?.code !== 'string' || typeof r.json?.error?.message !== 'string') {
    throw new Error(`${label}: expected the {"error":{"code","message"}} envelope, got ${r.text}`);
  }
  if (r.json.error.code !== code) throw new Error(`${label}: expected code ${code}, got ${JSON.stringify(r.json.error)}`);
}

function assertJson500(r, expected, label) {
  if (r.status !== 500) throw new Error(`${label}: expected 500, got ${r.status}: ${r.text}`);
  if (!/^application\/json/.test(r.headers['content-type'] ?? '')) {
    throw new Error(`${label}: content-type is ${r.headers['content-type']}: ${r.text}`);
  }
  for (const [key, value] of Object.entries(expected)) {
    if (r.json?.[key] !== value) throw new Error(`${label}: body is ${r.text}, want ${key}=${JSON.stringify(value)}`);
  }
}

// The clinic fixture the milestone describes: patient -> appointment ->
// issued invoice (2×10 taxable + 1×5 non-taxable at 10%) -> partial payment.
async function clinicFixture(db) {
  const patient = await insertPatient(db);
  const appointment = await insertAppointment(db, patient);
  const invoice = await insertInvoice(db, { appointment_id: appointment });
  await insertItems(db, invoice);
  const payment = await insertPayment(db, invoice);
  return { patient, appointment, invoice, payment };
}

const STAFF = { boss: 'admin', nurse: 'user', ghost: null };
const RECIPIENT = 'p@example.com';

export default [
  {
    name: 'W42: neither e-mail endpoint answers without a session; forged 401, roleless 403; staff reach the normal path',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: STAFF, fixture: clinicFixture }, async (api) => {
        for (const [label, call] of [
          ['send-invoice-email', (t) => api.invoice({ invoiceId: api.fx.invoice, recipientEmail: RECIPIENT }, t)],
          ['send-receipt-email', (t) => api.receipt({ paymentId: api.fx.payment, recipientEmail: RECIPIENT }, t)],
        ]) {
          expectError(await call(null), 401, 'UNAUTHORIZED', { label: `${label}: no Authorization header` });
          const forged = signToken({ sub: api.users.boss.id, email: api.users.boss.email }, { secret: 'a-different-issuer-secret-00000' });
          expectError(await call(forged), 401, 'UNAUTHORIZED', { label: `${label}: forged signature` });
          expectError(await call(api.tokenFor(api.users.ghost)), 403, 'NO_ROLE', { label: `${label}: session with no user_roles row` });
          if (api.stub.requests.length !== 0) throw new Error(`${label}: a refused request contacted the provider`);
        }

        // the same request with the seeded staff token reaches the normal path
        for (const [label, call, token] of [
          ['send-invoice-email', (t) => api.invoice({ invoiceId: api.fx.invoice, recipientEmail: RECIPIENT }, t), api.tokenFor(api.users.nurse)],
          ['send-receipt-email', (t) => api.receipt({ paymentId: api.fx.payment, recipientEmail: RECIPIENT }, t), api.tokenFor(api.users.boss)],
        ]) {
          const ok = await call(token);
          if (ok.status !== 200) throw new Error(`${label}: staff token -> ${ok.status}: ${ok.text}`);
        }
        if (api.stub.requests.length !== 2) throw new Error(`expected exactly 2 sends, saw ${api.stub.requests.length}`);
      });
    },
  },
  {
    name: 'W45: invoice email — legacy success JSON, one POST to $RESEND_API_BASE/emails with the key, sender, subject and Date line',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: STAFF, fixture: clinicFixture }, async (api) => {
        const r = await api.invoice({ invoiceId: api.fx.invoice, recipientEmail: RECIPIENT }, api.tokenFor(api.users.nurse));
        if (r.status !== 200) throw new Error(`staff token -> ${r.status}: ${r.text}`);
        if (!/^application\/json/.test(r.headers['content-type'] ?? '')) throw new Error(`content-type ${r.headers['content-type']}`);
        if (r.json?.success !== true || r.json?.message !== 'Invoice email sent successfully') {
          throw new Error(`body is ${r.text}`);
        }
        if (typeof r.json.emailId !== 'string' || r.json.emailId === '') throw new Error(`emailId missing: ${r.text}`);

        if (api.stub.requests.length !== 1) throw new Error(`expected exactly one POST to the provider, saw ${api.stub.requests.length}`);
        const sent = api.stub.requests[0];
        if (sent.method !== 'POST' || sent.url !== '/emails') throw new Error(`the request went to ${sent.method} ${sent.url}`);
        if (sent.headers.authorization !== `Bearer ${RESEND_KEY}`) throw new Error(`Authorization is ${JSON.stringify(sent.headers.authorization)}`);
        if (sent.json?.from !== FROM_INVOICE) throw new Error(`from is ${JSON.stringify(sent.json?.from)}, want RESEND_FROM_INVOICE`);
        if (JSON.stringify(sent.json?.to) !== JSON.stringify([RECIPIENT])) throw new Error(`to is ${JSON.stringify(sent.json?.to)}`);
        if (sent.json?.subject !== `Invoice #${api.fx.invoice.slice(-8)} from ${CLINIC_NAME}`) {
          throw new Error(`subject is ${JSON.stringify(sent.json?.subject)}`);
        }
        // the created_at 2025-08-05T14:30:00Z header line and the legacy totals
        const html = sent.json.html;
        if (!html.includes('Date: 8/5/2025')) throw new Error('the Date: line is not "Date: 8/5/2025"');
        for (const snippet of [
          '<td>USD $25.00</td>', // subtotal
          '<td>Tax (10%):</td>',
          '<td>USD $2.00</td>', // invoice-level tax — in the TOTALS block
          '<td>USD $27.00</td>', // total
          '<td>USD $20.00</td>', // paid...
          '<td>Consultation</td>',
          '<td>2</td>',
          '<td>USD $10.00</td>',
        ]) {
          if (!html.includes(snippet)) throw new Error(`the invoice HTML lost ${JSON.stringify(snippet)}:\n${html}`);
        }
        if (!html.includes('<h2>Invoice #') || !html.includes(CLINIC_NAME)) throw new Error('header lost');
      });
    },
  },
  {
    name: 'W45: receipt email — success JSON, R-upper-last8 subject, #UPPER invoice cell, legacy Date/Time rows',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: STAFF, fixture: clinicFixture }, async (api) => {
        const r = await api.receipt({ paymentId: api.fx.payment, recipientEmail: RECIPIENT }, api.tokenFor(api.users.nurse));
        if (r.status !== 200) throw new Error(`staff token -> ${r.status}: ${r.text}`);
        if (r.json?.success !== true || r.json?.message !== 'Receipt email sent successfully') throw new Error(`body is ${r.text}`);
        if (typeof r.json.emailId !== 'string' || r.json.emailId === '') throw new Error(`emailId missing: ${r.text}`);

        if (api.stub.requests.length !== 1) throw new Error(`expected exactly one POST, saw ${api.stub.requests.length}`);
        const sent = api.stub.requests[0];
        const upper8 = (u) => u.slice(-8).toUpperCase();
        if (sent.json?.subject !== `Payment Receipt R${upper8(api.fx.payment)}`) throw new Error(`subject is ${JSON.stringify(sent.json?.subject)}`);
        if (sent.json?.from !== FROM_RECEIPT) throw new Error(`from is ${JSON.stringify(sent.json?.from)}, want RESEND_FROM_RECEIPT`);
        if (sent.headers.authorization !== `Bearer ${RESEND_KEY}`) throw new Error(`Authorization is ${JSON.stringify(sent.headers.authorization)}`);
        const html = sent.json.html;
        if (!html.includes(`Receipt R${upper8(api.fx.payment)}`)) throw new Error('the Receipt number is missing');
        if (!html.includes(`<span class="detail-value">#${upper8(api.fx.invoice)}</span>`)) throw new Error('the invoice reference cell is wrong');
        if (!html.includes('<span class="detail-value">8/5/2025</span>')) throw new Error('the Date row is not 8/5/2025');
        if (!html.includes('<span class="detail-value">2:30:00 PM</span>')) throw new Error('the Time row is not 2:30:00 PM');
        for (const snippet of ['<span class="payment-method">cash</span>', '<span class="detail-value">R-1</span>', 'USD $27.00', 'USD $20.00', 'Jane Doe']) {
          if (!html.includes(snippet)) throw new Error(`the receipt HTML lost ${JSON.stringify(snippet)}`);
        }
      });
    },
  },
  {
    name: 'W45: the legacy validation error — missing paymentId (or recipientEmail) is the flat error JSON and sends nothing',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: STAFF, fixture: clinicFixture }, async (api) => {
        const token = api.tokenFor(api.users.nurse);
        const cases = [
          [{ recipientEmail: RECIPIENT }, 'missing paymentId'],
          [{}, 'missing everything'],
          [{ paymentId: api.fx.payment }, 'missing recipientEmail'],
          [{ paymentId: '', recipientEmail: RECIPIENT }, 'empty paymentId'],
        ];
        for (const [body, label] of cases) {
          const r = await api.receipt(body, token);
          assertJson500(r, { error: 'Payment ID and recipient email are required' }, `receipt ${label}`);
          if ('success' in (r.json ?? {})) throw new Error(`receipt ${label} grew a success field the shipped contract lacks: ${r.text}`);
        }
        if (api.stub.requests.length !== 0) throw new Error('a refused request contacted the provider');
      });
    },
  },
  {
    name: 'W46: unknown ids and unresolvable patients answer the legacy not-found JSON and send nothing',
    async fn({ root, testUrl }) {
      await withApi(
        {
          root,
          testUrl,
          seed: STAFF,
          fixture: async (db) => {
            const fx = await clinicFixture(db);
            // an invoice with NO appointment at all, and a payment on it —
            // the rows the legacy function would have mailed to "undefined
            // undefined"; the port must refuse them.
            const invoiceNoAppt = await insertInvoice(db, { appointment_id: null });
            await insertItems(db, invoiceNoAppt);
            const paymentNoAppt = await insertPayment(db, invoiceNoAppt, { amount: 5 });
            // an invoice whose appointment exists but the appointment's
            // patient row was deleted: the INNER JOINs still find no row.
            const orphanPatient = await insertPatient(db, { first: 'Ghost', last: 'Row' });
            const orphanAppt = await insertAppointment(db, orphanPatient);
            const orphanInvoice = await insertInvoice(db, { appointment_id: orphanAppt });
            const orphanPayment = await insertPayment(db, orphanInvoice, { amount: 5 });
            await db.query('delete from public.appointments where id = $1', [orphanAppt]);
            await db.query('delete from public.patients where id = $1', [orphanPatient]);
            return { ...fx, invoiceNoAppt, paymentNoAppt, orphanInvoice, orphanPayment };
          },
        },
        async (api) => {
          const token = api.tokenFor(api.users.boss);
          const UNKNOWN = '0e9d2f4a-7d5b-4f3a-9b6c-1a2b3c4d5e6f';

          const invCases = [
            [{ invoiceId: UNKNOWN }, 'unknown invoice id'],
            [{ invoiceId: api.fx.invoiceNoAppt }, 'invoice with appointment_id null'],
            [{ invoiceId: api.fx.orphanInvoice }, 'invoice whose patient row is gone'],
            [{ invoiceId: 'not-a-uuid' }, 'a non-uuid invoiceId'],
            [{}, 'invoiceId absent'],
          ];
          for (const [body, label] of invCases) {
            const r = await api.invoice(body, token);
            assertJson500(r, { success: false, error: 'Invoice not found' }, `invoice ${label}`);
          }

          const payCases = [
            [{ paymentId: UNKNOWN, recipientEmail: RECIPIENT }, 'unknown payment id'],
            [{ paymentId: api.fx.paymentNoAppt, recipientEmail: RECIPIENT }, "payment whose invoice has no appointment"],
            [{ paymentId: api.fx.orphanPayment, recipientEmail: RECIPIENT }, 'payment whose patient row is gone'],
            [{ paymentId: 'not-a-uuid', recipientEmail: RECIPIENT }, 'a non-uuid paymentId'],
          ];
          for (const [body, label] of payCases) {
            const r = await api.receipt(body, token);
            assertJson500(r, { success: false, error: 'Payment not found' }, `receipt ${label}`);
          }

          if (api.stub.requests.length !== 0) throw new Error('a refused request contacted the provider');
        }
      );
    },
  },
  {
    name: 'W47: patient values and the reason arrive HTML-escaped — the sent payload never carries raw markup',
    async fn({ root, testUrl }) {
      await withApi(
        {
          root,
          testUrl,
          seed: STAFF,
          fixture: async (db) => {
            const patient = await insertPatient(db, { first: '<img', last: 'src=x onerror=alert(1)>', email: 'x&y@example.com', phone: '<b>1</b>555', address: '<a href=x>click</a>' });
            const appointment = await insertAppointment(db, patient, { reason: '<script>alert(1)</script>' });
            const invoice = await insertInvoice(db, { appointment_id: appointment });
            await insertItems(db, invoice);
            const payment = await insertPayment(db, invoice, { reference: '<script>ref</script>' });
            return { patient, appointment, invoice, payment };
          },
        },
        async (api) => {
          const token = api.tokenFor(api.users.nurse);

          const inv = await api.invoice({ invoiceId: api.fx.invoice, recipientEmail: RECIPIENT }, token);
          if (inv.status !== 200) throw new Error(`invoice -> ${inv.status}: ${inv.text}`);
          let html = api.stub.requests[0].json.html;
          if (html.includes('<script>')) throw new Error('the raw <script> survived into the sent invoice payload:\n' + html);
          if (html.includes('<img')) throw new Error('the raw <img> survived into the sent invoice payload:\n' + html);
          if (!html.includes('&lt;script&gt;alert(1)&lt;/script&gt;')) throw new Error('the escaped reason is missing');
          if (!html.includes('&lt;img src=x onerror=alert(1)&gt;')) throw new Error('the escaped patient name is missing');
          if (html.includes('x&y@example.com')) throw new Error('the patient email was not escaped');
          if (html.includes('x&amp;y@example.com') === false) throw new Error('the escaped email is missing');
          if (/<[a-zA-Z][^>]*onerror=/i.test(html)) throw new Error('a live onerror attribute exists in the sent payload');

          const rec = await api.receipt({ paymentId: api.fx.payment, recipientEmail: RECIPIENT }, token);
          if (rec.status !== 200) throw new Error(`receipt -> ${rec.status}: ${rec.text}`);
          html = api.stub.requests[1].json.html;
          if (html.includes('<script>')) throw new Error('the raw <script> survived into the sent receipt payload');
          if (html.includes('<img')) throw new Error('the raw <img> survived into the sent receipt payload');
          if (!html.includes('&lt;script&gt;ref&lt;/script&gt;')) throw new Error('the escaped payment reference is missing');
          if (!html.includes('&lt;img src=x onerror=alert(1)&gt;')) throw new Error('the escaped patient name is missing');
          if (/<[a-zA-Z][^>]*onerror=/i.test(html)) throw new Error('a live onerror attribute exists in the sent receipt payload');
        }
      );
    },
  },
  {
    name: 'W48: RESEND_FROM_INVOICE / RESEND_FROM_RECEIPT unset -> legacy failure JSON, zero provider requests (and the two are independent)',
    async fn({ root, testUrl }) {
      // invoice sender unset: the invoice endpoint refuses, the receipt still works
      await withApi({ root, testUrl, env: { RESEND_FROM_INVOICE: '' }, seed: STAFF, fixture: clinicFixture }, async (api) => {
        const token = api.tokenFor(api.users.nurse);
        const r = await api.invoice({ invoiceId: api.fx.invoice, recipientEmail: RECIPIENT }, token);
        assertJson500(r, { success: false, error: 'Mail sender not configured' }, 'invoice sender unset');
        if (api.stub.requests.length !== 0) throw new Error('the invoice endpoint contacted the provider with no sender');
        const ok = await api.receipt({ paymentId: api.fx.payment, recipientEmail: RECIPIENT }, token);
        if (ok.status !== 200) throw new Error(`the receipt must be unaffected: ${ok.status}: ${ok.text}`);
        if (api.stub.requests.length !== 1) throw new Error('the receipt did not send either');
      });
      // receipt sender unset: the receipt endpoint refuses and sends nothing
      await withApi({ root, testUrl, env: { RESEND_FROM_RECEIPT: '' }, seed: STAFF, fixture: clinicFixture }, async (api) => {
        const token = api.tokenFor(api.users.nurse);
        const r = await api.receipt({ paymentId: api.fx.payment, recipientEmail: RECIPIENT }, token);
        assertJson500(r, { success: false, error: 'Mail sender not configured' }, 'receipt sender unset');
        if (api.stub.requests.length !== 0) throw new Error('the receipt endpoint contacted the provider with no sender');
      });
    },
  },
  {
    name: 'a provider failure is reported with the legacy error JSON on both endpoints',
    async fn({ root, testUrl }) {
      await withApi({ root, testUrl, seed: STAFF, fixture: clinicFixture }, async (api) => {
        api.stub.setResponder(() => ({ status: 422, body: { message: 'no valid verified domain' } }));
        const token = api.tokenFor(api.users.nurse);

        const inv = await api.invoice({ invoiceId: api.fx.invoice, recipientEmail: RECIPIENT }, token);
        assertJson500(inv, { success: false, error: 'Failed to send email: no valid verified domain' }, 'invoice provider failure');

        const rec = await api.receipt({ paymentId: api.fx.payment, recipientEmail: RECIPIENT }, token);
        assertJson500(rec, { success: false, error: 'Failed to send email: no valid verified domain' }, 'receipt provider failure');

        if (api.stub.requests.length !== 2) throw new Error(`expected 2 attempts, saw ${api.stub.requests.length}`);
      });
    },
  },
];
