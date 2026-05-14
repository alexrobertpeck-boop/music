# Music — orientation for future Claude sessions

A personal music album tracker + recommender Alex built for himself, with a separate "album review club" workflow shared with his dad. Currently in Phase 1 (auth + personal album list). Approved plan lives at `/Users/alexpeck/.claude/plans/i-want-to-start-curried-river.md`.

## About Alex

- Non-developer; learning as we go. Wants explanations of non-obvious decisions, not just code.
- Prefers conversational tone. Short responses. No filler.
- Push back if a request feels off — he asked for it explicitly.
- Workflow: ship small commits → push → he tests in browser → iterates. Quick cycles.
- He doesn't have the Netlify CLI locally — he interacts with Netlify through the web dashboard.
- Prior project at `/Users/alexpeck/Claude_Projects/mlb-dashboard/` (162-0.com) uses the same stack. Lift patterns from there rather than reinventing.

## The load-bearing invariant: two isolated domains

This site has **two separate review tracks** that must not bleed into each other:

1. **Personal** — Alex's solo listening (the 339 backfilled + future). Lives in `personal_ratings`. **This is the only data that feeds his taste profile and recommendations.**
2. **Club** — joint sessions with dad. Lives in `club_sessions` + `club_session_ratings` + `club_notes`. **Never reaches the taste profile.**

`albums` is a shared catalog (just metadata — artist, title, year, Spotify ID). The same album row can be referenced from both domains without contaminating either.

Enforcement points:
- `taste-profile.mjs` queries **only** `personal_ratings` (never the club tables).
- `recommend.mjs` exclusion list is `personal_ratings.album_id` ∪ `club_sessions.album_id` ∪ prior `recommendations.recs[*].album` (he's heard everything in those sets, no point recommending them).
- UI surfaces them under separate tabs — never aggregate club ratings into the "My Albums" summary.

If you find yourself joining `personal_ratings` and `club_session_ratings` for any analytic, **stop and re-read this section.**

## Tech stack

- **Frontend**: single `index.html` (vanilla HTML/CSS/JS, all inline).
- **Hosting**: Netlify. Auto-deploys on `git push` to `main` on GitHub.
- **Functions** (Netlify Functions, ESM `.mjs`, under `netlify/functions/`):
  - `import-csv.mjs` — one-off backfill of the 339 from `Albums.csv` (header-secret gated).
  - `spotify-search.mjs`, `spotify-enrich.mjs`, `spotify-batch-enrich.mjs` — Spotify catalog + audio features.
  - `taste-profile.mjs` — generate/refresh Alex's taste profile (Sonnet).
  - `recommend.mjs` — live recommendation request (Sonnet).
  - `club-research.mjs` (Haiku), `club-questions.mjs` (Sonnet), `club-lyrics.mjs` (Sonnet) — album club helpers.
- **Shared lib**: `netlify/lib/spotify-shared.mjs` — token cache, search, audio-features fetch, album-level aggregation. Same pattern as `mlb-dashboard/netlify/lib/pulse-shared.mjs`.
- **Auth + DB**: Supabase. Email/password + Google OAuth. RLS enforced.
- **AI**: Anthropic Claude. **Claude Sonnet 4.6** (`claude-sonnet-4-6`) for taste / recommend / club questions / lyrics. **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) for club research (cheap, factual). Called from Netlify functions, never from the frontend.
- **External catalog**: Spotify Web API via Client Credentials flow.

## Supabase tables

| Table | Purpose | RLS write |
|---|---|---|
| `household_members` | Allowlist of who can use the app (2 rows: Alex + dad) | n/a (manual via SQL editor) |
| `albums` | Shared catalog: artist, album, year, spotify_album_id, match_status | household |
| `personal_ratings` | **Personal domain.** rating 1-10 + notes, PK (album_id, user_id) | self only |
| `spotify_features` | Audio profile per album + genres + raw track JSON | household |
| `taste_profile` | Claude-generated taste JSON per user | self only |
| `recommendations` | History of rec requests + results (exclusion list source) | self only |
| `club_sessions` | **Club domain.** Album pick + status + research/questions JSON | household |
| `club_session_ratings` | Each user's rating + notes on a club pick | self only |
| `club_notes` | Free-form listen/lyric/discussion notes per session per user | self only |

Helper function: `public.is_household_member()` returns boolean. Used by all household-scoped RLS policies. Defined in `schema.sql`.

## Conventions (lifted from mlb-dashboard, also apply here)

- **Claude key is server-side only.** Functions read `ANTHROPIC_API_KEY` from env. Frontend never sees it.
- **`escapeHtml()` for any user-typed text.** Use defensively even on data we control — notes, artist/album from CSV (the typos), Claude output rendered as HTML.
- **Defense-in-depth user_id filter** on queries against personal/own data. Add `.eq('user_id', user.id)` explicitly even though RLS would enforce it — keeps friend-readable or household-readable rows out of "my data" views.
- **One-off ops**: hit a function URL directly in the browser (e.g. `/.netlify/functions/spotify-batch-enrich?dry=1`). Same pattern as `mlb-dashboard`'s `pulse-cron` / `backfill-odds`.
- **Don't trust `git commit -am` for new files** — `-a` only stages tracked files. Always `git add` new files explicitly.

## Netlify env vars (set in dashboard before deploy)

- `ANTHROPIC_API_KEY` — Claude API key (secret)
- `SUPABASE_URL` — project URL, plain `https://xxx.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — bypasses RLS, **must be marked secret**
- `SPOTIFY_CLIENT_ID` — Spotify dev app client ID
- `SPOTIFY_CLIENT_SECRET` — Spotify dev app secret (**must be marked secret**)
- `IMPORT_TOKEN` — random string, header gate for the one-off CSV import

Frontend uses Supabase URL + public anon key inline in `index.html`. Service role is server-side only.

## Phased build

1. **Phase 1 (current)** — auth + My Albums tab (read/write `personal_ratings`). No Spotify, no Claude.
2. CSV backfill (`import-csv.mjs`).
3. Spotify enrichment + Confirm Matches admin panel.
4. Summary charts (rating histogram, decade breakdown, genres).
5. Recommender (`taste-profile.mjs` then `recommend.mjs`).
6. Album Club tab (sessions workflow, then Claude helpers).

Don't get ahead of phases. Each one is end-to-end usable on its own.
