-- ============================================================================
--  Music — Personal Album Tracker + Album Club
--  Run this once in the Supabase SQL editor (Project → SQL → New query → Run).
--  Safe to re-run: every CREATE uses IF NOT EXISTS, every policy is dropped
--  first. Won't drop or modify data on a re-run.
-- ============================================================================

-- ─── Extensions ─────────────────────────────────────────────────────────────
create extension if not exists pgcrypto;  -- for gen_random_uuid()

-- ─── household_members ──────────────────────────────────────────────────────
-- Two-person allowlist (Alex + dad). After signing up via the app, copy your
-- user_id from auth.users into this table. Used in RLS to gate shared tables.
create table if not exists public.household_members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at   timestamptz not null default now()
);
alter table public.household_members enable row level security;
drop policy if exists "members can read household" on public.household_members;
create policy "members can read household"
  on public.household_members for select
  using (exists (select 1 from public.household_members hm where hm.user_id = auth.uid()));

-- Helper used by every household-scoped RLS policy.
create or replace function public.is_household_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.household_members where user_id = auth.uid());
$$;

-- ─── albums (shared catalog) ────────────────────────────────────────────────
-- One row per unique album. Carries no review data — that lives in
-- personal_ratings and club_session_ratings independently.
create table if not exists public.albums (
  id                uuid primary key default gen_random_uuid(),
  artist            text not null,
  album             text not null,
  year              int,
  spotify_album_id  text unique,
  match_status      text not null default 'pending'
                    check (match_status in ('pending','confirmed','manual','unmatched')),
  added_by          uuid references auth.users(id),
  created_at        timestamptz not null default now()
);
create unique index if not exists albums_artist_album_lower_idx
  on public.albums (lower(artist), lower(album));

alter table public.albums enable row level security;
drop policy if exists "household read albums"  on public.albums;
drop policy if exists "household write albums" on public.albums;
create policy "household read albums"
  on public.albums for select using (public.is_household_member());
create policy "household write albums"
  on public.albums for all using (public.is_household_member()) with check (public.is_household_member());

-- ─── personal_ratings ───────────────────────────────────────────────────────
-- Alex's solo listening. Drives taste profile + recommendations.
-- Dad can read (so he can browse Alex's collection) but only Alex can write
-- his own rows. Dad could also use this for his own list — both supported.
create table if not exists public.personal_ratings (
  album_id   uuid not null references public.albums(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  rating     int  check (rating between 1 and 10),
  notes      text,
  rated_at   timestamptz not null default now(),
  primary key (album_id, user_id)
);
alter table public.personal_ratings enable row level security;
drop policy if exists "household read personal_ratings" on public.personal_ratings;
drop policy if exists "self write personal_ratings"     on public.personal_ratings;
create policy "household read personal_ratings"
  on public.personal_ratings for select using (public.is_household_member());
create policy "self write personal_ratings"
  on public.personal_ratings for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ─── spotify_features ───────────────────────────────────────────────────────
-- Audio profile per album. Aggregated from track-level audio features.
-- raw jsonb keeps the underlying track array so we can re-aggregate later.
create table if not exists public.spotify_features (
  album_id          uuid primary key references public.albums(id) on delete cascade,
  danceability      numeric,
  energy            numeric,
  valence           numeric,
  acousticness      numeric,
  instrumentalness  numeric,
  tempo             numeric,
  loudness          numeric,
  key               int,
  genres            text[],
  track_count       int,
  raw               jsonb,
  fetched_at        timestamptz not null default now()
);
alter table public.spotify_features enable row level security;
drop policy if exists "household read spotify_features"  on public.spotify_features;
drop policy if exists "household write spotify_features" on public.spotify_features;
create policy "household read spotify_features"
  on public.spotify_features for select using (public.is_household_member());
create policy "household write spotify_features"
  on public.spotify_features for all using (public.is_household_member()) with check (public.is_household_member());

-- ─── taste_profile (per user, Alex-only in practice) ───────────────────────
create table if not exists public.taste_profile (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  profile      jsonb not null,
  model        text,
  n_albums     int,
  generated_at timestamptz not null default now()
);
alter table public.taste_profile enable row level security;
drop policy if exists "self read taste_profile"  on public.taste_profile;
drop policy if exists "self write taste_profile" on public.taste_profile;
create policy "self read taste_profile"
  on public.taste_profile for select using (user_id = auth.uid());
create policy "self write taste_profile"
  on public.taste_profile for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── recommendations ───────────────────────────────────────────────────────
-- History of rec requests. The recs jsonb is an array of
-- { artist, album, year, reasoning_tied_to_user_taste }. Used to build the
-- exclusion list so we don't suggest the same album twice.
create table if not exists public.recommendations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  constraint_text text,
  recs            jsonb not null,
  model           text,
  created_at      timestamptz not null default now()
);
create index if not exists recommendations_user_created_idx
  on public.recommendations (user_id, created_at desc);

alter table public.recommendations enable row level security;
drop policy if exists "self read recommendations"  on public.recommendations;
drop policy if exists "self write recommendations" on public.recommendations;
create policy "self read recommendations"
  on public.recommendations for select using (user_id = auth.uid());
create policy "self write recommendations"
  on public.recommendations for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── club_sessions ─────────────────────────────────────────────────────────
-- One row per album-club pick. Shared between Alex and dad.
create table if not exists public.club_sessions (
  id         uuid primary key default gen_random_uuid(),
  album_id   uuid not null references public.albums(id) on delete cascade,
  status     text not null default 'queued'
              check (status in ('queued','researching','listening','discussing','done')),
  research   jsonb,
  questions  jsonb,
  picked_by  uuid references auth.users(id),
  picked_at  timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.club_sessions enable row level security;
drop policy if exists "household read club_sessions"  on public.club_sessions;
drop policy if exists "household write club_sessions" on public.club_sessions;
create policy "household read club_sessions"
  on public.club_sessions for select using (public.is_household_member());
create policy "household write club_sessions"
  on public.club_sessions for all using (public.is_household_member()) with check (public.is_household_member());

-- ─── club_session_ratings ──────────────────────────────────────────────────
-- Each user (Alex + dad) gives the club album their own rating + notes.
-- Walled off from personal_ratings so club picks never bleed into taste.
create table if not exists public.club_session_ratings (
  session_id uuid not null references public.club_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  rating     int check (rating between 1 and 10),
  notes      text,
  rated_at   timestamptz not null default now(),
  primary key (session_id, user_id)
);
alter table public.club_session_ratings enable row level security;
drop policy if exists "household read club_session_ratings" on public.club_session_ratings;
drop policy if exists "self write club_session_ratings"     on public.club_session_ratings;
create policy "household read club_session_ratings"
  on public.club_session_ratings for select using (public.is_household_member());
create policy "self write club_session_ratings"
  on public.club_session_ratings for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── club_notes ────────────────────────────────────────────────────────────
-- Free-form notes within a session — listen notes, lyric notes, discussion
-- answers. Each note belongs to one user; both can read everyone's.
create table if not exists public.club_notes (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.club_sessions(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  note_type  text not null check (note_type in ('listen','lyric','discussion','research')),
  body       text not null,
  created_at timestamptz not null default now()
);
create index if not exists club_notes_session_idx on public.club_notes (session_id, created_at);

alter table public.club_notes enable row level security;
drop policy if exists "household read club_notes" on public.club_notes;
drop policy if exists "self write club_notes"     on public.club_notes;
create policy "household read club_notes"
  on public.club_notes for select using (public.is_household_member());
create policy "self write club_notes"
  on public.club_notes for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ============================================================================
--  Bootstrap your own household_members row AFTER signing up via the website.
--  Run this once for each member, replacing the placeholders:
--
--    insert into public.household_members (user_id, display_name)
--    values ('00000000-0000-0000-0000-000000000000', 'Alex');
--
--  Find your user_id under: Supabase Dashboard → Authentication → Users.
-- ============================================================================
