-- Test-only stand-in for what a hosted Supabase project already provides.
-- Loaded before the migrations by supabase/tests/schema.test.ts on PGlite.
-- Never apply this to a real Supabase database.

create role authenticated nologin;

-- auth -----------------------------------------------------------------------

create schema auth;
grant usage on schema auth to authenticated;

create table auth.users (
  id uuid primary key
);

-- Same contract as Supabase's auth.uid(): the JWT `sub` claim, or null.
create function auth.uid() returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

-- storage --------------------------------------------------------------------

create schema storage;
grant usage on schema storage to authenticated;

create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false
);

create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz default now()
);

-- Supabase ships storage.objects with RLS on and table grants for the API roles.
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;
grant select on storage.buckets to authenticated;

-- Folder segments of an object path, without the file name ('a/b/c.pdf' -> {a,b}).
create function storage.foldername(name text) returns text[]
language plpgsql immutable
as $$
declare
  _parts text[];
begin
  _parts := string_to_array(name, '/');
  return _parts[1:array_length(_parts, 1) - 1];
end
$$;
