-- 0007_outbox.sql
-- Change feed: the replacement for the hosted logical-replication feed.
--
-- Queue.tsx, Billing.tsx and AdminSettings.tsx subscribe to postgres_changes on
-- appointments, invoices, payments, clinic_settings, services, patients and
-- user_roles. A plain PostgreSQL has no such feed, so every write to those
-- tables appends a small row to public.hh_outbox, and api/routes/realtime.mjs
-- drains it (ordered by id, optionally scoped by table and an id filter) into
-- the SSE stream the browser shim consumes.
--
-- The payload is the affected row as jsonb — the changed record and nothing
-- else, which is all the pages need (their handlers simply refetch) — and the
-- DELETE row carries the row as it was immediately before the delete.
-- Every statement is replay-safe.

-- ===== The queue itself =====
-- "generated always as identity" keeps ids gap-free enough for a cursor: the SSE
-- route remembers the last id it delivered per client. Inserting an explicit id
-- is rejected on purpose, so ids are always monotonic in commit order.
create table if not exists public.hh_outbox (
  id bigint generated always as identity primary key,
  table_name text not null,
  action text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  record_id uuid,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- The streamer filters by table and walks forward by id.
create index if not exists hh_outbox_table_id_idx on public.hh_outbox (table_name, id);

-- ===== The shared row trigger =====
-- One function serves every table: TG_TABLE_NAME / TG_OP give the first three
-- columns, and every fed table has a uuid "id" for record_id. AFTER (not before)
-- so the row is already visible to the reader, and RETURN NULL because an AFTER
-- trigger must not rewrite the row.
create or replace function public.hh_outbox_notify()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  insert into public.hh_outbox (table_name, action, record_id, payload)
  values (
    tg_table_name,
    tg_op,
    (case when tg_op = 'DELETE' then old.id else new.id end),
    row_to_json(case when tg_op = 'DELETE' then old else new end)::jsonb
  );
  return null;
end;
$$;

-- ===== Triggers on the eight fed tables =====
-- drop + create keeps this file replay-safe on every supported server
-- (CREATE OR REPLACE TRIGGER is 14+, CREATE TRIGGER IF NOT EXISTS is 9.x-only).
drop trigger if exists trg_appointments_outbox on public.appointments;
create trigger trg_appointments_outbox after insert or update or delete on public.appointments
for each row execute function public.hh_outbox_notify();

drop trigger if exists trg_services_outbox on public.services;
create trigger trg_services_outbox after insert or update or delete on public.services
for each row execute function public.hh_outbox_notify();

drop trigger if exists trg_invoices_outbox on public.invoices;
create trigger trg_invoices_outbox after insert or update or delete on public.invoices
for each row execute function public.hh_outbox_notify();

drop trigger if exists trg_payments_outbox on public.payments;
create trigger trg_payments_outbox after insert or update or delete on public.payments
for each row execute function public.hh_outbox_notify();

drop trigger if exists trg_clinic_settings_outbox on public.clinic_settings;
create trigger trg_clinic_settings_outbox after insert or update or delete on public.clinic_settings
for each row execute function public.hh_outbox_notify();

drop trigger if exists trg_patients_outbox on public.patients;
create trigger trg_patients_outbox after insert or update or delete on public.patients
for each row execute function public.hh_outbox_notify();

drop trigger if exists trg_visit_notes_outbox on public.visit_notes;
create trigger trg_visit_notes_outbox after insert or update or delete on public.visit_notes
for each row execute function public.hh_outbox_notify();

drop trigger if exists trg_user_roles_outbox on public.user_roles;
create trigger trg_user_roles_outbox after insert or update or delete on public.user_roles
for each row execute function public.hh_outbox_notify();
