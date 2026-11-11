// tests/schema/outbox.test.mjs — public.hh_outbox and the row triggers that
// replace the hosted change feed (task t2, 0007_outbox.sql).
//
// The eight fed tables are exactly the ones the realtime route allow-lists:
// appointments, services, invoices, payments, clinic_settings, patients,
// visit_notes and user_roles.

const FED = [
  'appointments',
  'services',
  'invoices',
  'payments',
  'clinic_settings',
  'patients',
  'visit_notes',
  'user_roles',
];

const countOutbox = async (client, table, action) =>
  (
    await client.query('select count(*)::int n from public.hh_outbox where table_name = $1 and action = $2', [
      table,
      action,
    ])
  ).rows[0].n;

const lastFor = async (client, table) =>
  (
    await client.query(
      'select * from public.hh_outbox where table_name = $1 order by id desc limit 1',
      [table]
    )
  ).rows[0];

async function newPatient(client, tag) {
  return (
    await client.query('insert into public.patients (first_name, last_name) values ($1, $2) returning id', [
      tag,
      'Outbox',
    ])
  ).rows[0].id;
}

const newInvoice = async (client) =>
  (await client.query('insert into public.invoices (tax_enabled, tax_rate) values (false, 0) returning id')).rows[0]
    .id;

// one statement per fed table, in dependency order; returns the row id used
async function insertInto(client, table) {
  switch (table) {
    case 'patients':
      return newPatient(client, 'P');
    case 'appointments': {
      const pid = await newPatient(client, 'A');
      return (
        await client.query('insert into public.appointments (patient_id, scheduled_start) values ($1, now()) returning id', [
          pid,
        ])
      ).rows[0].id;
    }
    case 'visit_notes': {
      const pid = await newPatient(client, 'V');
      const appt = (
        await client.query('insert into public.appointments (patient_id, scheduled_start) values ($1, now()) returning id', [
          pid,
        ])
      ).rows[0].id;
      return (
        await client.query('insert into public.visit_notes (appointment_id, notes) values ($1, $2) returning id', [
          appt,
          'note',
        ])
      ).rows[0].id;
    }
    case 'services':
      return (
        await client.query("insert into public.services (code, name) values ('OUTBOX_SVC','Outbox service') returning id")
      ).rows[0].id;
    case 'invoices':
      return newInvoice(client);
    case 'payments': {
      const inv = await newInvoice(client);
      return (
        await client.query('insert into public.payments (invoice_id, amount) values ($1, 5.00) returning id', [inv])
      ).rows[0].id;
    }
    case 'clinic_settings': {
      // the singleton row is seeded by the migrations, so the insert has to
      // follow a delete inside this transaction
      await client.query('delete from public.clinic_settings');
      return (
        await client.query(
          "insert into public.clinic_settings (singleton, currency_code, tax_rate) values (true, 'USD', 0) returning id"
        )
      ).rows[0].id;
    }
    case 'user_roles': {
      const uid = (
        await client.query(
          "insert into public.app_users (email, password_hash) values ('outbox@example.test','h') returning id"
        )
      ).rows[0].id;
      return (
        await client.query("insert into public.user_roles (user_id, role) values ($1, 'user') returning id", [uid])
      ).rows[0].id;
    }
    default:
      throw new Error(`no insert for ${table}`);
  }
}

export default [
  {
    name: 'hh_outbox has the queue columns and an identity id',
    async fn({ client, expectError }) {
      const cols = (
        await client.query(
          `select column_name, data_type, is_nullable
           from information_schema.columns
           where table_schema = 'public' and table_name = 'hh_outbox'`
        )
      ).rows;
      const by = Object.fromEntries(cols.map((c) => [c.column_name, c]));
      const want = {
        id: ['bigint', 'NO'],
        table_name: ['text', 'NO'],
        action: ['text', 'NO'],
        record_id: ['uuid', 'YES'],
        payload: ['jsonb', 'YES'],
        created_at: ['timestamp with time zone', 'NO'],
      };
      for (const [name, [type, nullable]] of Object.entries(want)) {
        const c = by[name];
        if (!c) throw new Error(`hh_outbox.${name} missing (${Object.keys(by).join(', ')})`);
        if (c.data_type !== type) throw new Error(`hh_outbox.${name} is ${c.data_type}, expected ${type}`);
        if (c.is_nullable !== nullable)
          throw new Error(`hh_outbox.${name} nullability is ${c.is_nullable}, expected ${nullable}`);
      }
      // GENERATED ALWAYS AS IDENTITY (pg_attribute.attidentity = 'a')
      const ident = await client.query(`
        select a.attidentity from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        where c.relname = 'hh_outbox' and a.attname = 'id'
      `);
      if (ident.rows[0].attidentity !== 'a')
        throw new Error(`hh_outbox.id attidentity is "${ident.rows[0].attidentity}", expected "a"`);
      // ids belong to the queue, not to the caller
      await expectError(
        () =>
          client.query(
            "insert into public.hh_outbox (id, table_name, action) values (1, 'patients', 'INSERT')"
          ),
        '428C9'
      );
      await expectError(
        () => client.query("insert into public.hh_outbox (table_name, action) values ('patients','TRUNCATE')"),
        '23514'
      );
    },
  },
  {
    name: 'one insert into each fed table queues exactly one INSERT row',
    async fn({ client }) {
      for (const table of FED) {
        const before = await countOutbox(client, table, 'INSERT');
        const id = await insertInto(client, table);
        const after = await countOutbox(client, table, 'INSERT');
        if (after - before !== 1)
          throw new Error(`${table}: insert queued ${after - before} rows, expected 1`);
        const row = await lastFor(client, table);
        if (row.record_id !== id)
          throw new Error(`${table}: record_id is ${row.record_id}, expected ${id}`);
        if ((row.payload ?? {}).id !== id)
          throw new Error(`${table}: payload.id is ${(row.payload ?? {}).id}`);
      }
    },
  },
  {
    name: 'one user_roles insert and one delete add exactly one queue row each',
    async fn({ client }) {
      const total = async () =>
        (await client.query('select count(*)::int n from public.hh_outbox')).rows[0].n;
      const before = await total();
      // the user the role row must point at is not a realtime table, so it is free
      const uid = (
        await client.query("insert into public.app_users (email, password_hash) values ('w8@example.test','h') returning id")
      ).rows[0].id;
      if ((await total()) !== before) throw new Error('inserting an app_users row queued a change');
      const roleId = (
        await client.query("insert into public.user_roles (user_id, role) values ($1, 'user') returning id", [uid])
      ).rows[0].id;
      let after = await total();
      if (after !== before + 1)
        throw new Error(`the user_roles insert added ${after - before} queue rows, expected exactly 1`);
      let row = (
        await client.query("select * from public.hh_outbox where table_name = 'user_roles' order by id desc limit 1")
      ).rows[0];
      if (row.action !== 'INSERT' || row.record_id !== roleId)
        throw new Error(`the queued row is ${row.action}/${row.record_id}`);

      await client.query('delete from public.user_roles where id = $1', [roleId]);
      after = await total();
      if (after !== before + 2)
        throw new Error(`deleting it added ${after - before - 1} queue rows, expected exactly 1`);
      row = (
        await client.query("select * from public.hh_outbox where table_name = 'user_roles' order by id desc limit 1")
      ).rows[0];
      if (row.action !== 'DELETE' || row.record_id !== roleId)
        throw new Error(`the second queued row is ${row.action}/${row.record_id}`);
    },
  },
  {
    name: 'an update queues one UPDATE row and a delete queues one DELETE row',
    async fn({ client }) {
      // user_roles is the table AdminSettings subscribes to, per the plan
      const uid = (
        await client.query(
          "insert into public.app_users (email, password_hash) values ('upd@example.test','h') returning id"
        )
      ).rows[0].id;
      let n = await countOutbox(client, 'user_roles', 'INSERT');
      const roleId = (
        await client.query("insert into public.user_roles (user_id, role) values ($1, 'user') returning id", [uid])
      ).rows[0].id;
      if ((await countOutbox(client, 'user_roles', 'INSERT')) - n !== 1)
        throw new Error('user_roles insert did not queue exactly one row');
      if (await countOutbox(client, 'user_roles', 'UPDATE'))
        throw new Error('user_roles update queued before any update happened');

      n = await countOutbox(client, 'user_roles', 'UPDATE');
      await client.query('update public.user_roles set role = $2 where id = $1', [roleId, 'moderator']);
      if ((await countOutbox(client, 'user_roles', 'UPDATE')) - n !== 1)
        throw new Error('user_roles update did not queue exactly one row');
      const upd = await lastFor(client, 'user_roles');
      if (upd.action !== 'UPDATE' || upd.record_id !== roleId)
        throw new Error(`update row is ${upd.action}/${upd.record_id}`);
      if (upd.payload.role !== 'moderator') throw new Error(`payload role is ${upd.payload.role}`);

      n = await countOutbox(client, 'user_roles', 'DELETE');
      await client.query('delete from public.user_roles where id = $1', [roleId]);
      if ((await countOutbox(client, 'user_roles', 'DELETE')) - n !== 1)
        throw new Error('deleting the user_roles row did not queue exactly one DELETE row');
      const del = await lastFor(client, 'user_roles');
      if (del.record_id !== roleId) throw new Error(`delete row is for ${del.record_id}`);
      if (del.payload.role !== 'moderator')
        throw new Error(`delete payload shows role ${del.payload.role}, expected the old row`);

      // and the same for a core table
      const pid = await newPatient(client, 'D');
      n = await countOutbox(client, 'patients', 'DELETE');
      await client.query('delete from public.patients where id = $1', [pid]);
      if ((await countOutbox(client, 'patients', 'DELETE')) - n !== 1)
        throw new Error('deleting a patient did not queue exactly one DELETE row');
    },
  },
  {
    name: 'every fed table queues on update and on delete as well',
    async fn({ client }) {
      for (const table of FED) {
        const id = await insertInto(client, table);
        const before =
          (await countOutbox(client, table, 'UPDATE')) + (await countOutbox(client, table, 'DELETE'));
        // touch a column that exists on every fed table without changing values
        // that other triggers react to
        await client.query(`update public.${table} set created_at = created_at where id = $1`, [id]);
        let after =
          (await countOutbox(client, table, 'UPDATE')) + (await countOutbox(client, table, 'DELETE'));
        if (after - before !== 1)
          throw new Error(`${table}: update queued ${after - before} rows, expected 1`);

        await client.query(`delete from public.${table} where id = $1`, [id]);
        after = (await countOutbox(client, table, 'UPDATE')) + (await countOutbox(client, table, 'DELETE'));
        if (after - before !== 2)
          throw new Error(`${table}: delete queued ${after - before - 1} rows, expected 1`);
      }
    },
  },
  {
    name: 'queue ids increase in the order the changes happened',
    async fn({ client }) {
      const first = await newPatient(client, 'O1');
      const second = await newPatient(client, 'O2');
      const rows = await client.query(
        "select id, record_id from public.hh_outbox where table_name = 'patients' and action = 'INSERT' order by id"
      );
      const mine = rows.rows.filter((r) => [first, second].includes(r.record_id));
      if (mine.length !== 2) throw new Error(`expected 2 patient rows, got ${mine.length}`);
      if (!(Number(mine[0].id) < Number(mine[1].id)))
        throw new Error(`ids are not increasing: ${mine.map((r) => r.id).join(', ')}`);
      if (mine[0].record_id !== first) throw new Error('the first queued row is not the first patient');
    },
  },
  {
    name: 'tables the realtime allow-list excludes are not queued',
    async fn({ client }) {
      const before = (await client.query('select count(*)::int n from public.hh_outbox')).rows[0].n;
      const uid = (
        await client.query("insert into public.app_users (email, password_hash) values ('quiet@example.test','h') returning id")
      ).rows[0].id;
      const inv = await newInvoice(client);
      await client.query(
        "insert into public.invoice_items (invoice_id, description, quantity, unit_price) values ($1, 'i', 1, 10)",
        [inv]
      );
      await client.query("insert into public.storage_objects (bucket, name) values ('exports','quiet.csv')");
      const after = await client.query(
        'select table_name, count(*)::int n from public.hh_outbox group by table_name'
      );
      const names = after.rows.map((r) => r.table_name).sort();
      for (const bad of ['app_users', 'invoice_items', 'storage_objects', 'storage_buckets', 'hh_outbox']) {
        if (names.includes(bad)) throw new Error(`${bad} is queued but is not a realtime table`);
      }
      // the invoice row is queued twice: once by the insert, once when the item
      // recalculates its totals — but an item itself never is
      const total = after.rows.reduce((n, r) => n + r.n, 0);
      if (total <= before) throw new Error('nothing was queued at all');
      if (!uid) throw new Error('unreachable');
    },
  },
];
