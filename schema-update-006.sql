-- ============================================================================
--  Schema update 006 — multi-user expansion
--
--  Opens Reckoner to arbitrary signed-up users while keeping Album Club gated
--  to the household. Adds the onboarding quiz table and source='onboarding'.
--
--  Changes RLS on shared catalog + personal data:
--    - albums / spotify_features: any authenticated user can read; albums
--      can be inserted by any auth user (so onboarding + rec-add can resolve
--      new catalog rows). spotify_features inserts/updates remain service-
--      role only (RLS-bound clients can't write).
--    - personal_ratings / vinyl_records: read scope tightens from
--      household-wide to self-only. Existing self-write policies unchanged.
--    - taste_profile / recommendations: already self-only — untouched.
--    - club_* + household_members: untouched. Album Club stays gated.
-- ============================================================================

-- ─── 1. personal_ratings.source: add 'onboarding' ───────────────────────────
alter table public.personal_ratings drop constraint if exists personal_ratings_source_check;
alter table public.personal_ratings add constraint personal_ratings_source_check
  check (source in ('manual','csv','rec','onboarding'));

-- ─── 2. onboarding_quizzes ─────────────────────────────────────────────────
-- One row per user. intro_answers is { genres:[], eras:[], anchor_artist:'' }.
-- generated_albums caches the 25-album Claude payload so refresh-the-page
-- doesn't re-spend tokens. completed_at flips when the user clears the 15
-- minimum.
create table if not exists public.onboarding_quizzes (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  intro_answers    jsonb,
  generated_albums jsonb,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz
);
alter table public.onboarding_quizzes enable row level security;

drop policy if exists "self read onboarding_quizzes"  on public.onboarding_quizzes;
drop policy if exists "self write onboarding_quizzes" on public.onboarding_quizzes;
create policy "self read onboarding_quizzes"
  on public.onboarding_quizzes for select using (user_id = auth.uid());
create policy "self write onboarding_quizzes"
  on public.onboarding_quizzes for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ─── 3. albums: relax to any-authenticated read + insert ───────────────────
-- UPDATE/DELETE stays unavailable to RLS-bound clients (no policy = blocked).
-- Service role bypasses RLS so enrichment functions still work.
drop policy if exists "household read albums"  on public.albums;
drop policy if exists "household write albums" on public.albums;
drop policy if exists "auth read albums"       on public.albums;
drop policy if exists "auth insert albums"     on public.albums;
create policy "auth read albums"
  on public.albums for select using (auth.uid() is not null);
create policy "auth insert albums"
  on public.albums for insert with check (auth.uid() is not null);

-- ─── 4. spotify_features: any-auth read; writes service-role only ──────────
drop policy if exists "household read spotify_features"  on public.spotify_features;
drop policy if exists "household write spotify_features" on public.spotify_features;
drop policy if exists "auth read spotify_features"       on public.spotify_features;
create policy "auth read spotify_features"
  on public.spotify_features for select using (auth.uid() is not null);

-- ─── 5. personal_ratings: read tightens to self ────────────────────────────
drop policy if exists "household read personal_ratings" on public.personal_ratings;
drop policy if exists "self read personal_ratings"      on public.personal_ratings;
create policy "self read personal_ratings"
  on public.personal_ratings for select using (user_id = auth.uid());
-- 'self write personal_ratings' policy already exists; unchanged.

-- ─── 6. vinyl_records: read tightens to self ───────────────────────────────
drop policy if exists "household read vinyl_records" on public.vinyl_records;
drop policy if exists "self read vinyl_records"      on public.vinyl_records;
create policy "self read vinyl_records"
  on public.vinyl_records for select using (user_id = auth.uid());
-- 'self write vinyl_records' already exists; unchanged.
