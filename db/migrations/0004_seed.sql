-- 0004_seed.sql
-- Port of the seeds from hosted migration 20250811055059
-- and hosted migration 20250811060241 (clinic_settings singleton
-- and the five sample services) together with the effect of
-- hosted migration 20250811072445 (all active services show
-- on the landing page). Idempotent: safe to replay.

insert into public.clinic_settings (singleton, currency_code, tax_enabled, tax_name, tax_rate, default_appointment_duration_minutes)
values (true, 'USD', false, 'VAT', 0.00, 30)
on conflict (singleton) do nothing;

insert into public.services (code, name, description, price, taxable) values
  ('CONSULT_INIT','Initial Consultation','First-time consultation', 250.00, true),
  ('CONSULT_FU','Follow-up Visit','Follow-up consultation', 150.00, true),
  ('LAB_BLOOD','Blood Test','Basic blood work', 120.00, true),
  ('IMG_XRAY','X-Ray','Standard X-Ray imaging', 350.00, true),
  ('PROC_INJ','Injection','Injection administration', 75.00, true)
on conflict (code) do nothing;

-- 20250811072445: existing active services show on the landing page
update public.services
set show_on_landing = true
where active = true;
