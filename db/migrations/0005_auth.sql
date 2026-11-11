-- 0005_auth.sql
-- Local identity and role layer: the replacement for the hosted identity schema.
--
--  * app_users replaces the hosted users table (id / email / created_at) and adds
--    the password_hash the API's scrypt hashing writes (task C3/S33: a plain
--    PostgreSQL has no such schema, so it is mapped to a local equivalent).
--  * user_roles is the table of hosted migration 20250811062807
--    with its foreign key pointed at public.app_users instead.
--  * has_role is that same migration's helper, unchanged.
--  * current_uid / current_is_admin replace the hosted uid() helper: the caller's
--    id arrives as the transaction-local GUC "app.uid" that api/db.mjs sets with
--    `set local app.uid = '<uuid>'`, so nothing here trusts a client-supplied id.
--  * get_users_with_roles is the final shape of the function from the
--    2025081220xxxx series (the LEFT JOIN + 'No role assigned' version of
--    hosted migration 20250812202844), reading public.app_users and public.current_uid().
--
-- No RLS policy SQL lives here: role rules are enforced in the API layer
-- (operator decision + S32), which is the only path to this database.
-- Every statement is replay-safe.

-- ===== Local users (replaces the hosted users table) =====
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Sign-in looks a user up by e-mail; the unique constraint above already
-- provides the index, so no extra index is needed.

-- ===== Roles per user (20250811062807, FK re-pointed at app_users) =====
create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.app_users(id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, role)
);

-- ===== Role check (20250811062807), unchanged apart from the schema-qualified cast =====
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  );
$$;

-- ===== Caller identity (replaces the hosted uid() helper) =====
-- Reads the transaction-local "app.uid" GUC the API sets per request. Unset (or
-- empty) means "no caller", which is NULL here and therefore fails every check.
create or replace function public.current_uid()
returns uuid
language sql
stable
set search_path = public
as $$
  select nullif(current_setting('app.uid', true), '')::uuid;
$$;

create or replace function public.current_is_admin()
returns boolean
language sql
stable
set search_path = public
as $$
  select coalesce(public.has_role(public.current_uid(), 'admin'::public.app_role), false);
$$;

-- ===== Admin user list for the AdminSettings users panel =====
-- Final version of the function from 20250812202247 / 20250812202403 /
-- 20250812202518 / 20250812202534 / 20250812202844: it raises for anyone who is
-- not an admin, shows users that have no role yet, and hands the page text
-- columns (created_at and role cast to text) so the UI renders them unchanged.
-- drop + create: create or replace cannot change an existing return signature.
drop function if exists public.get_users_with_roles();

create function public.get_users_with_roles()
returns table (
  user_id uuid,
  email text,
  created_at text,
  role text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Check if the current user is an admin
  if not public.has_role(public.current_uid(), 'admin'::public.app_role) then
    raise exception 'Access denied. Admin role required.';
  end if;

  return query
  select
    au.id as user_id,
    au.email,
    au.created_at::text,
    coalesce(ur.role::text, 'No role assigned') as role
  from public.app_users au
  left join public.user_roles ur on au.id = ur.user_id
  order by au.created_at desc;
end;
$$;
