// tests/schema/migrations.test.mjs — structure of the ported schema (task t1).
const TABLES = [
  'clinic_settings',
  'patients',
  'appointments',
  'visit_notes',
  'services',
  'invoices',
  'invoice_items',
  'payments',
];

const ENUMS = {
  appointment_status: ['scheduled', 'waiting', 'in_progress', 'completed', 'canceled', 'no_show'],
  invoice_status: ['draft', 'issued', 'paid', 'void'],
  payment_method: ['cash', 'card', 'transfer', 'other'],
  app_role: ['admin', 'moderator', 'user'],
};

export default [
  {
    name: 'the eight core tables exist after migration',
    async fn({ client }) {
      const r = await client.query(
        `select table_name from information_schema.tables
         where table_schema = 'public' and table_name = any($1)`,
        [TABLES]
      );
      const got = r.rows.map((x) => x.table_name).sort();
      for (const t of [...TABLES].sort()) {
        if (!got.includes(t)) throw new Error(`missing table ${t}; found ${got.join(', ')}`);
      }
    },
  },
  {
    name: 'the four enums exist with exactly the supabase values',
    async fn({ client }) {
      const r = await client.query(
        `select t.typname, e.enumlabel
         from pg_type t join pg_enum e on e.enumtypid = t.oid
         where t.typname = any($1)
         order by t.typname, e.enumsortorder`,
        [Object.keys(ENUMS)]
      );
      const got = {};
      for (const row of r.rows) (got[row.typname] ??= []).push(row.enumlabel);
      for (const [name, labels] of Object.entries(ENUMS)) {
        const g = got[name];
        if (!g) throw new Error(`enum ${name} missing`);
        if (g.join(',') !== labels.join(','))
          throw new Error(`enum ${name} is ${g.join(',')}, expected ${labels.join(',')}`);
      }
    },
  },
  {
    name: 'db/migrations contains no auth./storage./pgcrypto/realtime reference',
    async fn({ client, root }) {
      const { readdirSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const forbidden = /auth\.users|auth\.uid\(\)|storage\.buckets|storage\.objects|pgcrypto|supabase_realtime/;
      const hits = [];
      for (const f of readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql'))) {
        const sql = readFileSync(join(root, 'db', 'migrations', f), 'utf8');
        sql.split(/\r?\n/).forEach((line, i) => {
          if (forbidden.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
        });
      }
      if (hits.length) throw new Error('forbidden references:\n' + hits.join('\n'));
    },
  },
  {
    name: 'gen_random_uuid works without pgcrypto',
    async fn({ client }) {
      const r = await client.query('select gen_random_uuid() as id');
      if (!/^[0-9a-f-]{36}$/.test(r.rows[0].id)) throw new Error('gen_random_uuid failed');
    },
  },
  {
    name: 'every migration file can be replayed (idempotent)',
    async fn({ client, root }) {
      const { readdirSync, readFileSync } = await import('node:fs');
      const { join } = await import('node:path');
      const files = readdirSync(join(root, 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        await client.query(readFileSync(join(root, 'db', 'migrations', f), 'utf8'));
      }
      const cs = await client.query('select count(*)::int n from public.clinic_settings');
      const sv = await client.query('select count(*)::int n from public.services');
      if (cs.rows[0].n !== 1) throw new Error(`clinic_settings has ${cs.rows[0].n} rows after replay, expected 1`);
      if (sv.rows[0].n !== 5) throw new Error(`services has ${sv.rows[0].n} rows after replay, expected 5`);
    },
  },
  {
    name: 'the clinic_settings seed matches the supabase default row',
    async fn({ client }) {
      const r = await client.query('select * from public.clinic_settings');
      if (r.rowCount !== 1) throw new Error(`expected 1 settings row, got ${r.rowCount}`);
      const s = r.rows[0];
      const checks = {
        currency_code: 'USD',
        tax_enabled: false,
        tax_name: 'VAT',
        default_appointment_duration_minutes: 30,
      };
      for (const [col, want] of Object.entries(checks)) {
        if (s[col] !== want) throw new Error(`${col} is ${JSON.stringify(s[col])}, expected ${want}`);
      }
      if (Number(s.tax_rate) !== 0) throw new Error(`tax_rate is ${s.tax_rate}`);
      // jsonb working_hours default must survive exactly (seed did not pass it);
      // jsonb reorders keys, so compare canonically sorted JSON.
      const want = {
        mon: { start: '09:00', end: '17:00', enabled: true },
        tue: { start: '09:00', end: '17:00', enabled: true },
        wed: { start: '09:00', end: '17:00', enabled: true },
        thu: { start: '09:00', end: '17:00', enabled: true },
        fri: { start: '09:00', end: '17:00', enabled: true },
        sat: { enabled: false },
        sun: { enabled: false },
      };
      const canon = (v) =>
        v && typeof v === 'object'
          ? JSON.stringify(Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, canon(x)])))
          : JSON.stringify(v);
      if (canon(s.working_hours) !== canon(want)) {
        throw new Error(`working_hours default differs: ${canon(s.working_hours)}`);
      }
    },
  },
  {
    name: 'the five seed services are present, active and shown on landing',
    async fn({ client }) {
      const r = await client.query(
        'select code, name, price, taxable, active, show_on_landing from public.services order by code'
      );
      const want = {
        CONSULT_FU: '150.00',
        CONSULT_INIT: '250.00',
        IMG_XRAY: '350.00',
        LAB_BLOOD: '120.00',
        PROC_INJ: '75.00',
      };
      if (r.rowCount !== 5) throw new Error(`expected 5 services, got ${r.rowCount}`);
      for (const row of r.rows) {
        if (!(row.code in want)) throw new Error(`unexpected service ${row.code}`);
        if (row.price !== want[row.code]) throw new Error(`${row.code} price is ${row.price}`);
        if (!row.taxable || !row.active || !row.show_on_landing)
          throw new Error(`${row.code} flags wrong: ${JSON.stringify(row)}`);
      }
    },
  },
];
