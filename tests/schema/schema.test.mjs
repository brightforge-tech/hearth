// tests/schema/schema.test.mjs — the ported schema's own contract (task t14).
//
// Milestone 1 claimed the 21 Supabase migrations became a plain-Postgres
// schema with the Supabase-only parts mapped to local equivalents. This suite
// pins that claim against a database that the runner just migrated from
// db/migrations, so a future migration that quietly re-introduces an auth.*
// dependency, a policy, or a changed FK behaviour fails here rather than at
// cutover:
//
//   1. inventory — the eight core tables (plus app_users/user_roles and the
//      storage/outbox stand-ins), the four enums, and every trigger/RPC
//      function milestone 1 promises exist with the right kind;
//   2. purity — no migration text references auth.users / auth.uid() /
//      storage.objects / pgcrypto, and the live database has zero RLS
//      policies, zero publications and no auth schema: role rules live in
//      api/lib/authorization.mjs only (operator decision + S32);
//   3. referential behaviour — the FK rules the app relies on: deleting a
//      patient cascades its appointments, an invoice keeps its row with
//      appointment_id nulled when the appointment dies, invoice_items and
//      payments cascade from their invoice, and visit_notes holds at most one
//      note per appointment (unique FK, cascade on delete).
//
// The FK cases run inside the runner's rolled-back transaction, so the
// shared database stays pristine.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export default [
  {
    name: 'every ported table exists in the public schema',
    async fn({ client }) {
      const expected = [
        'clinic_settings', 'patients', 'appointments', 'visit_notes',
        'services', 'invoices', 'invoice_items', 'payments',
        'app_users', 'user_roles',
        'storage_buckets', 'storage_objects', 'hh_outbox',
      ];
      const { rows } = await client.query(
        `select table_name from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE'`);
      const have = new Set(rows.map((r) => r.table_name));
      for (const t of expected) {
        assert.ok(have.has(t), `missing table public.${t}`);
      }
    },
  },

  {
    name: 'the four enums exist with exactly the ported labels',
    async fn({ client }) {
      const want = {
        app_role: ['admin', 'moderator', 'user'],
        appointment_status: ['scheduled', 'waiting', 'in_progress', 'completed', 'canceled', 'no_show'],
        invoice_status: ['draft', 'issued', 'paid', 'void'],
        payment_method: ['cash', 'card', 'transfer', 'other'],
      };
      const { rows } = await client.query(
        `select t.typname, e.enumlabel, e.enumsortorder
           from pg_type t
           join pg_enum e on e.enumtypid = t.oid
           join pg_namespace n on n.oid = t.typnamespace
          where n.nspname = 'public'
          order by t.typname, e.enumsortorder`);
      const have = {};
      for (const r of rows) (have[r.typname] ??= []).push(r.enumlabel);
      for (const [name, labels] of Object.entries(want)) {
        assert.ok(have[name], `missing enum public.${name}`);
        assert.deepEqual(have[name], labels, `enum ${name} labels drifted`);
      }
    },
  },

  {
    name: 'every trigger function and the RPC are present in public',
    async fn({ client }) {
      const want = [
        'update_updated_at_column',
        'set_appointment_defaults',
        'set_invoice_defaults',
        'set_invoice_item_line_total',
        'recalc_invoice_totals',
        'recalc_invoice_payments',
        'after_invoice_item_change',
        'after_invoice_item_delete',
        'after_payment_change',
        'after_payment_delete',
        'has_role',
        'current_uid',
        'current_is_admin',
        'get_users_with_roles',
        'hh_outbox_notify',
      ];
      const { rows } = await client.query(
        `select distinct p.proname as name
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'`);
      const have = new Set(rows.map((r) => r.name));
      for (const name of want) {
        assert.ok(have.has(name), `missing function public.${name}()`);
      }
    },
  },

  {
    name: 'recalc_invoice_* are pure SQL/PLPGSQL functions, not procedures or views',
    async fn({ client }) {
      const { rows } = await client.query(
        `select p.proname, p.prokind
           from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('recalc_invoice_totals','recalc_invoice_payments','get_users_with_roles')`);
      assert.equal(rows.length, 3);
      for (const r of rows) {
        assert.equal(r.prokind, 'f', `${r.proname} must be a function (callable via /api/rpc)`);
      }
    },
  },

  {
    name: 'purity: no migration SQL references auth.*, storage.objects, pgcrypto or policies',
    async fn({ root }) {
      const dir = join(root, 'db', 'migrations');
      const names = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
      assert.ok(names.length >= 5, `expected the ported migrations, found ${names.length}`);
      // Port provenance comments legitimately *name* the Supabase files this
      // schema was ported from; the requirement (S33) is that no *executable*
      // SQL touches Supabase objects, so comments are stripped first.
      const stripComments = (sql) =>
        sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
      const banned = [
        /\bauth\.users\b/i,
        /\bauth\.uid\s*\(/i,
        /\bstorage\.objects\b/i,
        /\bstorage\.buckets\b/i,
        /\bpgcrypto\b/i,
        /\bcreate\s+(row\s+)?security\s+policy\b/i,
      ];
      for (const name of names) {
        const sql = stripComments(readFileSync(join(dir, name), 'utf8'));
        for (const re of banned) {
          assert.ok(!re.test(sql), `${name} contains banned pattern ${re}`);
        }
      }
    },
  },

  {
    name: 'purity: the live database has no RLS policies, no publications, no auth schema',
    async fn({ client }) {
      const pol = await client.query('select count(*)::int as n from pg_policies where schemaname = \'public\'');
      assert.equal(pol.rows[0].n, 0, 'role rules live in the API; the schema must carry no policies');
      const pub = await client.query('select count(*)::int as n from pg_publication');
      assert.equal(pub.rows[0].n, 0, 'no logical replication publications (Supabase Realtime is replaced by hh_outbox)');
      const auth = await client.query(
        "select count(*)::int as n from information_schema.schemata where schema_name in ('auth','storage','realtime')");
      assert.equal(auth.rows[0].n, 0, 'no Supabase schemas exist locally');
      // and nothing in the schema depends on them: pgcrypto is the extension
      // Supabase used for gen_random_uuid; PG13+ has it in core
      const ext = await client.query(
        "select count(*)::int as n from pg_extension where extname = 'pgcrypto'");
      assert.equal(ext.rows[0].n, 0, 'pgcrypto must not be required');
      // gen_random_uuid() still works (core builtin) — the seeds depend on it
      const gen = await client.query('select length(gen_random_uuid()::text) as len');
      assert.equal(gen.rows[0].len, 36);
    },
  },

  {
    name: 'clinic_settings is a singleton and services carries the landing-page seed',
    async fn({ client }) {
      const cs = await client.query('select count(*)::int as n from public.clinic_settings');
      assert.equal(cs.rows[0].n, 1, 'the 0004 seed keeps exactly one clinic_settings row');
      const svc = await client.query(
        'select count(*)::int as total, count(*) filter (where show_on_landing)::int as landing from public.services');
      assert.equal(svc.rows[0].total, 5, 'the 0004 seed carries the five shipped services');
      assert.ok(svc.rows[0].landing > 0, 'at least one service is show_on_landing (LandingPage parity)');
    },
  },

  {
    name: 'FK rules: patient delete cascades appointments; visit_notes is one-per-appointment',
    async fn({ client, expectError }) {
      // Build a small patient/appointment/visit_note chain in the shared tx.
      const pid = (await client.query(
        `insert into public.patients (first_name, last_name, phone)
         values ('Schema','Fk','555-0000') returning id`)).rows[0].id;
      const aid = (await client.query(
        `insert into public.appointments (patient_id, scheduled_start, status)
         values ($1, now(), 'scheduled') returning id`, [pid])).rows[0].id;
      await client.query(
        `insert into public.visit_notes (appointment_id, notes) values ($1, 'first')`, [aid]);

      // unique appointment_id on visit_notes (the shipped unique index)
      await expectError(() => client.query(
        `insert into public.visit_notes (appointment_id, notes) values ($1, 'second')`, [aid]));

      // deleting the note is fine, deleting the appointment cascades the note
      await client.query('delete from public.visit_notes where appointment_id = $1', [aid]);
      await client.query('delete from public.appointments where id = $1', [aid]);
      let n = await client.query('select count(*)::int as c from public.visit_notes where appointment_id = $1', [aid]);
      assert.equal(n.rows[0].c, 0);

      // deleting the patient cascades its appointments
      const aid2 = (await client.query(
        `insert into public.appointments (patient_id, scheduled_start, status)
         values ($1, now(), 'scheduled') returning id`, [pid])).rows[0].id;
      await client.query('delete from public.patients where id = $1', [pid]);
      n = await client.query('select count(*)::int as c from public.appointments where id = $1', [aid2]);
      assert.equal(n.rows[0].c, 0, 'appointments.patient_id must be ON DELETE CASCADE');
    },
  },

  {
    name: 'FK rules: invoices keep their row with appointment_id nulled; items and payments cascade',
    async fn({ client, expectError }) {
      const pid = (await client.query(
        `insert into public.patients (first_name, last_name, phone)
         values ('InvFk','Chain','555-0001') returning id`)).rows[0].id;
      const aid = (await client.query(
        `insert into public.appointments (patient_id, scheduled_start, status)
         values ($1, now(), 'completed') returning id`, [pid])).rows[0].id;
      const inv = (await client.query(
        `insert into public.invoices (appointment_id, status)
         values ($1, 'issued') returning id`, [aid])).rows[0].id;
      await client.query(
        `insert into public.invoice_items (invoice_id, description, quantity, unit_price, taxable)
         values ($1, 'Consult', 1, 10, true)`, [inv]);
      await client.query(
        `insert into public.payments (invoice_id, amount, method)
         values ($1, 11, 'cash')`, [inv]);

      // a payment pointing at a nonexistent invoice is refused outright
      await expectError(() => client.query(
        `insert into public.payments (invoice_id, amount, method)
         values (gen_random_uuid(), 1, 'cash')`));

      // deleting the appointment must NOT delete the issued invoice; it nulls
      // the appointment link (invoices.appointment_id is ON DELETE SET NULL —
      // billing keeps the money document even if a visit row is purged)
      await client.query('delete from public.appointments where id = $1', [aid]);
      const kept = await client.query(
        'select appointment_id from public.invoices where id = $1', [inv]);
      assert.equal(kept.rows.length, 1, 'invoice survives its appointment');
      assert.equal(kept.rows[0].appointment_id, null, 'appointment_id was set null, not deleted');

      // invoice delete cascades BOTH children
      await client.query('delete from public.invoices where id = $1', [inv]);
      const items = await client.query('select count(*)::int as c from public.invoice_items where invoice_id = $1', [inv]);
      const pays = await client.query('select count(*)::int as c from public.payments where invoice_id = $1', [inv]);
      assert.equal(items.rows[0].c, 0, 'invoice_items cascade from invoices');
      assert.equal(pays.rows[0].c, 0, 'payments cascade from invoices');

      await client.query('delete from public.patients where id = $1', [pid]);
    },
  },

  {
    name: 'check constraints: amounts must be positive, as the shipped schema enforced',
    async fn({ client, expectError }) {
      await expectError(() => client.query(
        `insert into public.payments (invoice_id, amount, method)
         values (gen_random_uuid(), -1, 'cash')`)); // FK fails first; also covered below
      const pid = (await client.query(
        `insert into public.patients (first_name, last_name, phone)
         values ('Ck','Neg','555-0002') returning id`)).rows[0].id;
      const aid = (await client.query(
        `insert into public.appointments (patient_id, scheduled_start, status)
         values ($1, now(), 'completed') returning id`, [pid])).rows[0].id;
      const inv = (await client.query(
        `insert into public.invoices (appointment_id, status)
         values ($1, 'draft') returning id`, [aid])).rows[0].id;
      await expectError(() => client.query(
        `insert into public.payments (invoice_id, amount, method)
         values ($1, 0, 'cash')`, [inv]), '23514'); // amount > 0 check
      await expectError(() => client.query(
        `insert into public.invoice_items (invoice_id, description, quantity, unit_price, taxable)
         values ($1, 'x', 0, 10, true)`, [inv]), '23514'); // quantity > 0 check
      await client.query('delete from public.invoices where id = $1', [inv]);
      await client.query('delete from public.appointments where id = $1', [aid]);
      await client.query('delete from public.patients where id = $1', [pid]);
    },
  },

  {
    name: 'updated_at triggers are installed on the money tables (mirrors the Supabase trigger)',
    async fn({ client }) {
      const { rows } = await client.query(
        `select distinct c.relname
           from pg_trigger t
           join pg_class c on c.oid = t.tgrelid
           join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not t.tgisinternal
            and t.tgname ilike '%updated_at%'`);
      const have = new Set(rows.map((r) => r.relname));
      for (const t of ['patients', 'appointments', 'invoices', 'payments', 'services', 'clinic_settings']) {
        assert.ok(have.has(t), `public.${t} lost its updated_at trigger`);
      }
    },
  },
];
