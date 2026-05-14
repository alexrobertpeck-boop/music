-- ============================================================================
--  Schema update 005 — vinyl collection + wishlist
--
--  One row per (user, album, status). Reuses the albums catalog so we get
--  cover art + Spotify link for free. status = 'owned' | 'wishlist'.
-- ============================================================================

create table if not exists public.vinyl_records (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  album_id    uuid not null references public.albums(id) on delete cascade,
  status      text not null default 'owned' check (status in ('owned','wishlist')),
  notes       text,                              -- pressing details, condition, where bought, anything
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (user_id, album_id)                     -- one entry per (user, album); status flips in-place
);

create index if not exists vinyl_records_user_status_idx
  on public.vinyl_records (user_id, status);

alter table public.vinyl_records enable row level security;

drop policy if exists "household read vinyl_records" on public.vinyl_records;
drop policy if exists "self write vinyl_records" on public.vinyl_records;

create policy "household read vinyl_records"
  on public.vinyl_records for select
  using (public.is_household_member());

create policy "self write vinyl_records"
  on public.vinyl_records for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
