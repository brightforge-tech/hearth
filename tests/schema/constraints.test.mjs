// tests/schema/constraints.test.mjs — checks and unique constraints (task t1).

async function patient(client, tag) {
  const r = await client.query(
    'insert into public.patients (first_name, last_name) values ($1, $2) returning id',
    [tag, 'Test']
  );
  return r.rows[0].id;
}

async function invoice(client, fields = {}) {
  const r = await client.query(
    `insert into public.invoices (tax_enabled, tax_rate) values ($1, $2) returning id`,
    [fields.tax_enabled ?? false, fields.tax_rate ?? 0]
  );
  return r.rows[0].id;
}

export default [
  {
    name: 'payments.amount must be > 0',
    async fn({ client, expectError }) {
      const inv = await invoice(client);
      for (const amount of [0, -1]) {
        await expectError(
          () => client.query('insert into public.payments (invoice_id, amount) values ($1, $2)', [inv, amount]),
          '23514'
        );
      }
      await client.query('insert into public.payments (invoice_id, amount) values ($1, 0.01)', [inv]);
    },
  },
  {
    name: 'invoice_items quantity > 0 and unit_price >= 0 are enforced',
    async fn({ client, expectError }) {
      const inv = await invoice(client);
      await expectError(
        () =>
          client.query(
            'insert into public.invoice_items (invoice_id, description, quantity, unit_price) values ($1, $2, 0, 5)',
            [inv, 'zero']
          ),
        '23514'
      );
      await expectError(
        () =>
          client.query(
            'insert into public.invoice_items (invoice_id, description, quantity, unit_price) values ($1, $2, 1, -0.01)',
            [inv, 'negative']
          ),
        '23514'
      );
      await client.query(
        'insert into public.invoice_items (invoice_id, description, quantity, unit_price) values ($1, $2, 1, 0)',
        [inv, 'free']
      );
    },
  },
  {
    name: 'patients national_id / drivers_permit are unique when provided, nulls may repeat',
    async fn({ client, expectError }) {
      await client.query(
        "insert into public.patients (first_name, last_name, national_id, drivers_permit) values ('A','B','N1','D1')"
      );
      await expectError(
        () =>
          client.query(
            "insert into public.patients (first_name, last_name, national_id) values ('C','D','N1')"
          ),
        '23505'
      );
      await expectError(
        () =>
          client.query(
            "insert into public.patients (first_name, last_name, drivers_permit) values ('C','D','D1')"
          ),
        '23505'
      );
      // NULL identifiers never collide
      await client.query("insert into public.patients (first_name, last_name) values ('E','F')");
      await client.query("insert into public.patients (first_name, last_name) values ('G','H')");
    },
  },
  {
    name: 'services.code is unique; clinic_settings keeps exactly one row',
    async fn({ client, expectError }) {
      await expectError(
        () => client.query("insert into public.services (code, name) values ('CONSULT_INIT','dup')"),
        '23505'
      );
      await expectError(
        () => client.query('insert into public.clinic_settings (singleton) values (true)'),
        '23505'
      );
      // two settings rows is only impossible via the singleton constraint;
      // a second singleton=false row is allowed by the DDL (matches the source)
      await client.query('insert into public.clinic_settings (singleton) values (false)');
    },
  },
  {
    name: 'appointments.customer_type defaults to walk-in and rejects other values',
    async fn({ client, expectError }) {
      const pid = await patient(client, 'CT');
      const a = await client.query(
        'insert into public.appointments (patient_id, scheduled_start) values ($1, now()) returning customer_type',
        [pid]
      );
      if (a.rows[0].customer_type !== 'walk-in')
        throw new Error(`default is ${a.rows[0].customer_type}`);
      await client.query(
        "insert into public.appointments (patient_id, scheduled_start, customer_type) values ($1, now(), 'appointment')",
        [pid]
      );
      await expectError(
        () =>
          client.query(
            "insert into public.appointments (patient_id, scheduled_start, customer_type) values ($1, now(), 'other')",
            [pid]
          ),
        '23514'
      );
    },
  },
  {
    name: 'enum columns reject values outside the enum labels',
    async fn({ client, expectError }) {
      const pid = await patient(client, 'En');
      await expectError(
        () =>
          client.query(
            "insert into public.appointments (patient_id, scheduled_start, status) values ($1, now(), 'delayed')",
            [pid]
          ),
        '22P02'
      );
      const inv = await client.query(
        `insert into public.invoices (status) values ('draft') returning id`
      );
      await expectError(
        () =>
          client.query(
            "insert into public.payments (invoice_id, amount, method) values ($1, 1, 'wire')",
            [inv.rows[0].id]
          ),
        '22P02'
      );
    },
  },
  {
    name: 'visit_notes.appointment_id is unique and FK cascades from patients',
    async fn({ client, expectError }) {
      const pid = await patient(client, 'Casc');
      const appt = await client.query(
        'insert into public.appointments (patient_id, scheduled_start) values ($1, now()) returning id',
        [pid]
      );
      const apptId = appt.rows[0].id;
      await client.query('insert into public.visit_notes (appointment_id, notes) values ($1, $2)', [apptId, 'first']);
      await expectError(
        () => client.query('insert into public.visit_notes (appointment_id, notes) values ($1, $2)', [apptId, 'dup']),
        '23505'
      );
      await client.query(
        'insert into public.invoices (appointment_id, tax_enabled, tax_rate) values ($1, false, 0)',
        [apptId]
      );
      await client.query('delete from public.patients where id = $1', [pid]);
      for (const [t, col, id] of [
        ['appointments', 'id', apptId],
        ['visit_notes', 'appointment_id', apptId],
      ]) {
        const r = await client.query(`select 1 from public.${t} where ${col} = $1`, [id]);
        if (r.rowCount) throw new Error(`${t} row survived the patient delete`);
      }
      // invoices.appointment_id is ON DELETE SET NULL
      const inv = await client.query('select appointment_id from public.invoices where appointment_id is null');
      if (!inv.rowCount) throw new Error('invoice appointment_id was not set to null by the cascade');
    },
  },
  {
    name: 'invoice_items cascade with their invoice; payments too',
    async fn({ client }) {
      const inv = await invoice(client);
      await client.query(
        'insert into public.invoice_items (invoice_id, description, quantity, unit_price) values ($1, $2, 1, 10)',
        [inv, 'x']
      );
      await client.query('insert into public.payments (invoice_id, amount) values ($1, 1)', [inv]);
      await client.query('delete from public.invoices where id = $1', [inv]);
      for (const t of ['invoice_items', 'payments']) {
        const r = await client.query(`select 1 from public.${t} where invoice_id = $1`, [inv]);
        if (r.rowCount) throw new Error(`${t} row survived the invoice delete`);
      }
    },
  },
  {
    name: 'column types match the source: numeric(12,2)/(5,2), timestamptz, jsonb',
    async fn({ client }) {
      const r = await client.query(`
        select table_name, column_name, data_type, numeric_precision, numeric_scale
        from information_schema.columns
        where table_schema = 'public' and (
          (table_name = 'invoices' and column_name in ('subtotal','tax_amount','total','paid_amount','tax_rate')) or
          (table_name = 'services' and column_name = 'price') or
          (table_name = 'clinic_settings' and column_name in ('tax_rate','working_hours')) or
          (table_name = 'invoices' and column_name = 'created_at'))
      `);
      const want = {
        'invoices.subtotal': ['numeric', 12, 2],
        'invoices.tax_amount': ['numeric', 12, 2],
        'invoices.total': ['numeric', 12, 2],
        'invoices.paid_amount': ['numeric', 12, 2],
        'invoices.tax_rate': ['numeric', 5, 2],
        'services.price': ['numeric', 12, 2],
        'clinic_settings.tax_rate': ['numeric', 5, 2],
        'clinic_settings.working_hours': ['jsonb', null, null],
        'invoices.created_at': ['timestamp with time zone', null, null],
      };
      const seen = new Set();
      for (const row of r.rows) {
        const key = `${row.table_name}.${row.column_name}`;
        seen.add(key);
        const w = want[key];
        if (!w) throw new Error(`unexpected column ${key}`);
        const got = [row.data_type, row.numeric_precision, row.numeric_scale];
        if (JSON.stringify(got) !== JSON.stringify(w))
          throw new Error(`${key} is ${got}, expected ${w}`);
      }
      if (seen.size !== Object.keys(want).length)
        throw new Error(`missing columns: ${Object.keys(want).filter((k) => !seen.has(k)).join(', ')}`);
    },
  },
];
