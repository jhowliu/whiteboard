-- Whiteboard sync schema: mirrors the Dexie model in AGENTS.md in snake_case.
--
-- * `id` is the client's crypto.randomUUID().
-- * Client times (created_at, updated_at, deleted_at) are bigint epoch ms.
-- * `synced_at` is server time, set by a trigger on every insert and update; it
--   is the incremental pull cursor and is independent of the client's times.
-- * Rows are never deleted: erasing sets `deleted_at` (a tombstone).

-- Tables ---------------------------------------------------------------------

create table public.boards (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users (id),
  title text not null,
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  synced_at timestamptz not null default now()
);

create table public.strokes (
  id uuid primary key,
  board_id uuid not null references public.boards (id),
  owner_id uuid not null default auth.uid() references auth.users (id),
  tool text not null check (tool in ('pen', 'highlighter')),
  color text not null,
  size double precision not null,
  points jsonb not null,              -- [[x, y, pressure], ...] in world coords
  min_x double precision not null,
  min_y double precision not null,
  max_x double precision not null,
  max_y double precision not null,
  created_at bigint not null,
  deleted_at bigint,
  synced_at timestamptz not null default now()
);

-- Metadata only; the PDF itself lives in Storage at pdfs/{owner_id}/{id}.pdf.
create table public.pdf_files (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users (id),
  name text not null,
  created_at bigint not null,
  synced_at timestamptz not null default now()
);

create table public.pdf_pages (
  id uuid primary key,
  board_id uuid not null references public.boards (id),
  pdf_id uuid not null references public.pdf_files (id),
  owner_id uuid not null default auth.uid() references auth.users (id),
  page_index integer not null,
  x double precision not null,
  y double precision not null,
  width double precision not null,
  height double precision not null,
  synced_at timestamptz not null default now()
);

-- Pull cursor indexes --------------------------------------------------------

create index boards_owner_synced_idx on public.boards (owner_id, synced_at);
create index strokes_owner_synced_idx on public.strokes (owner_id, synced_at);
create index pdf_files_owner_synced_idx on public.pdf_files (owner_id, synced_at);
create index pdf_pages_owner_synced_idx on public.pdf_pages (owner_id, synced_at);

-- synced_at trigger ----------------------------------------------------------

create function public.set_synced_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.synced_at := now();
  return new;
end
$$;

create trigger boards_set_synced_at
  before insert or update on public.boards
  for each row execute function public.set_synced_at();
create trigger strokes_set_synced_at
  before insert or update on public.strokes
  for each row execute function public.set_synced_at();
create trigger pdf_files_set_synced_at
  before insert or update on public.pdf_files
  for each row execute function public.set_synced_at();
create trigger pdf_pages_set_synced_at
  before insert or update on public.pdf_pages
  for each row execute function public.set_synced_at();

-- Stroke immutability --------------------------------------------------------
-- The only allowed update is the tombstone: deleted_at from null to a value,
-- with every other client column unchanged (synced_at is server-managed).

create function public.enforce_stroke_immutability() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception 'stroke % is already deleted', old.id
      using errcode = 'check_violation';
  end if;
  if new.deleted_at is null then
    raise exception 'strokes are immutable; only deleted_at may be set'
      using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - 'deleted_at' - 'synced_at')
     is distinct from (to_jsonb(old) - 'deleted_at' - 'synced_at') then
    raise exception 'strokes are immutable; only deleted_at may be set'
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger strokes_enforce_immutability
  before update on public.strokes
  for each row execute function public.enforce_stroke_immutability();

-- Row Level Security ---------------------------------------------------------
-- Owners may select, insert and update their own rows. No delete policy and no
-- delete grant: rows are only ever tombstoned.

alter table public.boards enable row level security;
alter table public.strokes enable row level security;
alter table public.pdf_files enable row level security;
alter table public.pdf_pages enable row level security;

grant select, insert, update on public.boards, public.strokes, public.pdf_files, public.pdf_pages
  to authenticated;

create policy "boards_select_own" on public.boards
  for select to authenticated using (owner_id = auth.uid());
create policy "boards_insert_own" on public.boards
  for insert to authenticated with check (owner_id = auth.uid());
create policy "boards_update_own" on public.boards
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "strokes_select_own" on public.strokes
  for select to authenticated using (owner_id = auth.uid());
create policy "strokes_insert_own" on public.strokes
  for insert to authenticated with check (owner_id = auth.uid());
create policy "strokes_update_own" on public.strokes
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "pdf_files_select_own" on public.pdf_files
  for select to authenticated using (owner_id = auth.uid());
create policy "pdf_files_insert_own" on public.pdf_files
  for insert to authenticated with check (owner_id = auth.uid());
create policy "pdf_files_update_own" on public.pdf_files
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "pdf_pages_select_own" on public.pdf_pages
  for select to authenticated using (owner_id = auth.uid());
create policy "pdf_pages_insert_own" on public.pdf_pages
  for insert to authenticated with check (owner_id = auth.uid());
create policy "pdf_pages_update_own" on public.pdf_pages
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Storage --------------------------------------------------------------------
-- Private bucket; each user may only read and write under `{auth.uid()}/`.

insert into storage.buckets (id, name, public)
values ('pdfs', 'pdfs', false)
on conflict (id) do nothing;

create policy "pdfs_select_own_folder" on storage.objects
  for select to authenticated
  using (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "pdfs_insert_own_folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'pdfs' and (storage.foldername(name))[1] = auth.uid()::text);
