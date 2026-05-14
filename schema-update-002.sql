-- ============================================================================
--  Schema update 002 — one club_notes row per (session, user, note_type)
--  Enables clean upserts of listen / discussion / lyric notes from the UI
--  without manually deleting prior rows. Safe to run on an empty table; if
--  the table already has duplicate (session_id, user_id, note_type) rows,
--  Postgres will reject the constraint — clean those up first.
-- ============================================================================

alter table public.club_notes
  add constraint club_notes_unique_per_user_type
  unique (session_id, user_id, note_type);
