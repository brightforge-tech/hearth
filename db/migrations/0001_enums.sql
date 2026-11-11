-- 0001_enums.sql
-- Port of the enums from hosted migration 20250811055059
-- and hosted migration 20250811062807.
-- No encryption extension is needed: gen_random_uuid() is core in PostgreSQL 13+.
-- Wrapped in DO blocks so the file is replay-safe (CREATE TYPE has no IF NOT EXISTS).

do $$ begin
  create type public.appointment_status as enum (
    'scheduled','waiting','in_progress','completed','canceled','no_show'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.invoice_status as enum (
    'draft','issued','paid','void'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.payment_method as enum (
    'cash','card','transfer','other'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.app_role as enum ('admin','moderator','user');
exception when duplicate_object then null;
end $$;
