-- 0002_core_tables.sql
-- Port of the eight core tables from
-- hosted migration 20250811055059,
-- hosted migration 20250811055731 and
-- hosted migration 20250811060241, merged into their
-- final shape, plus the later columns
-- services.show_on_landing (hosted migration 20250811072445)
-- and appointments.customer_type (hosted migration 20250811135226).
-- The encryption-extension dependency and every RLS policy and hosted-schema
-- reference are dropped: gen_random_uuid() is core in PostgreSQL 13+ and role
-- rules live in the API layer.

-- ===== Clinic settings (singleton) =====
create table if not exists public.clinic_settings (
  id uuid primary key default gen_random_uuid(),
  singleton boolean not null default true unique,
  currency_code text not null default 'USD',
  tax_enabled boolean not null default false,
  tax_name text not null default 'VAT',
  tax_rate numeric(5,2) not null default 0.00, -- percent
  default_appointment_duration_minutes integer not null default 30,
  working_hours jsonb not null default jsonb_build_object(
    'mon', jsonb_build_object('start','09:00','end','17:00','enabled',true),
    'tue', jsonb_build_object('start','09:00','end','17:00','enabled',true),
    'wed', jsonb_build_object('start','09:00','end','17:00','enabled',true),
    'thu', jsonb_build_object('start','09:00','end','17:00','enabled',true),
    'fri', jsonb_build_object('start','09:00','end','17:00','enabled',true),
    'sat', jsonb_build_object('enabled',false),
    'sun', jsonb_build_object('enabled',false)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===== Patients =====
create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  date_of_birth date,
  sex text,
  phone text,
  email text,
  address text,
  national_id text,
  drivers_permit text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Unique identifiers when provided
create unique index if not exists patients_national_id_unique on public.patients (national_id) where national_id is not null;
create unique index if not exists patients_drivers_permit_unique on public.patients (drivers_permit) where drivers_permit is not null;

-- ===== Appointments =====
create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz,
  duration_minutes integer,
  status public.appointment_status not null default 'scheduled',
  reason text, -- receptionist brief note / complaint
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- from 20250811135226
  customer_type text not null default 'walk-in'
    check (customer_type in ('walk-in', 'appointment'))
);

-- ===== Visit notes & signature (stored via Storage; keep metadata here) =====
create table if not exists public.visit_notes (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null unique references public.appointments(id) on delete cascade,
  notes text,
  signature_image_path text, -- path in storage bucket 'signatures'
  signed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===== Services Catalog =====
create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  code text,
  name text not null,
  description text,
  price numeric(12,2) not null default 0.00,
  taxable boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- from 20250811072445
  show_on_landing boolean not null default false,
  unique(code)
);

-- ===== Invoices =====
create table if not exists public.invoices (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id) on delete set null,
  currency_code text not null default 'USD',
  tax_enabled boolean not null default true,
  tax_rate numeric(5,2) not null default 0.00, -- percent
  subtotal numeric(12,2) not null default 0.00,
  tax_amount numeric(12,2) not null default 0.00,
  total numeric(12,2) not null default 0.00,
  paid_amount numeric(12,2) not null default 0.00,
  status public.invoice_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ===== Invoice Items =====
create table if not exists public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  service_id uuid references public.services(id),
  description text not null,
  quantity integer not null default 1,
  unit_price numeric(12,2) not null default 0.00,
  line_total numeric(12,2) not null default 0.00,
  taxable boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (quantity > 0),
  check (unit_price >= 0)
);

-- ===== Payments =====
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  method public.payment_method not null default 'cash',
  reference text,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
