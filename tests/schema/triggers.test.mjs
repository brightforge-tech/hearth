// tests/schema/triggers.test.mjs — the ported trigger behaviour (task t1).
// Every case runs inside a transaction the runner rolls back afterwards, so
// clinic_settings mutations here do not leak into other cases.

async function newPatient(client, tag) {
  const r = await client.query(
    'insert into public.patients (first_name, last_name) values ($1, $2) returning id',
    [tag, 'Test']
  );
  return r.rows[0].id;
}

async function invoiceWith({ client }, fields = {}) {
  const r = await client.query(
    `insert into public.invoices (appointment_id, currency_code, tax_enabled, tax_rate)
     values ($1, $2, $3, $4) returning *`,
    [fields.appointment_id ?? null, fields.currency_code ?? null,
     fields.tax_enabled ?? null, fields.tax_rate ?? null]
  );
  return r.rows[0];
}

async function addItem(client, invoiceId, { quantity = 1, unit_price, taxable = true, description = 'item' }) {
  const r = await client.query(
    `insert into public.invoice_items (invoice_id, description, quantity, unit_price, taxable)
     values ($1, $2, $3, $4, $5) returning *`,
    [invoiceId, description, quantity, unit_price, taxable]
  );
  return r.rows[0];
}

const invoice = async (client, id) =>
  (await client.query('select * from public.invoices where id = $1', [id])).rows[0];

export default [
  {
    name: 'invoice totals recalc from items: 2x10.00 taxable + 1x5.00 non-taxable at 10% = 25.00 / 2.00 / 27.00',
    async fn(ctx) {
      const { client } = ctx;
      const inv = await invoiceWith(ctx, { tax_enabled: true, tax_rate: 10.0 });
      const a = await addItem(client, inv.id, { quantity: 2, unit_price: 10.0, taxable: true });
      await addItem(client, inv.id, { quantity: 1, unit_price: 5.0, taxable: false });
      if (a.line_total !== '20.00') throw new Error(`line_total is ${a.line_total}, expected 20.00`);
      const after = await invoice(client, inv.id);
      const want = { subtotal: '25.00', tax_amount: '2.00', total: '27.00' };
      for (const [col, v] of Object.entries(want)) {
        if (after[col] !== v) throw new Error(`${col} is ${after[col]}, expected ${v}`);
      }
    },
  },
  {
    name: 'invoice totals recalc on item update and on item delete',
    async fn(ctx) {
      const { client } = ctx;
      const inv = await invoiceWith(ctx, { tax_enabled: false, tax_rate: 0 });
      const it = await addItem(client, inv.id, { quantity: 1, unit_price: 12.5 });
      let after = await invoice(client, inv.id);
      if (after.total !== '12.50') throw new Error(`total after insert is ${after.total}`);
      await client.query('update public.invoice_items set quantity = 3 where id = $1', [it.id]);
      after = await invoice(client, inv.id);
      if (after.total !== '37.50') throw new Error(`total after update is ${after.total}`);
      await client.query('delete from public.invoice_items where id = $1', [it.id]);
      after = await invoice(client, inv.id);
      if (after.total !== '0.00' || after.subtotal !== '0.00')
        throw new Error(`total after delete is ${after.total}/${after.subtotal}`);
    },
  },
  {
    name: 'a 27.00 payment sets paid_amount 27.00 and status paid; deleting it returns 0.00 / issued',
    async fn(ctx) {
      const { client } = ctx;
      const inv = await invoiceWith(ctx, { tax_enabled: true, tax_rate: 10.0 });
      await addItem(client, inv.id, { quantity: 2, unit_price: 10.0, taxable: true });
      await addItem(client, inv.id, { quantity: 1, unit_price: 5.0, taxable: false });
      const pay = await client.query(
        `insert into public.payments (invoice_id, amount, method)
         values ($1, 27.00, 'cash') returning id`,
        [inv.id]
      );
      let after = await invoice(client, inv.id);
      if (after.paid_amount !== '27.00' || after.status !== 'paid')
        throw new Error(`after payment: paid_amount=${after.paid_amount} status=${after.status}`);
      await client.query('delete from public.payments where id = $1', [pay.rows[0].id]);
      after = await invoice(client, inv.id);
      if (after.paid_amount !== '0.00' || after.status !== 'issued')
        throw new Error(`after delete: paid_amount=${after.paid_amount} status=${after.status}`);
    },
  },
  {
    name: 'an invoice update keeps a status that is neither fully paid nor paid->issued',
    async fn(ctx) {
      const { client } = ctx;
      const inv = await invoiceWith(ctx, { tax_enabled: false, tax_rate: 0 });
      await addItem(client, inv.id, { quantity: 1, unit_price: 100 });
      await client.query(
        "insert into public.payments (invoice_id, amount) values ($1, 100)", [inv.id]
      );
      let after = await invoice(client, inv.id);
      if (after.status !== 'paid') throw new Error(`expected paid, got ${after.status}`);
      // partial refund of 40 leaves 60 of 100 -> the paid->issued branch
      await client.query('update public.payments set amount = 60 where invoice_id = $1', [inv.id]);
      after = await invoice(client, inv.id);
      if (after.paid_amount !== '60.00' || after.status !== 'issued')
        throw new Error(`after partial: paid_amount=${after.paid_amount} status=${after.status}`);
    },
  },
  {
    name: 'an appointment with null duration/end inherits them from clinic_settings',
    async fn({ client }) {
      const pid = await newPatient(client, 'Appt');
      const r = await client.query(
        `insert into public.appointments (patient_id, scheduled_start)
         values ($1, '2026-03-01T14:00:00Z') returning *`,
        [pid]
      );
      const a = r.rows[0];
      if (a.duration_minutes !== 30) throw new Error(`duration_minutes is ${a.duration_minutes}`);
      const end = new Date(a.scheduled_end).getTime();
      if (end !== Date.parse('2026-03-01T14:30:00Z'))
        throw new Error(`scheduled_end is ${a.scheduled_end}, expected 14:30Z`);
    },
  },
  {
    name: 'appointment duration follows a changed clinic_settings value (45)',
    async fn({ client }) {
      await client.query('update public.clinic_settings set default_appointment_duration_minutes = 45');
      const pid = await newPatient(client, 'Appt45');
      const r = await client.query(
        `insert into public.appointments (patient_id, scheduled_start)
         values ($1, '2026-03-02T09:00:00Z') returning duration_minutes, scheduled_end`,
        [pid]
      );
      const a = r.rows[0];
      if (a.duration_minutes !== 45) throw new Error(`duration_minutes is ${a.duration_minutes}`);
      if (new Date(a.scheduled_end).getTime() !== Date.parse('2026-03-02T09:45:00Z'))
        throw new Error(`scheduled_end is ${a.scheduled_end}, expected 09:45Z`);
    },
  },
  {
    name: 'an invoice with null currency/tax columns inherits them from clinic_settings',
    async fn({ client }) {
      await client.query(
        "update public.clinic_settings set currency_code = 'USD', tax_enabled = true, tax_rate = 8.25"
      );
      const inv = await invoiceWith({ client });
      if (inv.currency_code !== 'USD') throw new Error(`currency_code is ${inv.currency_code}`);
      if (inv.tax_enabled !== true) throw new Error(`tax_enabled is ${inv.tax_enabled}`);
      if (inv.tax_rate !== '8.25') throw new Error(`tax_rate is ${inv.tax_rate}, expected 8.25`);
      // explicit values still win over the settings
      const kept = await invoiceWith({ client }, { currency_code: 'EUR', tax_enabled: false, tax_rate: 0 });
      if (kept.currency_code !== 'EUR' || kept.tax_enabled !== false || kept.tax_rate !== '0.00')
        throw new Error(`explicit values lost: ${JSON.stringify(kept)}`);
    },
  },
  {
    name: 'update_updated_at_column refreshes updated_at on every core table',
    async fn({ client }) {
      const tables = {
        clinic_settings: 'id',
        patients: `id`,
        services: 'id',
        invoices: 'id',
        invoice_items: 'id',
        payments: 'id',
        visit_notes: 'id',
        appointments: 'id',
      };
      // one row for appointments + visit_notes to drive their triggers
      const pid = await newPatient(client, 'Ts');
      const appt = await client.query(
        `insert into public.appointments (patient_id, scheduled_start)
         values ($1, '2026-04-01T10:00:00Z') returning id`, [pid]
      );
      const apptId = appt.rows[0].id;
      const vn = await client.query(
        'insert into public.visit_notes (appointment_id, notes) values ($1, $2) returning id',
        [apptId, 'note']
      );
      const inv = await invoiceWith({ client }, { tax_enabled: false, tax_rate: 0 });
      const item = await addItem(client, inv.id, { unit_price: 1 });
      const pay = await client.query(
        'insert into public.payments (invoice_id, amount) values ($1, 1) returning id', [inv.id]
      );
      const rows = {
        clinic_settings: (await client.query('select id from public.clinic_settings')).rows[0].id,
        patients: pid,
        services: (await client.query('select id from public.services limit 1')).rows[0].id,
        invoices: inv.id,
        invoice_items: item.id,
        payments: pay.rows[0].id,
        visit_notes: vn.rows[0].id,
        appointments: apptId,
      };
      for (const [t, col] of Object.entries(tables)) {
        // A BEFORE UPDATE trigger must overwrite any attempt to write an old
        // updated_at, so the column can never be moved back to 2000.
        await client.query(`update public.${t} set updated_at = '2000-01-01T00:00:00Z' where ${col} = $1`, [rows[t]]);
        const u = await client.query(`select updated_at from public.${t} where ${col} = $1`, [rows[t]]);
        const got = new Date(u.rows[0].updated_at).getTime();
        if (!(got > Date.parse('2000-01-01T00:00:00Z')))
          throw new Error(`${t}.updated_at was not refreshed (${u.rows[0].updated_at})`);
      }
    },
  },
  {
    name: 'recalc functions can be called directly and are no-ops for unknown invoices',
    async fn(ctx) {
      const { client, expectError } = ctx;
      const inv = await invoiceWith(ctx, { tax_enabled: false, tax_rate: 0 });
      await addItem(client, inv.id, { unit_price: 4 });
      await client.query('update public.invoices set subtotal = 0, tax_amount = 0, total = 0 where id = $1', [inv.id]);
      await client.query('select public.recalc_invoice_totals($1)', [inv.id]);
      const after = await invoice(client, inv.id);
      if (after.total !== '4.00') throw new Error(`direct recalc_invoice_totals gave total ${after.total}`);
      await client.query('select public.recalc_invoice_payments($1)', ['00000000-0000-0000-0000-000000000000']);
    },
  },
];
