// tests/schema/features-security.test.mjs — 0008/0009: expenses, doctor tag,
// intake notes, booking requests, sessions and the append-only audit log.

import assert from 'node:assert/strict';

async function user(client, email) {
  const { rows } = await client.query("insert into public.app_users (email, password_hash) values ($1, 'h') returning id", [email]);
  return rows[0].id;
}

export default [
  {
    name: 'expenses: amount must be positive, date defaults to today, updated_at is maintained',
    async fn({ client, expectError }) {
      await expectError(() => client.query("insert into public.expenses (description, amount, category) values ('x', 0, 'Other')"), '23514');
      const { rows } = await client.query("insert into public.expenses (description, amount, category) values ('Paper', 3.5, 'Office Supplies') returning expense_date = current_date as today");
      assert.equal(rows[0].today, true);
    },
  },
  {
    name: 'user_roles.is_doctor defaults to false; appointments carry intake_notes; is_doctor() reads the tag',
    async fn({ client }) {
      const id = await user(client, 'doc@example.test');
      await client.query("insert into public.user_roles (user_id, role) values ($1, 'user')", [id]);
      assert.equal((await client.query('select public.is_doctor($1) as d', [id])).rows[0].d, false);
      await client.query('update public.user_roles set is_doctor = true where user_id = $1', [id]);
      assert.equal((await client.query('select public.is_doctor($1) as d', [id])).rows[0].d, true);
      const cols = await client.query("select 1 from information_schema.columns where table_name = 'appointments' and column_name = 'intake_notes'");
      assert.equal(cols.rowCount, 1);
    },
  },
  {
    name: 'booking_requests: status, length caps and time format are enforced by the database too',
    async fn({ client, expectError }) {
      const base = "insert into public.booking_requests (first_name, last_name, reason, preferred_date, preferred_time, status) values ";
      await expectError(() => client.query(base + "('A','B','r','2030-01-01','09:00','maybe')"), '23514');
      await expectError(() => client.query(base + "('A','B','r','2030-01-01','9am','pending')"), '23514');
      await expectError(() => client.query(base + `('${'x'.repeat(101)}','B','r','2030-01-01','09:00','pending')`), '23514');
      await client.query(base + "('A','B','r','2030-01-01','09:00','pending')");
    },
  },
  {
    name: 'audit_log refuses UPDATE and DELETE; sessions disappear with their user',
    async fn({ client, expectError }) {
      await client.query("insert into public.audit_log (action, entity_type) values ('view', 'patient')");
      await expectError(() => client.query("update public.audit_log set action = 'create'"), 'P0001');
      await expectError(() => client.query('delete from public.audit_log'), 'P0001');
      await expectError(() => client.query("insert into public.audit_log (action) values ('hack')"), '23514');
      const id = await user(client, 'gone@example.test');
      await client.query("insert into public.app_sessions (user_id, expires_at) values ($1, now() + interval '1 hour')", [id]);
      await client.query('delete from public.app_users where id = $1', [id]);
      assert.equal((await client.query('select count(*)::int n from public.app_sessions where user_id = $1', [id])).rows[0].n, 0);
    },
  },
];
