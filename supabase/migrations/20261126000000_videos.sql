-- Videos and timestamp marks: mirrors the Dexie `videos` and `videoMarks` tables in snake_case.
--
-- Both follow the stroke rules: `id` is the client's UUID, client times are bigint epoch ms, `synced_at` is
-- server time, and rows are only ever tombstoned (deleted_at), never deleted or otherwise changed.

-- Tables ---------------------------------------------------------------------

create table public.videos (
  id uuid primary key,
  board_id uuid not null references public.boards (id),
  owner_id uuid not null default auth.uid() references auth.users (id),
  provider text not null check (provider = 'youtube'),
  external_id text not null check (external_id ~ '^[A-Za-z0-9_-]{11}$'),
  title text not null,
  created_at bigint not null,
  deleted_at bigint,
  synced_at timestamptz not null default now()
);

create table public.video_marks (
  id uuid primary key,
  board_id uuid not null references public.boards (id),
  video_id uuid not null references public.videos (id),
  owner_id uuid not null default auth.uid() references auth.users (id),
  t double precision not null check (t >= 0),   -- seconds into the video, to 0.1
  x double precision not null,                  -- world coords: left edge, vertical centre
  y double precision not null,
  created_at bigint not null,
  deleted_at bigint,
  synced_at timestamptz not null default now()
);

-- Pull cursor indexes --------------------------------------------------------

create index videos_owner_synced_idx on public.videos (owner_id, synced_at);
create index video_marks_owner_synced_idx on public.video_marks (owner_id, synced_at);

-- synced_at triggers ---------------------------------------------------------
-- Reuses public.set_synced_at() from the initial schema.

create trigger videos_set_synced_at
  before insert or update on public.videos
  for each row execute function public.set_synced_at();
create trigger video_marks_set_synced_at
  before insert or update on public.video_marks
  for each row execute function public.set_synced_at();

-- Tombstone-only immutability -------------------------------------------------
-- Generic version of enforce_stroke_immutability: the only allowed update is
-- deleted_at from null to a value, with every other client column unchanged.

create function public.enforce_tombstone_immutability() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.deleted_at is not null then
    raise exception '% % is already deleted', tg_table_name, old.id
      using errcode = 'check_violation';
  end if;
  if new.deleted_at is null then
    raise exception '% are immutable; only deleted_at may be set', tg_table_name
      using errcode = 'check_violation';
  end if;
  if (to_jsonb(new) - 'deleted_at' - 'synced_at')
     is distinct from (to_jsonb(old) - 'deleted_at' - 'synced_at') then
    raise exception '% are immutable; only deleted_at may be set', tg_table_name
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger videos_enforce_immutability
  before update on public.videos
  for each row execute function public.enforce_tombstone_immutability();
create trigger video_marks_enforce_immutability
  before update on public.video_marks
  for each row execute function public.enforce_tombstone_immutability();

-- Row Level Security ---------------------------------------------------------
-- Owners may select, insert and update their own rows. No delete policy and no
-- delete grant: rows are only ever tombstoned.

alter table public.videos enable row level security;
alter table public.video_marks enable row level security;

grant select, insert, update on public.videos, public.video_marks to authenticated;

create policy "videos_select_own" on public.videos
  for select to authenticated using (owner_id = auth.uid());
create policy "videos_insert_own" on public.videos
  for insert to authenticated with check (owner_id = auth.uid());
create policy "videos_update_own" on public.videos
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "video_marks_select_own" on public.video_marks
  for select to authenticated using (owner_id = auth.uid());
create policy "video_marks_insert_own" on public.video_marks
  for insert to authenticated with check (owner_id = auth.uid());
create policy "video_marks_update_own" on public.video_marks
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
