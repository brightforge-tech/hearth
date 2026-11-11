-- 0009_security.sql
-- Server-side sessions, login throttling, password resets, the append-only
-- audit log and public booking requests. Replay-safe.

-- ===== Account state =====
alter table public.app_users add column if not exists must_change_password boolean not null default false;
alter table public.app_users add column if not exists password_changed_at timestamptz;
alter table public.app_users add column if not exists last_login_at timestamptz;

-- ===== Server-side sessions =====
-- The bearer token carries the session id (sid); the row decides whether it
-- is still alive: idle timeout (last_seen_at), absolute lifetime (expires_at)
-- and revocation (logout, password change, admin reset).
create table if not exists public.app_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text,
  user_agent text
);
create index if not exists app_sessions_user_idx on public.app_sessions (user_id);

-- ===== Login attempts (throttling) =====
create table if not exists public.login_attempts (
  id bigint generated always as identity primary key,
  username text not null,
  ip text,
  success boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists login_attempts_username_idx on public.login_attempts (username, created_at desc);
create index if not exists login_attempts_ip_idx on public.login_attempts (ip, created_at desc);

-- ===== Self-service password reset tokens (stored hashed, single use) =====
create table if not exists public.password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ===== Audit log (append-only) =====
-- Who did what to which record, never the record itself: `summary` holds
-- field NAMES and counts, not values. No API path updates or deletes rows,
-- and the trigger below refuses UPDATE/DELETE for every role that does not
-- explicitly disable it (retention pruning is a deliberate DBA action).
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  actor_email text,
  actor_role text,
  action text not null check (action in ('view','create','update','delete','export','login','login_failed','logout')),
  entity_type text,
  entity_id text,
  ip text,
  summary jsonb
);
create index if not exists audit_log_at_idx on public.audit_log (at desc);
create index if not exists audit_log_entity_idx on public.audit_log (entity_type, entity_id);
create index if not exists audit_log_actor_idx on public.audit_log (actor_id, at desc);

create or replace function public.audit_log_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only';
end;
$$;

drop trigger if exists trg_audit_log_immutable on public.audit_log;
create trigger trg_audit_log_immutable before update or delete on public.audit_log
for each row execute function public.audit_log_immutable();

drop trigger if exists trg_audit_log_no_truncate on public.audit_log;
create trigger trg_audit_log_no_truncate before truncate on public.audit_log
for each statement execute function public.audit_log_immutable();

-- ===== Public booking requests =====
-- The landing page writes here (through POST /api/public/booking-requests),
-- never into patients/appointments. Staff approve or decline.
create table if not exists public.booking_requests (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  first_name text not null check (char_length(first_name) between 1 and 100),
  last_name text not null check (char_length(last_name) between 1 and 100),
  email text check (email is null or char_length(email) <= 254),
  phone text check (phone is null or char_length(phone) <= 40),
  date_of_birth date,
  reason text not null check (char_length(reason) between 1 and 1000),
  preferred_date date not null,
  preferred_time text not null check (preferred_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  source_ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.app_users(id) on delete set null,
  patient_id uuid references public.patients(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  decline_reason text check (decline_reason is null or char_length(decline_reason) <= 1000)
);
create index if not exists booking_requests_status_idx on public.booking_requests (status, created_at desc);
create index if not exists booking_requests_ip_idx on public.booking_requests (source_ip_hash, created_at desc);

drop trigger if exists trg_booking_requests_updated_at on public.booking_requests;
create trigger trg_booking_requests_updated_at before update on public.booking_requests
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_booking_requests_outbox on public.booking_requests;
create trigger trg_booking_requests_outbox after insert or update or delete on public.booking_requests
for each row execute function public.hh_outbox_notify();

-- ===== Admin user list, final shape =====
drop function if exists public.get_users_with_roles();
create function public.get_users_with_roles()
returns table (
  user_id uuid, email text, created_at text, role text, is_doctor boolean,
  must_change_password boolean, last_login_at text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_role(public.current_uid(), 'admin'::public.app_role) then
    raise exception 'Access denied. Admin role required.';
  end if;
  return query
  select au.id, au.email, au.created_at::text,
         coalesce(ur.role::text, 'No role assigned'),
         coalesce(ur.is_doctor, false),
         au.must_change_password,
         au.last_login_at::text
    from public.app_users au
    left join public.user_roles ur on au.id = ur.user_id
   order by au.created_at desc;
end;
$$;
