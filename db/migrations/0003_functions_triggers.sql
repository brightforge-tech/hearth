-- 0003_functions_triggers.sql
-- Port of every trigger function and trigger from
-- hosted migration 20250811055059 /
-- hosted migration 20250811060241, in the final
-- "set search_path = public" shape fixed by
-- hosted migration 20250811060621.

-- ===== Common timestamp trigger =====
create or replace function public.update_updated_at_column()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Set defaults for duration and end time based on settings
create or replace function public.set_appointment_defaults()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  d integer;
begin
  if new.duration_minutes is null then
    select default_appointment_duration_minutes into d from public.clinic_settings limit 1;
    new.duration_minutes := coalesce(d, 30);
  end if;
  if new.scheduled_end is null and new.scheduled_start is not null then
    new.scheduled_end := new.scheduled_start + make_interval(mins => new.duration_minutes);
  end if;
  return new;
end;
$$;

-- Set invoice defaults from clinic settings on insert
create or replace function public.set_invoice_defaults()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  c record;
begin
  select currency_code, tax_enabled, tax_rate into c from public.clinic_settings limit 1;
  if c is not null then
    new.currency_code := coalesce(new.currency_code, c.currency_code);
    new.tax_enabled := coalesce(new.tax_enabled, c.tax_enabled);
    new.tax_rate := coalesce(new.tax_rate, c.tax_rate);
  end if;
  return new;
end;
$$;

-- Compute line total
create or replace function public.set_invoice_item_line_total()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.line_total := round((new.quantity * new.unit_price)::numeric, 2);
  return new;
end;
$$;

-- Recalculate invoice totals
create or replace function public.recalc_invoice_totals(p_invoice_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_subtotal numeric(12,2);
  v_taxable_subtotal numeric(12,2);
  v_tax_rate numeric(5,2);
  v_tax_enabled boolean;
begin
  select coalesce(sum(line_total),0), coalesce(sum(case when taxable then line_total else 0 end),0)
    into v_subtotal, v_taxable_subtotal
  from public.invoice_items where invoice_id = p_invoice_id;

  select tax_rate, tax_enabled into v_tax_rate, v_tax_enabled
  from public.invoices where id = p_invoice_id;

  update public.invoices
  set subtotal = v_subtotal,
      tax_amount = case when v_tax_enabled then round((v_taxable_subtotal * v_tax_rate / 100.0)::numeric, 2) else 0 end,
      total = round((v_subtotal + case when v_tax_enabled then (v_taxable_subtotal * v_tax_rate / 100.0) else 0 end)::numeric, 2),
      updated_at = now()
  where id = p_invoice_id;
end;
$$;

-- Update paid amount and status
create or replace function public.recalc_invoice_payments(p_invoice_id uuid)
returns void
language plpgsql
set search_path = public
as $$
declare
  v_paid numeric(12,2);
  v_total numeric(12,2);
  v_status public.invoice_status;
begin
  select coalesce(sum(amount),0) into v_paid from public.payments where invoice_id = p_invoice_id;
  select total, status into v_total, v_status from public.invoices where id = p_invoice_id;

  update public.invoices
  set paid_amount = round(v_paid, 2),
      status = case when v_paid >= v_total and v_total > 0 then 'paid'::public.invoice_status
                    when v_status = 'paid' and v_paid < v_total then 'issued'::public.invoice_status
                    else v_status end,
      updated_at = now()
  where id = p_invoice_id;
end;
$$;

-- Hooks for totals & payments
create or replace function public.after_invoice_item_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.recalc_invoice_totals(new.invoice_id);
  return null;
end;
$$;

create or replace function public.after_invoice_item_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.recalc_invoice_totals(old.invoice_id);
  return null;
end;
$$;

create or replace function public.after_payment_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.recalc_invoice_payments(new.invoice_id);
  return null;
end;
$$;

create or replace function public.after_payment_delete()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform public.recalc_invoice_payments(old.invoice_id);
  return null;
end;
$$;

-- ===== Triggers =====
-- drop + create keeps this file replay-safe on every PostgreSQL version
-- (CREATE TRIGGER IF NOT EXISTS does not exist; CREATE OR REPLACE TRIGGER is 14+).
drop trigger if exists trg_settings_updated_at on public.clinic_settings;
create trigger trg_settings_updated_at before update on public.clinic_settings
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_patients_updated_at on public.patients;
create trigger trg_patients_updated_at before update on public.patients
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_appointments_defaults on public.appointments;
create trigger trg_appointments_defaults before insert or update on public.appointments
for each row execute function public.set_appointment_defaults();
drop trigger if exists trg_appointments_updated_at on public.appointments;
create trigger trg_appointments_updated_at before update on public.appointments
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_visit_notes_updated_at on public.visit_notes;
create trigger trg_visit_notes_updated_at before update on public.visit_notes
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_services_updated_at on public.services;
create trigger trg_services_updated_at before update on public.services
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_invoices_defaults on public.invoices;
create trigger trg_invoices_defaults before insert on public.invoices
for each row execute function public.set_invoice_defaults();
drop trigger if exists trg_invoices_updated_at on public.invoices;
create trigger trg_invoices_updated_at before update on public.invoices
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_invoice_items_line_total on public.invoice_items;
create trigger trg_invoice_items_line_total before insert or update on public.invoice_items
for each row execute function public.set_invoice_item_line_total();
drop trigger if exists trg_invoice_items_updated_at on public.invoice_items;
create trigger trg_invoice_items_updated_at before update on public.invoice_items
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_invoice_items_after_change on public.invoice_items;
create trigger trg_invoice_items_after_change after insert or update on public.invoice_items
for each row execute function public.after_invoice_item_change();
drop trigger if exists trg_invoice_items_after_delete on public.invoice_items;
create trigger trg_invoice_items_after_delete after delete on public.invoice_items
for each row execute function public.after_invoice_item_delete();

drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at before update on public.payments
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_payments_after_change on public.payments;
create trigger trg_payments_after_change after insert or update on public.payments
for each row execute function public.after_payment_change();
drop trigger if exists trg_payments_after_delete on public.payments;
create trigger trg_payments_after_delete after delete on public.payments
for each row execute function public.after_payment_delete();
