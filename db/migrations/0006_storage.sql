-- 0006_storage.sql
-- Local object-storage metadata: the replacement for the hosted storage schema.
--
-- Visit.tsx uploads the signature PNG to the 'signatures' bucket and the export
-- endpoints write CSVs to 'exports' (see the bucket inserts of the core
-- migration 20250811055059). A plain PostgreSQL has no storage metadata tables,
-- so the two hosted tables are mapped to local equivalents here: one row per
-- bucket in storage_buckets and one row per object in storage_objects. The bytes
-- themselves live on disk under UPLOAD_DIR/<bucket>/<name> (api/lib/uploads.mjs);
-- these rows are the index the API checks before serving a file.
--
-- owner is intentionally a plain uuid with no foreign key: a signature file must
-- outlive the staff account that uploaded it, and the cutover (scripts/cutover.mjs)
-- imports storage rows in the same pass as the clinic data.
-- Every statement is replay-safe.

-- ===== Buckets =====
create table if not exists public.storage_buckets (
  id text primary key,
  "public" boolean not null default false,
  created_at timestamptz not null default now()
);

-- ===== Objects =====
create table if not exists public.storage_objects (
  id uuid primary key default gen_random_uuid(),
  bucket text not null references public.storage_buckets(id) on delete cascade,
  name text not null,
  owner uuid,
  mime text,
  bytes bigint,
  sha256 text,
  created_at timestamptz not null default now(),
  unique (bucket, name)
);

-- Listing and serving always start from the bucket, so keep one index handy.
create index if not exists storage_objects_bucket_created_idx
  on public.storage_objects (bucket, created_at);

-- ===== The two buckets the app uses (from the core migration) =====
insert into public.storage_buckets (id, "public") values ('signatures', false)
on conflict (id) do nothing;
insert into public.storage_buckets (id, "public") values ('exports', false)
on conflict (id) do nothing;
