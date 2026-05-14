-- ============================================================================
--  Schema update 004 — per-track + per-question note keys
--
--  Adds a `subkey` column to club_notes so a single (session, user, type)
--  triple can carry many entries — one per track for music/lyric notes,
--  one per question for discussion answers. Default '' so PostgREST upsert
--  conflict targets work cleanly (NULL is treated as distinct in unique
--  constraints, which would let duplicates slip through).
--
--  Also: tracks cache on club_sessions and cover_url on albums for the UI
--  refresh.
-- ============================================================================

-- Drop the constraint from update 002 (subkey expands the key).
alter table public.club_notes
  drop constraint if exists club_notes_unique_per_user_type;

-- New subkey column with empty-string default + backfill.
alter table public.club_notes
  add column if not exists subkey text not null default '';

-- New unique constraint includes subkey.
alter table public.club_notes
  add constraint club_notes_unique
  unique (session_id, user_id, note_type, subkey);

-- Tracks cache per session (Claude or Spotify-sourced list of track names).
alter table public.club_sessions
  add column if not exists tracks jsonb;

-- Album cover URL (populated by Spotify enrichment once cooldown clears).
alter table public.albums
  add column if not exists cover_url text;
