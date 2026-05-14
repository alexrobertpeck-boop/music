-- ============================================================================
--  Schema update 001 — provenance for personal_ratings
--  Adds the feedback-loop trail: every rated (or queued-unrated) album knows
--  whether it came from a CSV import, a manual log, or a Claude rec — and
--  for recs, which round/constraint generated it.
--
--  Safe to re-run; uses IF NOT EXISTS guards.
-- ============================================================================

alter table public.personal_ratings
  add column if not exists source text not null default 'manual'
    check (source in ('manual','csv','rec'));

alter table public.personal_ratings
  add column if not exists source_rec_id uuid
    references public.recommendations(id) on delete set null;

alter table public.personal_ratings
  add column if not exists source_constraint text;

-- Backfill the existing rows. Everything you've logged so far came either
-- from the CSV bulk import or from manual add — there's no rec-sourced data
-- yet. Mark all CSV-era rows ('rated_at' before the rec functions shipped)
-- as 'csv'; everything else stays 'manual'. Adjust the cutoff if needed.
update public.personal_ratings
  set source = 'csv'
  where source = 'manual'
    and rated_at < '2026-05-14T08:00:00Z';   -- Phase 2 ship time, approximate
