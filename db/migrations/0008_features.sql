-- 0008_features.sql
-- Calendar / expenses / patient management / doctor tag / intake notes.
-- Plain-PostgreSQL translation of the hosted-schema migrations that added
-- them; the row-level policies of those migrations are API rules now
-- (api/lib/authorization.mjs). Every statement is replay-safe.

-- ===== Doctor tag =====
alter table public.user_roles add column if not exists is_doctor boolean not null default false;

create or replace function public.is_doctor(_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and is_doctor = true);
$$;

-- ===== Intake notes on appointments =====
alter table public.appointments add column if not exists intake_notes text;

-- ===== Expenses =====
create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  amount numeric(12,2) not null check (amount > 0),
  category text not null,
  expense_date date not null default current_date,
  reference text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists expenses_expense_date_idx on public.expenses (expense_date);

drop trigger if exists trg_expenses_updated_at on public.expenses;
create trigger trg_expenses_updated_at before update on public.expenses
for each row execute function public.update_updated_at_column();

drop trigger if exists trg_expenses_outbox on public.expenses;
create trigger trg_expenses_outbox after insert or update or delete on public.expenses
for each row execute function public.hh_outbox_notify();

-- ===== Admin user list, now with the doctor tag =====
-- (must_change_password / last_login_at come with 0009; this version is
-- replaced there.)
drop function if exists public.get_users_with_roles();
create function public.get_users_with_roles()
returns table (user_id uuid, email text, created_at text, role text, is_doctor boolean)
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
         coalesce(ur.is_doctor, false)
    from public.app_users au
    left join public.user_roles ur on au.id = ur.user_id
   order by au.created_at desc;
end;
$$;

-- ===== Admin role change (replaces the user's roles with one role + tag) =====
create or replace function public.admin_update_user_role(
  target_user_id uuid,
  new_role public.app_role,
  new_is_doctor boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.has_role(public.current_uid(), 'admin'::public.app_role) then
    raise exception 'Access denied. Admin role required.';
  end if;
  if target_user_id = public.current_uid() and new_role <> 'admin'::public.app_role then
    raise exception 'Access denied. You cannot remove your own admin role.';
  end if;
  delete from public.user_roles where user_id = target_user_id;
  insert into public.user_roles (user_id, role, is_doctor)
  values (target_user_id, new_role, coalesce(new_is_doctor, false));
end;
$$;
